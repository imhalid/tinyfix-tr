"""Build high-signal training examples for Context Model v2 from cleaned Wikipedia + conversational subtitles.

Unlike v1 (which included trivial non-words like "sadecede"), every example here is a *genuinely contested*
ambiguity where BOTH readings are attested in the lexicon (matching `Corrector.contestedSpans`):
  - marks:  "oldu" / "öldü", "uç" / "üç", "yüz" / "yuz", "köy" / "koy" (50% with ASCII-stripped context)
  - de_da:  "bende" / "ben de", "evde" / "ev de", "sonrada" / "sonra da" (50% separate, 50% joined)
  - ki:     "evdeki" / "evde ki", "bugünkü" / "bugün ki", "oysaki" / "oysa ki" (50% separate, 50% joined)
  - mi:     "sevgimi" / "sevgi mi", "ayrımı" / "ayrı mı", "sonucumu" / "sonucu mu" (50% separate, 50% joined)

Strictly excludes held-out Wikipedia documents (`is_heldout(doc_id, 50)`) and held-out subtitle lines
(`index % 50 == 0`, source of `bench/conversation/clean.jsonl`).

Writes data/work/context/{train,valid}.npz with:
  left [N, LEFT] uint8, right [N, RIGHT] uint8, candidates [N, MAX_CANDIDATES, SPAN] uint8,
  features [N, MAX_CANDIDATES, FEATURE_DIM] float32, count [N] uint8, label [N] uint8,
  kind [N] uint8, ascii_ctx [N] uint8
"""

import argparse
import hashlib
import math
import random
import re
import shlex
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import clean_text, lower_tr  # noqa: E402

LEFT, RIGHT, SPAN, MAX_CANDIDATES, FEATURE_DIM = 80, 40, 24, 4, 18
LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
WORD = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)?")
FOLD = str.maketrans("çğıöşüâîû", "cgiosuaiu")
ASCII_STRIP = str.maketrans("çğıöşüÇĞİÖŞÜâîûÂÎÛ", "cgiosuCGIOSUaiuAIU")
QUESTION = re.compile(r"^m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae]|yd[iıuü]|yken)?$")
KINDS = ["marks", "de_da", "ki", "mi"]
BACK_VOWELS = set("aıouâû")
FRONT_VOWELS = set("eiöüî")
ROUND_VOWELS = set("ouöüû")
MARKS_SET = set("çğıöşüÇĞİÖŞÜ")
VOICELESS = set("fstkçşhp")

# Character vocabulary shared with the browser code (src/context.ts). 0 is padding, 1 is anything else.
ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyzâîûqwxABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZÂÎÛQWX0 .,;:!?'\"()-"
CHAR_ID = {char: index + 2 for index, char in enumerate(ALPHABET)}


def encode(text: str, length: int, align_right: bool) -> np.ndarray:
    text = text.replace("’", "'")
    text = re.sub(r"\d", "0", text)
    ids = [CHAR_ID.get(char, 1) for char in text]
    ids = ids[-length:] if align_right else ids[:length]
    out = np.zeros(length, dtype=np.uint8)
    if align_right:
        out[length - len(ids) :] = ids
    else:
        out[: len(ids)] = ids
    return out


def upper_tr(ch: str) -> str:
    if ch == "i":
        return "İ"
    if ch == "ı":
        return "I"
    return ch.upper()


def keep_case(typed: str, replacement: str) -> str:
    if typed and typed[0].isupper() and not typed.isupper():
        return upper_tr(replacement[0]) + replacement[1:]
    return replacement


def is_heldout(doc_id: str, every: int = 50) -> bool:
    return int(hashlib.md5(doc_id.encode()).hexdigest(), 16) % every == 0


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


def load_counts(unigrams_path: Path, bigrams_path: Path) -> tuple[dict[str, int], dict[str, int]]:
    unigrams: dict[str, int] = {}
    for line in open(unigrams_path):
        word, count, _ = line.rstrip("\n").split("\t")
        unigrams[word] = int(count)
    bigrams: dict[str, int] = {}
    for line in open(bigrams_path):
        pair, count = line.rstrip("\n").rsplit("\t", 1)
        bigrams[pair] = int(count)
    return unigrams, bigrams


