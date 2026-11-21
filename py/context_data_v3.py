"""Build Stage 2 high-signal multi-task training data for Context Model v3 (Subword Transformer).

Covers all 5 ambiguity classes using strictly non-heldout Wikipedia (`trwiki`, skipping
`is_heldout(doc_id, 50)`) and OpenSubtitles (`opensubs/tr.part.txt`, skipping `idx % 50 == 0`):
  0. marks  : contested Turkish-mark pairs ("oldu"/"öldü", "uç"/"üç", "koy"/"köy", 50% ASCII ctx)
  1. de_da  : contested de/da split vs join ("bende"/"ben de", "içinde"/"için de", "yapıda"/"yapı da")
  2. ki     : contested ki split vs join ("evdeki"/"evde ki", "bugünkü"/"bugün ki")
  3. mi     : contested mi split vs join ("sevgimi"/"sevgi mi", "sonucumu"/"sonucu mu", direct & indirect)
  4. typo   : realistic human typos (omission, adjacent-key, transposition, vowel-swap, double-omission)
              scored with EXACT browser Corrector candidate lists + 26-dim features via
              `node scripts/extract-typo-candidates.ts`, including hard wrong-pick, ambiguous,
              below-threshold rescue, easy multi-cand, and clean OOV / 2-edit negative examples.

Writes `data/work/context_v3/{train,valid}.npz` with:
  left       [N, 24]     uint16   (right-aligned subword ids)
  right      [N, 20]     uint16   (left-aligned subword ids)
  candidates [N, 8, 8]   uint16   (left-aligned subword ids per candidate)
  features   [N, 8, 26]  float32  (bit-identical to src/context.ts:buildContextFeatures)
  count      [N]         uint8    (number of active candidates, 2..8)
  label      [N]         uint8    (gold candidate index)
  kind       [N]         uint8    (0=marks, 1=de_da, 2=ki, 3=mi, 4=typo)
  ascii_ctx  [N]         uint8    (0 or 1)
  subtype    [N]         uint8    (fine-grained bucket for validation reporting)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import shlex
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import clean_text, is_heldout, lower_tr  # noqa: E402
from build_tokenizer import SubwordTokenizer, upper_tr  # noqa: E402
from context_arch import FEATURE_DIM, KINDS, LEFT_SUB, RIGHT_SUB, SPAN_SUB  # noqa: E402

MAX_CANDIDATES = 8
LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
WORD = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)?")
FOLD = str.maketrans("çğıöşüâîû", "cgiosuaiu")
ASCII_STRIP = str.maketrans("çğıöşüÇĞİÖŞÜâîûÂÎÛ", "cgiosuCGIOSUaiuAIU")
QUESTION = re.compile(r"^m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae]|yd[iıuü]|yken)?$")
BACK_VOWELS = set("aıouâû")
FRONT_VOWELS = set("eiöüî")
ROUND_VOWELS = set("ouöüû")
VOWELS = "aeıioöuü"
VOWELS_SET = set(VOWELS)
MARKS_SET = set("çğıöşüÇĞİÖŞÜ")
VOICELESS = set("fstkçşhp")

KEYBOARD_ROWS = ["qwertyuıopğü", "asdfghjklşi", "zxcvbnmöç"]
NEAR_KEYS: dict[str, list[str]] = {}
for _r, _row in enumerate(KEYBOARD_ROWS):
    for _c, _ch in enumerate(_row):
        _near = []
        for _dr, _dc in ((0, -1), (0, 1), (-1, 0), (-1, 1), (1, 0), (1, -1)):
            _rr, _cc = _r + _dr, _c + _dc
            if 0 <= _rr < len(KEYBOARD_ROWS) and 0 <= _cc < len(KEYBOARD_ROWS[_rr]):
                _near.append(KEYBOARD_ROWS[_rr][_cc])
        NEAR_KEYS[_ch] = _near

SUBTYPE_NAMES = [
    "other",
    "typo_hard_wrong",
    "typo_hard_ambig",
    "typo_below_multi",
    "typo_below_single",
    "typo_easy_multi",
    "neg_miss",
    "neg_oov",
]
SUBTYPE_ID = {name: i for i, name in enumerate(SUBTYPE_NAMES)}


def keep_case(typed: str, replacement: str) -> str:
    if typed and typed[0].isupper() and not typed.isupper():
        return upper_tr(replacement[0]) + replacement[1:]
    return replacement


def last_vowel(word: str) -> str | None:
    for ch in reversed(word):
        if ch in BACK_VOWELS or ch in FRONT_VOWELS:
            return ch
    return None


def follows_harmony_2(stem: str, vowel: str) -> bool:
    lv = last_vowel(stem)
    if not lv:
        return True
    return (lv in BACK_VOWELS) == (vowel == "a")


def follows_mi_harmony(stem: str, particle: str) -> bool:
    lv = last_vowel(stem)
    if not lv:
        return True
    back = lv in BACK_VOWELS
    rnd = lv in ROUND_VOWELS
    want = ("u" if rnd else "ı") if back else ("ü" if rnd else "i")
    high = [c for c in particle if c in "ıiuü"]
    return bool(high) and high[0] == want and all(c == high[0] for c in high)


def load_counts(unigrams_path: Path, bigrams_path: Path) -> tuple[dict[str, int], dict[str, float], dict[str, int]]:
    unigrams: dict[str, int] = {}
    cap_share: dict[str, float] = {}
    with open(unigrams_path, encoding="utf-8") as f:
        for line in f:
            word, count_s, cap_s = line.rstrip("\n").split("\t")
            c = int(count_s)
            unigrams[word] = c
            cap_share[word] = int(cap_s) / c if c > 0 else 0.0
    bigrams: dict[str, int] = {}
    with open(bigrams_path, encoding="utf-8") as f:
        for line in f:
            pair, count_s = line.rstrip("\n").rsplit("\t", 1)
            bigrams[pair] = int(count_s)
    return unigrams, cap_share, bigrams


def mark_groups(counts: dict[str, int], min_count: int) -> dict[str, list[str]]:
    groups = defaultdict(list)
    for word, count in counts.items():
        if count >= min_count and "'" not in word and len(word) >= 2:
            groups[word.translate(FOLD)].append(word)
    return {
        fold: sorted(words, key=lambda w: -counts[w])[:4]
        for fold, words in groups.items()
        if len(words) > 1
    }


def extract_morph_bits(words: list[str], cmd: str) -> dict[str, int]:
    if not words:
        return {}
    proc = subprocess.run(
        shlex.split(cmd),
        input="\n".join(words) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    bits: dict[str, int] = {}
    for line in proc.stdout.splitlines():
        if "\t" not in line:
            continue
        w, b = line.split("\t", 1)
        bits[w] = int(b)
    return bits


def candidate_count(span: str, unigrams: dict[str, int], bigrams: dict[str, int]) -> tuple[int, int]:
    low = lower_tr(span)
    parts = low.split(" ")
    if len(parts) == 1:
        c = unigrams.get(parts[0], 0)
        return c, c
    pair_c = bigrams.get(low, 0)
    min_w = min(unigrams.get(p, 0) for p in parts)
    return pair_c, min_w


def build_features_non_typo(
    cands: list[str],
    kind_idx: int,
    ascii_ctx: int,
    unigrams: dict[str, int],
    bigrams: dict[str, int],
    morph_bits: dict[str, int],
) -> np.ndarray:
    """Computes [len(cands), 26] float32 features identical to src/context.ts:buildContextFeatures."""
    feats = np.zeros((len(cands), FEATURE_DIM), dtype=np.float32)
    log_counts = []
    min_logs = []
    for c in cands:
        sc, mc = candidate_count(c, unigrams, bigrams)
        log_counts.append(math.log(sc + 1.0))
        min_logs.append(math.log(mc + 1.0))
    max_lc = max(log_counts) if log_counts else 0.0
    for j, c in enumerate(cands):
        lc = log_counts[j]
        mlc = min_logs[j]
        low = lower_tr(c)
        head = low.split(" ", 1)[0]
        bits = morph_bits.get(head, 0)
        feats[j, 0] = lc / 15.0
        feats[j, 1] = (lc - max_lc) / 10.0
        feats[j, 2] = mlc / 15.0
        feats[j, 3] = 1.0 if " " in c else 0.0
        feats[j, 4] = 1.0 if any(ch in MARKS_SET for ch in c) else 0.0
        feats[j, 5] = float(ascii_ctx)
        feats[j, 6 + kind_idx] = 1.0
        for b in range(8):
            feats[j, 10 + b] = float((bits >> b) & 1)
    return feats


def corrupt_word(low: str, rng: random.Random) -> str | None:
    """Apply a realistic human typing error covering omissions, extra keys, adj-key, transpositions, vowel swaps."""
    n = len(low)
    if n < 3:
        return None
    r = rng.random()
    # 44% single-letter omission (biased toward interior & vowels, like fast typing)
    if r < 0.44:
        if n < 5:
            return None
        vowel_pos = [i for i in range(1, n) if low[i] in VOWELS_SET]
        if vowel_pos and rng.random() < 0.60:
            i = rng.choice(vowel_pos)
        else:
            i = rng.randrange(0 if rng.random() < 0.12 else 1, n)
        out = low[:i] + low[i + 1 :]
        return out if len(out) >= 4 else None
    # 18% extra-key insertion (duplicate key, adjacent keyboard neighbor, or stray letter -> trains edit_is_delete!)
    if r < 0.62:
        i = rng.randrange(1, n + 1)
        sub_r = rng.random()
        if sub_r < 0.45:
            # Duplicate previous letter ("vaka" -> "vakaa", "geldi" -> "gelddi")
            ch = low[i - 1]
        elif sub_r < 0.85:
            # Keyboard neighbor of adjacent char ("her" -> "hber", "olur" -> "oluyr")
            ref = low[min(i, n - 1)] if rng.random() < 0.5 else low[i - 1]
            near = NEAR_KEYS.get(ref)
            if not near:
                return None
            ch = rng.choice(near)
        else:
            # General extra letter ("adı" -> "adık", "aldı" -> "ağldı")
            ch = rng.choice("abcçdefgğhıijklmnoöprsştuüvyz")
        out = low[:i] + ch + low[i:]
        return out if len(out) >= 4 else None
    # 14% adjacent-key substitution (Turkish Q neighbors)
    if r < 0.76:
        if n < 4:
            return None
        cands = [i for i in range(n) if low[i] in NEAR_KEYS and NEAR_KEYS[low[i]]]
        if not cands:
            return None
        i = rng.choice(cands)
        ch = rng.choice(NEAR_KEYS[low[i]])
        return low[:i] + ch + low[i + 1 :]
    # 11% adjacent transposition
    if r < 0.87:
        if n < 4:
            return None
        i = rng.randrange(0, n - 1)
        if low[i] == low[i + 1]:
            return None
        return low[:i] + low[i + 1] + low[i] + low[i + 2 :]
    # 9% vowel swap
    if r < 0.96:
        if n < 4:
            return None
        vpos = [i for i in range(n) if low[i] in VOWELS_SET]
        if not vpos:
            return None
        i = rng.choice(vpos)
        other_v = [v for v in VOWELS if v != low[i]]
        return low[:i] + rng.choice(other_v) + low[i + 1 :]
    # 4% double omission (produces both double-vowel-drop positives and 2-edit negative misses!)
    if n >= 6:
        pos1 = rng.randrange(1, n - 1)
        s1 = low[:pos1] + low[pos1 + 1 :]
        pos2 = rng.randrange(1, len(s1))
        out = s1[:pos2] + s1[pos2 + 1 :]
        return out if len(out) >= 4 else None
    return None


def non_typo_examples_for_paragraph(
    text: str,
    unigrams: dict[str, int],
    groups: dict[str, list[str]],
    rng: random.Random,
    want: dict[str, int],
    key_counts: Counter,
    max_per_key: int,
    min_count: int,
):
    words = [(m.start(), m.end(), m.group()) for m in WORD.finditer(text)]
    for index, (start, end, raw) in enumerate(words):
        if raw.isupper() or len(raw) < 2:
            continue
        low = lower_tr(raw)
        if "'" in low:
            continue
        at_start = index == 0 or text[words[index - 1][1] : start].strip() in (".", "!", "?", ":", "\n")
        is_cap = raw[0].isupper()
        if is_cap and not at_start:
            continue

        previous = words[index - 1] if index > 0 else None
        joined_to_previous = previous is not None and text[previous[1] : start] == " "

        # 1. Separate particle after a word ("ben de", "evde ki", "sevgi mi")
        if joined_to_previous and raw.islower():
            p_start, _, p_raw = previous
            p_low = lower_tr(p_raw)
            p_at_start = (index - 1) == 0 or text[words[index - 2][1] : p_start].strip() in (".", "!", "?", ":", "\n")
            if "'" not in p_low and not p_raw.isupper() and (p_raw.islower() or p_at_start):
                span = text[p_start:end]
                if low in ("de", "da") and want["de_da_sep"] > 0:
                    glued_d = p_low + low
                    glued_t = (p_low + ("te" if low == "de" else "ta")) if p_low and p_low[-1] in VOICELESS else ""
                    glued_low = glued_d if unigrams.get(glued_d, 0) >= min_count else (glued_t if glued_t and unigrams.get(glued_t, 0) >= min_count else "")
                    if glued_low and unigrams.get(p_low, 0) >= min_count:
                        gkey = f"deda:{glued_low}"
                        if key_counts[gkey] < max_per_key:
                            yield "de_da_sep", "de_da", p_start, end, [span, keep_case(p_raw, glued_low)], gkey
                elif low == "ki" and want["ki_sep"] > 0:
                    glued_low = p_low + "ki"
                    if unigrams.get(glued_low, 0) >= min_count and unigrams.get(p_low, 0) >= min_count:
                        gkey = f"ki:{glued_low}"
                        if key_counts[gkey] < max_per_key:
                            yield "ki_sep", "ki", p_start, end, [span, keep_case(p_raw, glued_low)], gkey
                elif QUESTION.match(low) and want["mi_sep"] > 0:
                    glued_low = p_low + low
                    if unigrams.get(glued_low, 0) >= min_count and unigrams.get(p_low, 0) >= min_count:
                        gkey = f"mi:{glued_low}"
                        if key_counts[gkey] < max_per_key:
                            yield "mi_sep", "mi", p_start, end, [span, keep_case(p_raw, glued_low)], gkey

        # 2. Glued form that could be two real words
        if unigrams.get(low, 0) >= min_count:
            if len(low) >= 4 and low.endswith(("de", "da")) and want["de_da_join"] > 0:
                stem_low = low[:-2]
                if unigrams.get(stem_low, 0) >= min_count and follows_harmony_2(stem_low, low[-1]):
                    gkey = f"deda:{low}"
                    if key_counts[gkey] < max_per_key:
                        yield "de_da_join", "de_da", start, end, [raw, f"{raw[:-2]} {raw[-2:]}"], gkey
            elif len(low) >= 4 and low.endswith(("te", "ta")) and want["de_da_join"] > 0:
                stem_low = low[:-2]
                de_conj = "de" if low.endswith("te") else "da"
                if stem_low and stem_low[-1] in VOICELESS and unigrams.get(stem_low, 0) >= min_count and follows_harmony_2(stem_low, low[-1]):
                    gkey = f"deda:{low}"
                    if key_counts[gkey] < max_per_key:
                        yield "de_da_join", "de_da", start, end, [raw, f"{raw[:-2]} {de_conj}"], gkey
            if len(low) >= 4 and low.endswith("ki") and want["ki_join"] > 0:
                stem_low = low[:-2]
                if unigrams.get(stem_low, 0) >= min_count:
                    gkey = f"ki:{low}"
                    if key_counts[gkey] < max_per_key:
                        yield "ki_join", "ki", start, end, [raw, f"{raw[:-2]} {raw[-2:]}"], gkey
            if len(low) >= 4 and low.endswith(("mi", "mı", "mu", "mü")) and want["mi_join"] > 0:
                stem_low = low[:-2]
                if unigrams.get(stem_low, 0) >= min_count and follows_mi_harmony(stem_low, low[-2:]):
                    gkey = f"mi:{low}"
                    if key_counts[gkey] < max_per_key:
                        yield "mi_join", "mi", start, end, [raw, f"{raw[:-2]} {raw[-2:]}"], gkey

        # 3. Contested mark groups
        if want["marks"] > 0:
            fold = low.translate(FOLD)
            group = groups.get(fold)
            if group and low in group:
                gkey = f"marks:{fold}"
                if key_counts[gkey] < max_per_key and rng.random() < 0.35:
                    alts = [keep_case(raw, w) for w in group if w != low]
                    if alts:
                        yield "marks", "marks", start, end, [raw] + alts, gkey


def collect_typo_probes_from_paragraph(
    text: str,
    unigrams: dict[str, int],
    cap_share: dict[str, float],
    rng: random.Random,
    want_typo: bool,
    want_oov: bool,
):
    """Yields (mode, start, end, typed, gold, at_start, text_has_marks, q_ahead, prev_w, next_w)."""
    words = [(m.start(), m.end(), m.group()) for m in WORD.finditer(text)]
    if len(words) < 3:
        return
    text_has_marks = any(ch in MARKS_SET for ch in text)
    q_ahead = "?" in text
    emitted_typo = 0
    emitted_oov = 0
    order = list(range(len(words)))
    rng.shuffle(order)
    for idx in order:
        start, end, raw = words[idx]
        if raw.isupper() or len(raw) < 3 or "'" in raw:
            continue
        low = lower_tr(raw)
        if raw[1:] != low[1:]:
            continue
        at_start = idx == 0 or text[words[idx - 1][1] : start].strip() in (".", "!", "?", ":", "\n")
        if raw[0].isupper() and not at_start:
            continue
        prev_w = lower_tr(words[idx - 1][2]) if idx > 0 and text[words[idx - 1][1] : start] == " " else ""
        next_w = lower_tr(words[idx + 1][2]) if idx + 1 < len(words) and text[end : words[idx + 1][0]] == " " else ""
        cnt = unigrams.get(low, 0)

        if want_oov and emitted_oov < 1 and raw == low and len(raw) >= 4 and cnt < 3:
            yield ("oov_clean", start, end, raw, raw, at_start, text_has_marks, q_ahead, prev_w, next_w)
            emitted_oov += 1
        elif want_typo and emitted_typo < 2 and cnt >= 4 and cap_share.get(low, 0.0) < 0.45:
            # Try up to 2 corruptions to get a valid typo string
            for _ in range(2):
                cor = corrupt_word(low, rng)
                if cor and cor != low and unigrams.get(cor, 0) < 40:
                    typed_cor = keep_case(raw, cor)
                    yield ("typo", start, end, typed_cor, raw, at_start, text_has_marks, q_ahead, prev_w, next_w)
                    emitted_typo += 1
                    break
        if emitted_typo >= 2 and (not want_oov or emitted_oov >= 1):
            break


def pack_sub_arr(ids: list[int], length: int, align_right: bool) -> np.ndarray:
    out = np.zeros(length, dtype=np.uint16)
    if not ids:
        return out
    trimmed = ids[-length:] if align_right else ids[:length]
    if align_right:
        out[length - len(trimmed) :] = trimmed
    else:
        out[: len(trimmed)] = trimmed
    return out


def run_node_typo_extractor(probes: list[tuple], batch_cmd: str = "node scripts/extract-typo-candidates.ts") -> list[dict]:
    """Send typo probes to the exact Node Corrector worker and collect extracted candidate lists + features."""
    if not probes:
        return []
    lines = []
    for pid, p in enumerate(probes):
        _, _, mode, _, _, typed, gold, at_s, marks, q_a, pw, nw, _, _ = p
        lines.append(f"{pid}\t{mode}\t{typed}\t{gold}\t{int(at_s)}\t{int(marks)}\t{int(q_a)}\t{pw}\t{nw}")
    proc = subprocess.run(
        shlex.split(batch_cmd),
        input="\n".join(lines) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    results = []
    for line in proc.stdout.splitlines():
        if line:
            results.append(json.loads(line))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocab", default="data/work/context_v3/vocab.txt")
    parser.add_argument("--raw", default="data/raw/trwiki")
    parser.add_argument("--subtitles", default="data/raw/opensubs/tr.part.txt")
    parser.add_argument("--unigrams", default="data/work/unigrams_conv.tsv")
    parser.add_argument("--bigrams", default="data/work/bigrams.tsv")
    parser.add_argument("--out", default="data/work/context_v3")
    parser.add_argument("--marks", type=int, default=95_000)
    parser.add_argument("--de-da", type=int, default=95_000)
    parser.add_argument("--ki", type=int, default=35_000)
    parser.add_argument("--mi", type=int, default=35_000)
    parser.add_argument("--typo", type=int, default=200_000)
    parser.add_argument("--valid-share", type=float, default=0.025)
    parser.add_argument("--min-group-count", type=int, default=5)
    parser.add_argument("--max-per-key", type=int, default=3500)
    parser.add_argument("--ascii-aug", type=float, default=0.5)
    parser.add_argument("--morph-cmd", default="node scripts/extract-morph-features.ts")
    parser.add_argument("--seed", type=int, default=3)
    args = parser.parse_args()

    t0 = time.time()
    rng = random.Random(args.seed)
    tok = SubwordTokenizer.load(args.vocab)
    unigrams, cap_share, bigrams = load_counts(Path(args.unigrams), Path(args.bigrams))
    groups = mark_groups(unigrams, args.min_group_count)
    print(f"Loaded {len(unigrams):,} unigrams, {len(bigrams):,} bigrams, {len(groups):,} mark groups ({time.time()-t0:.1f}s)", flush=True)

    # Non-typo quotas split Wiki vs OpenSubtitles
    def make_nt_want(wiki: bool) -> dict[str, int]:
        w_m, w_d, w_k, w_q = (0.65, 0.55, 0.55, 0.45) if wiki else (0.35, 0.45, 0.45, 0.55)
        return {
            "marks": int(args.marks * w_m),
            "de_da_join": int(args.de_da * w_d * 0.58),
            "de_da_sep": int(args.de_da * w_d * 0.42),
            "ki_join": int(args.ki * w_k * 0.55),
            "ki_sep": int(args.ki * w_k * 0.45),
            "mi_join": int(args.mi * w_q * 0.55),
            "mi_sep": int(args.mi * w_q * 0.45),
        }

    # Typo sub-bucket quotas (total = args.typo)
    scale_t = args.typo / 200_000.0
    def make_typo_want(share: float) -> dict[str, int]:
        return {
            "typo_hard_wrong": int(45_000 * scale_t * share),
            "typo_hard_ambig": int(40_000 * scale_t * share),
            "typo_below_multi": int(15_000 * scale_t * share),
            "typo_below_single": int(20_000 * scale_t * share),
            "typo_easy_multi": int(55_000 * scale_t * share),
            "neg_miss": int(15_000 * scale_t * share),
            "neg_oov": int(10_000 * scale_t * share),
        }

    # Storage:
    # non_typo_rows[split]: (kind_idx, ascii_ctx, left_str, right_str, candidates, label)
    # typo_rows[split]:     (subtype_id, ascii_ctx, left_str, right_str, candidates, label, features_np)
    non_typo_rows: dict[str, list] = {"train": [], "valid": []}
    typo_rows: dict[str, list] = {"train": [], "valid": []}
    key_counts: Counter = Counter()

    def collect_non_typo(paragraph: str, split: str, want: dict[str, int], max_per_key: int):
        if len(paragraph) < 25:
            return
        per_para: Counter = Counter()
        for bucket, kind, start, end, candidates, gkey in non_typo_examples_for_paragraph(
            paragraph, unigrams, groups, rng, want, key_counts, max_per_key, args.min_group_count
        ):
            if want[bucket] <= 0 or per_para[kind] >= 2:
                continue
            candidates = list(dict.fromkeys(candidates))[:4]
            if len(candidates) < 2:
                continue
            order_c = list(range(len(candidates)))
            rng.shuffle(order_c)
            shuffled = [candidates[i] for i in order_c]
            label = order_c.index(0)
            left = paragraph[max(0, start - 180) : start]
            right = paragraph[end : end + 150]
            ascii_ctx = 0
            if kind == "marks" and rng.random() < args.ascii_aug:
                left = left.translate(ASCII_STRIP)
                right = right.translate(ASCII_STRIP)
                ascii_ctx = 1
            non_typo_rows[split].append((KINDS.index(kind), ascii_ctx, left, right, shuffled, label))
            per_para[kind] += 1
            if split == "train":
                want[bucket] -= 1
                key_counts[gkey] += 1

    def flush_typo_probes(probes: list[tuple], typo_want: dict[str, int], typo_key_counts: Counter):
        if not probes:
            return
        extracted = run_node_typo_extractor(probes)
        for item in extracted:
            pid = item["id"]
            bucket = item["bucket"]
            if bucket not in typo_want:
                continue
            split, _, _, _, _, typed, gold, _, marks, _, _, _, left, right = probes[pid]
            if split == "train" and typo_want[bucket] <= 0:
                continue
            gkey = f"typo:{lower_tr(gold)}:{bucket}"
            if split == "train" and typo_key_counts[gkey] >= 80:
                continue
            cands = item["candidates"][:MAX_CANDIDATES]
            feats = np.asarray(item["features"][:MAX_CANDIDATES], dtype=np.float32)
            label = int(item["label"])
            if label >= len(cands) or len(cands) < 2:
                continue
            order_c = list(range(len(cands)))
            rng.shuffle(order_c)
            cands_s = [cands[i] for i in order_c]
            feats_s = feats[order_c]
            label_s = order_c.index(label)
            ascii_ctx = 0 if marks else 1
            typo_rows[split].append((SUBTYPE_ID[bucket], ascii_ctx, left, right, cands_s, label_s, feats_s))
            if split == "train":
                typo_want[bucket] -= 1
                typo_key_counts[gkey] += 1
        probes.clear()

    # 1. Wikipedia pass (40% of typo + wiki share of non-typo)
    wiki_nt = make_nt_want(wiki=True)
    wiki_tp = make_typo_want(0.40)
    typo_key_counts: Counter = Counter()
    probe_buf: list[tuple] = []
    docs = 0
    for path in sorted(Path(args.raw).glob("*.parquet")):
        if all(v <= 0 for v in wiki_nt.values()) and all(v <= 0 for v in wiki_tp.values()):
            break
        table = pq.read_table(path, columns=["id", "text"])
        order = list(range(table.num_rows))
        rng.shuffle(order)
        ids = table.column("id").to_pylist()
        texts = table.column("text").to_pylist()
        for row in order:
            if all(v <= 0 for v in wiki_nt.values()) and all(v <= 0 for v in wiki_tp.values()):
                break
            doc_id, text = ids[row], texts[row]
            if is_heldout(doc_id, 50):
                continue
            docs += 1
            split = "valid" if int(hashlib.md5(("ctx3" + doc_id).encode()).hexdigest(), 16) % 1000 < args.valid_share * 1000 else "train"
            need_nt = any(v > 0 for v in wiki_nt.values())
            need_tp = any(v > 0 for k, v in wiki_tp.items() if k != "neg_oov")
            need_oov = wiki_tp["neg_oov"] > 0
            for paragraph in clean_text(text).split("\n"):
                if len(paragraph) < 25:
                    continue
                if need_nt:
                    collect_non_typo(paragraph, split, wiki_nt, args.max_per_key)
                if need_tp or need_oov:
                    for pr in collect_typo_probes_from_paragraph(paragraph, unigrams, cap_share, rng, need_tp, need_oov):
                        mode, s, e, typed, gold, at_s, marks, q_a, pw, nw = pr
                        left = paragraph[max(0, s - 180) : s]
                        right = paragraph[e : e + 150]
                        probe_buf.append((split, 0, mode, s, e, typed, gold, at_s, marks, q_a, pw, nw, left, right))
            if len(probe_buf) >= 25_000:
                flush_typo_probes(probe_buf, wiki_tp, typo_key_counts)
            if docs % 20_000 == 0:
                print(f"wiki {docs:,} docs ({time.time()-t0:.0f}s) | nt_rem={wiki_nt} | tp_rem={wiki_tp}", flush=True)
    flush_typo_probes(probe_buf, wiki_tp, typo_key_counts)
    print(f"Wiki done ({docs:,} docs, {time.time()-t0:.0f}s) | nt_rem={wiki_nt} | tp_rem={wiki_tp}", flush=True)

    # 2. OpenSubtitles pass (60% of typo + subs share of non-typo + any wiki carryover)
    sub_nt = make_nt_want(wiki=False)
    for k, rem in wiki_nt.items():
        sub_nt[k] += max(0, rem)
    sub_tp = make_typo_want(0.60)
    for k, rem in wiki_tp.items():
        sub_tp[k] += max(0, rem)

    sub_lines = 0
    with open(args.subtitles, encoding="utf-8", errors="replace") as f:
        for idx, raw_line in enumerate(f):
            if all(v <= 0 for v in sub_nt.values()) and all(v <= 0 for v in sub_tp.values()):
                break
            if idx % 50 == 0:
                continue  # held-out slice for bench/conversation/clean.jsonl
            line = raw_line.strip().lstrip("-# ").strip()
            if len(line) < 20:
                continue
            sub_lines += 1
            split = "valid" if int(hashlib.md5(f"sub3:{idx}".encode()).hexdigest(), 16) % 1000 < args.valid_share * 1000 else "train"
            need_nt = any(v > 0 for v in sub_nt.values())
            need_tp = any(v > 0 for k, v in sub_tp.items() if k != "neg_oov")
            need_oov = sub_tp["neg_oov"] > 0
            if need_nt:
                collect_non_typo(line, split, sub_nt, args.max_per_key + 1500)
            if need_tp or need_oov:
                for pr in collect_typo_probes_from_paragraph(line, unigrams, cap_share, rng, need_tp, need_oov):
                    mode, s, e, typed, gold, at_s, marks, q_a, pw, nw = pr
                    left = line[max(0, s - 180) : s]
                    right = line[e : e + 150]
                    probe_buf.append((split, 1, mode, s, e, typed, gold, at_s, marks, q_a, pw, nw, left, right))
            if len(probe_buf) >= 35_000:
                flush_typo_probes(probe_buf, sub_tp, typo_key_counts)
            if sub_lines % 1_000_000 == 0:
                print(f"subs {sub_lines:,} lines ({time.time()-t0:.0f}s) | nt_rem={sub_nt} | tp_rem={sub_tp}", flush=True)
    flush_typo_probes(probe_buf, sub_tp, typo_key_counts)
    print(f"Subs done ({sub_lines:,} lines, {time.time()-t0:.0f}s) | nt_rem={sub_nt} | tp_rem={sub_tp}", flush=True)

    # Extract morphology bits for non-typo candidate heads
    unique_heads: set[str] = set()
    for split_rows in non_typo_rows.values():
        for _, _, _, _, cs, _ in split_rows:
            for c in cs:
                unique_heads.add(lower_tr(c).split(" ", 1)[0])
    print(f"Extracting morphology bits for {len(unique_heads):,} unique non-typo heads...", flush=True)
    morph_bits = extract_morph_bits(sorted(unique_heads), args.morph_cmd)

    # Encode and save train/valid NPZ
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for split in ("train", "valid"):
        # Cap valid set to keep eval snappy (~15k max stratified)
        nt_items = non_typo_rows[split]
        tp_items = typo_rows[split]
        if split == "valid" and len(tp_items) > 8000:
            rng.shuffle(tp_items)
            tp_items = tp_items[:8000]
        if split == "valid" and len(nt_items) > 10000:
            rng.shuffle(nt_items)
            nt_items = nt_items[:10000]

        combined = []
        for k_idx, ac, l_s, r_s, cs, y in nt_items:
            feats = build_features_non_typo(cs, k_idx, ac, unigrams, bigrams, morph_bits)
            combined.append((k_idx, 0, ac, l_s, r_s, cs, y, feats))
        for st_id, ac, l_s, r_s, cs, y, feats in tp_items:
            combined.append((KINDS.index("typo"), st_id, ac, l_s, r_s, cs, y, feats))

        rng.shuffle(combined)
        n = len(combined)
        left_a = np.zeros((n, LEFT_SUB), np.uint16)
        right_a = np.zeros((n, RIGHT_SUB), np.uint16)
        cands_a = np.zeros((n, MAX_CANDIDATES, SPAN_SUB), np.uint16)
        feats_a = np.zeros((n, MAX_CANDIDATES, FEATURE_DIM), np.float32)
        count_a = np.zeros(n, np.uint8)
        label_a = np.zeros(n, np.uint8)
        kind_a = np.zeros(n, np.uint8)
        ascii_a = np.zeros(n, np.uint8)
        subtype_a = np.zeros(n, np.uint8)

        for i, (k_idx, st_id, ac, l_s, r_s, cs, y, feats) in enumerate(combined):
            left_a[i] = pack_sub_arr(tok.encode(l_s), LEFT_SUB, align_right=True)
            right_a[i] = pack_sub_arr(tok.encode(r_s), RIGHT_SUB, align_right=False)
            for j, c in enumerate(cs):
                cands_a[i, j] = pack_sub_arr(tok.encode(c), SPAN_SUB, align_right=False)
            feats_a[i, : len(cs)] = feats
            count_a[i] = len(cs)
            label_a[i] = y
            kind_a[i] = k_idx
            ascii_a[i] = ac
            subtype_a[i] = st_id

        np.savez_compressed(
            out / f"{split}.npz",
            left=left_a,
            right=right_a,
            candidates=cands_a,
            features=feats_a,
            count=count_a,
            label=label_a,
            kind=kind_a,
            ascii_ctx=ascii_a,
            subtype=subtype_a,
        )
        kind_summary = {name: int((kind_a == i).sum()) for i, name in enumerate(KINDS)}
        st_summary = {SUBTYPE_NAMES[s]: int((subtype_a == s).sum()) for s in range(1, len(SUBTYPE_NAMES))}
        print(f"Saved {split}.npz: n={n:,} kinds={kind_summary} typo_subtypes={st_summary}", flush=True)

    print(f"All Stage 2 data generated in {(time.time()-t0)/60:.1f} min!", flush=True)


if __name__ == "__main__":
    main()