def mark_groups(counts: dict[str, int], min_count: int) -> dict[str, list[str]]:
    """Words that only differ in Turkish marks, most common first: 'oldu' -> ['oldu', 'öldü']."""
    groups = defaultdict(list)
    for word, count in counts.items():
        if count >= min_count and "'" not in word and len(word) >= 2:
            groups[word.translate(FOLD)].append(word)
    return {
        fold: sorted(words, key=lambda w: -counts[w])[:MAX_CANDIDATES]
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
    """Returns (span_count, min_word_count) matching src/context.ts."""
    low = lower_tr(span)
    parts = low.split(" ")
    if len(parts) == 1:
        c = unigrams.get(parts[0], 0)
        return c, c
    pair_c = bigrams.get(low, 0)
    min_w = min(unigrams.get(p, 0) for p in parts)
    return pair_c, min_w


def build_features(
    cands: list[str],
    kind_idx: int,
    ascii_ctx: int,
    unigrams: dict[str, int],
    bigrams: dict[str, int],
    morph_bits: dict[str, int],
) -> np.ndarray:
    """Computes [MAX_CANDIDATES, FEATURE_DIM] float32 features identical to src/context.ts."""
    feats = np.zeros((MAX_CANDIDATES, FEATURE_DIM), dtype=np.float32)
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


def examples_for_paragraph(
    text: str,
    unigrams: dict[str, int],
    groups: dict[str, list[str]],
    rng: random.Random,
    want: dict[str, int],
    key_counts: Counter,
    max_per_key: int,
    min_count: int,
):
    """Yields (bucket_key, kind, start, end, candidates_true_first, group_key) for genuinely contested spans."""
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

        # 1. Separate particle after a word ("ben de", "evde ki", "sevgi mi"): ONLY when glued form is attested!
        if joined_to_previous and raw.islower():
            p_start, _, p_raw = previous
            p_low = lower_tr(p_raw)
            p_at_start = (index - 1) == 0 or text[words[index - 2][1] : p_start].strip() in (".", "!", "?", ":", "\n")
            if "'" not in p_low and not p_raw.isupper() and (p_raw.islower() or p_at_start):
                span = text[p_start:end]
                if low in ("de", "da") and want["de_da_sep"] > 0:
                    # Also handle voiceless assimilation ("kitap da" vs "kitapta") if that glued form exists.
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

        # 2. Glued form that could be two real words ("evde" / "ev de", "evdeki" / "evde ki", "sevgimi" / "sevgi mi").
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

        # 3. Real words that differ only in Turkish marks ("oldu" / "öldü", "uç" / "üç").
        if want["marks"] > 0:
            fold = low.translate(FOLD)
            group = groups.get(fold)
            if group and low in group:
                gkey = f"marks:{fold}"
                if key_counts[gkey] < max_per_key and rng.random() < 0.35:
                    alts = [keep_case(raw, w) for w in group if w != low]
                    if alts:
                        yield "marks", "marks", start, end, [raw] + alts, gkey


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="data/raw/trwiki")
    parser.add_argument("--subtitles", default="data/raw/opensubs/tr.part.txt")
    parser.add_argument("--unigrams", default="data/work/unigrams_conv.tsv")
    parser.add_argument("--bigrams", default="data/work/bigrams.tsv")
    parser.add_argument("--out", default="data/work/context")
    parser.add_argument("--marks", type=int, default=160_000)
    parser.add_argument("--de-da", type=int, default=140_000)
    parser.add_argument("--ki", type=int, default=50_000)
    parser.add_argument("--mi", type=int, default=50_000)
    parser.add_argument("--sub-share", type=float, default=0.25, help="fraction of examples from OpenSubtitles")
    parser.add_argument("--valid-share", type=float, default=0.025)
    parser.add_argument("--min-group-count", type=int, default=5)
    parser.add_argument("--max-per-key", type=int, default=4000)
    parser.add_argument("--ascii-aug", type=float, default=0.5, help="fraction of marks examples with ASCII-stripped context")
    parser.add_argument("--morph-cmd", default="node scripts/extract-morph-features.ts")
    parser.add_argument("--seed", type=int, default=2)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    unigrams, bigrams = load_counts(Path(args.unigrams), Path(args.bigrams))
    groups = mark_groups(unigrams, args.min_group_count)
    print(f"{len(unigrams):,} unigrams, {len(bigrams):,} bigrams, {len(groups):,} mark groups", flush=True)

    def make_want(scale: float) -> dict[str, int]:
        return {
            "marks": int(args.marks * scale),
            "de_da_sep": int(args.de_da * scale * 0.5),
            "de_da_join": int(args.de_da * scale * 0.5),
            "ki_sep": int(args.ki * scale * 0.5),
            "ki_join": int(args.ki * scale * 0.5),
            "mi_sep": int(args.mi * scale * 0.5),
            "mi_join": int(args.mi * scale * 0.5),
        }

    rows: dict[str, list] = {"train": [], "valid": []}
    key_counts: Counter = Counter()

    def collect_paragraph(paragraph: str, split: str, want: dict[str, int], max_per_key: int):
        if len(paragraph) < 25:
            return
        per_para: Counter = Counter()
        for bucket, kind, start, end, candidates, gkey in examples_for_paragraph(
            paragraph, unigrams, groups, rng, want, key_counts, max_per_key, args.min_group_count
        ):
            if end - start > SPAN or want[bucket] <= 0 or per_para[kind] >= 2:
                continue
            candidates = list(dict.fromkeys(candidates))[:MAX_CANDIDATES]
            if len(candidates) < 2:
                continue
            order_c = list(range(len(candidates)))
            rng.shuffle(order_c)
            shuffled = [candidates[i] for i in order_c]
            label = order_c.index(0)
            left = paragraph[max(0, start - LEFT) : start]
            right = paragraph[end : end + RIGHT]
            ascii_ctx = 0
            if kind == "marks" and rng.random() < args.ascii_aug:
                left = left.translate(ASCII_STRIP)
                right = right.translate(ASCII_STRIP)
                ascii_ctx = 1
            rows[split].append((KINDS.index(kind), ascii_ctx, left, right, shuffled, label))
            per_para[kind] += 1
            if split == "train":
                want[bucket] -= 1
                key_counts[gkey] += 1

    # 1. Wikipedia (cleaned, skipping held-out test documents)
    wiki_want = make_want(1.0 - args.sub_share)
    paths = sorted(Path(args.raw).glob("*.parquet"))
    docs = 0
    for path in paths:
        if all(v <= 0 for v in wiki_want.values()):
            break
        table = pq.read_table(path, columns=["id", "text"])
        order = list(range(table.num_rows))
        rng.shuffle(order)
        ids, texts = table.column("id").to_pylist(), table.column("text").to_pylist()
        for row in order:
            if all(v <= 0 for v in wiki_want.values()):
                break
            doc_id, text = ids[row], texts[row]
            if is_heldout(doc_id, 50):
                continue
            docs += 1
            split = "valid" if int(hashlib.md5(("ctx2" + doc_id).encode()).hexdigest(), 16) % 1000 < args.valid_share * 1000 else "train"
            for paragraph in clean_text(text).split("\n"):
                collect_paragraph(paragraph, split, wiki_want, args.max_per_key)
            if docs % 25000 == 0:
                print(f"wiki {docs} docs, remaining: {wiki_want}", flush=True)
    print(f"wiki done ({docs} docs), remaining: {wiki_want}", flush=True)

    # 2. Conversational subtitles (strictly skipping index % 50 == 0 held-out lines)
    sub_path = Path(args.subtitles)
    if args.sub_share > 0 and sub_path.is_file():
        sub_want = make_want(args.sub_share)
        # Also carry over any unmet Wikipedia quota (e.g. mi_sep is much richer in dialogue!).
        for k, rem in wiki_want.items():
            sub_want[k] += rem
        sub_lines = 0
        with open(sub_path, errors="replace") as f:
            for idx, raw_line in enumerate(f):
                if all(v <= 0 for v in sub_want.values()):
                    break
                line = raw_line.strip().lstrip("-# ").strip()
                if not line:
                    continue
                if idx % 50 == 0:
                    continue  # held-out slice for bench/conversation/clean.jsonl
                sub_lines += 1
                split = "valid" if int(hashlib.md5(f"sub2:{idx}".encode()).hexdigest(), 16) % 1000 < args.valid_share * 1000 else "train"
                collect_paragraph(line, split, sub_want, args.max_per_key + 1500)
                if sub_lines % 2_000_000 == 0:
                    print(f"subs {sub_lines:,} lines, remaining: {sub_want}", flush=True)
        print(f"subs done ({sub_lines:,} lines), remaining: {sub_want}", flush=True)

    # Collect unique candidate head words for morphology feature extraction
    unique_heads: set[str] = set()
    for split_rows in rows.values():
        for _, _, _, _, cs, _ in split_rows:
            for c in cs:
                unique_heads.add(lower_tr(c).split(" ", 1)[0])
    print(f"extracting morphology features for {len(unique_heads):,} unique candidate head words...", flush=True)
    morph_bits = extract_morph_bits(sorted(unique_heads), args.morph_cmd)
    print(f"morphology matched {len(morph_bits):,}/{len(unique_heads):,} head words", flush=True)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for split, items in rows.items():
        rng.shuffle(items)
        n = len(items)
        left = np.zeros((n, LEFT), np.uint8)
        right = np.zeros((n, RIGHT), np.uint8)
        cands = np.zeros((n, MAX_CANDIDATES, SPAN), np.uint8)
        features = np.zeros((n, MAX_CANDIDATES, FEATURE_DIM), np.float32)
        count = np.zeros(n, np.uint8)
        label = np.zeros(n, np.uint8)
        kind = np.zeros(n, np.uint8)
        ascii_arr = np.zeros(n, np.uint8)
        for i, (k, ac, l, r, cs, y) in enumerate(items):
            left[i] = encode(l, LEFT, align_right=True)
            right[i] = encode(r, RIGHT, align_right=False)
            for j, c in enumerate(cs):
                cands[i, j] = encode(c, SPAN, align_right=False)
            features[i] = build_features(cs, k, ac, unigrams, bigrams, morph_bits)
            count[i], label[i], kind[i], ascii_arr[i] = len(cs), y, k, ac
        np.savez_compressed(
            out / f"{split}.npz",
            left=left,
            right=right,
            candidates=cands,
            features=features,
            count=count,
            label=label,
            kind=kind,
            ascii_ctx=ascii_arr,
        )
        print(
            split,
            n,
            {name: int((kind == i).sum()) for i, name in enumerate(KINDS)},
            f"ascii_marks={int(((kind == 0) & (ascii_arr == 1)).sum())}",
            flush=True,
        )
    (out / "alphabet.txt").write_text(ALPHABET)


if __name__ == "__main__":
    main()
