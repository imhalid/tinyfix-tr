"""Build a compact 8,192-token Turkish subword vocabulary (greedy longest-match WordPiece)
from 50% Wikipedia (unigrams.tsv) + 50% OpenSubtitles (subtitle_counts.tsv) — strictly non-heldout.

Writes:
  - data/work/context_v3/vocab.txt   (one token per line, line index = token id)
  - src/context-vocab.ts             (embedded TS vocab string for zero-extra-file browser/Node use)
"""

from __future__ import annotations

import argparse
import heapq
import re
from collections import Counter, defaultdict
from pathlib import Path

SPECIAL_TOKENS = ["<pad>", "<unk>", "<cls>", "<mask>", "<cap>", "<allcap>", "<num>"]
LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
LOWER_CHARS = "abcçdefgğhıijklmnoöprsştuüvyzâîûqwx"
PUNCT_CHARS = ".,;:!?'\"()-/%+&*=<>[]{}@#_~|"
WORD_PREFIX = "▁"

TOKEN_RE = re.compile(rf"[{LETTERS}]+|[0-9]+|[^\s]")


def lower_tr(text: str) -> str:
    return text.replace("I", "ı").replace("İ", "i").lower().replace("’", "'")


def upper_tr(text: str) -> str:
    return text.replace("i", "İ").replace("ı", "I").upper()


class SubwordTokenizer:
    """Fast deterministic greedy longest-match Turkish subword tokenizer (bit-identical to src/context.ts)."""

    def __init__(self, vocab: list[str]):
        self.vocab = vocab
        self.id_of = {tok: i for i, tok in enumerate(vocab)}
        self.max_len = max((len(t) for t in vocab if not (t.startswith("<") and t.endswith(">"))), default=1)
        self.pad_id = 0
        self.unk_id = 1
        self.cls_id = 2
        self.mask_id = 3
        self.cap_id = 4
        self.allcap_id = 5
        self.num_id = 6
        self.is_word_start = [tok.startswith(WORD_PREFIX) for tok in vocab]

    @classmethod
    def load(cls, path: str | Path) -> "SubwordTokenizer":
        lines = Path(path).read_text(encoding="utf-8").splitlines()
        return cls(lines)

    def encode_piece(self, low: str, word_start: bool) -> list[int]:
        out: list[int] = []
        n = len(low)
        pos = 0
        id_of = self.id_of
        max_len = self.max_len
        while pos < n:
            if pos == 0 and word_start:
                end = min(n, max_len - 1)
                found = -1
                while end > 0:
                    tid = id_of.get(WORD_PREFIX + low[:end])
                    if tid is not None:
                        found = tid
                        break
                    end -= 1
                if found != -1:
                    out.append(found)
                    pos = end
                else:
                    out.append(self.unk_id)
                    pos += 1
            else:
                end = min(n, pos + max_len)
                found = -1
                while end > pos:
                    tid = id_of.get(low[pos:end])
                    if tid is not None:
                        found = tid
                        break
                    end -= 1
                if found != -1:
                    out.append(found)
                    pos = end
                else:
                    out.append(self.unk_id)
                    pos += 1
        return out

    def encode(self, text: str) -> list[int]:
        norm = text.replace("’", "'")
        out: list[int] = []
        id_of = self.id_of
        for m in TOKEN_RE.finditer(norm):
            tok = m.group()
            ch0 = tok[0]
            if "0" <= ch0 <= "9":
                out.append(self.num_id)
                continue
            if len(tok) == 1 and not ch0.isalpha():
                out.append(id_of.get(ch0, self.unk_id))
                continue
            after_apos = m.start() > 0 and norm[m.start() - 1] == "'"
            low = lower_tr(tok)
            if not after_apos:
                if len(tok) > 1 and tok == upper_tr(tok) and tok != low:
                    out.append(self.allcap_id)
                elif tok[0] != lower_tr(tok[0]):
                    out.append(self.cap_id)
            out.extend(self.encode_piece(low, word_start=not after_apos))
        return out

    def decode_tokens(self, ids: list[int]) -> list[str]:
        return [self.vocab[i] if 0 <= i < len(self.vocab) else "<unk>" for i in ids]


def _read_counts(path: Path, valid_chars: set[str], min_count: int = 3) -> tuple[Counter[str], Counter[str]]:
    words: Counter[str] = Counter()
    conts: Counter[str] = Counter()
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            form, cnt = parts[0], int(parts[1])
            if cnt < min_count:
                continue
            if "'" in form:
                stem, suf = form.split("'", 1)
                if stem and all(c in valid_chars for c in stem):
                    words[stem] += cnt
                if suf and all(c in valid_chars for c in suf):
                    conts[suf] += cnt
            elif all(c in valid_chars for c in form):
                words[form] += cnt
    return words, conts


def train_bpe_vocab(
    wiki_path: Path,
    subs_path: Path | None,
    vocab_size: int = 8192,
    max_words: int = 160_000,
    power: float = 0.82,
) -> list[str]:
    """Train a Turkish BPE subword vocabulary blending 50% Wiki + 50% OpenSubtitles."""
    valid_chars = set(LOWER_CHARS)
    wiki_w, wiki_c = _read_counts(wiki_path, valid_chars, min_count=3)
    wiki_tot = sum(wiki_w.values()) or 1

    blended_w: dict[str, float] = {w: cnt / wiki_tot for w, cnt in wiki_w.items()}
    blended_c: dict[str, float] = {s: cnt / wiki_tot for s, cnt in wiki_c.items()}

    if subs_path and subs_path.is_file():
        subs_w, subs_c = _read_counts(subs_path, valid_chars, min_count=5)
        subs_tot = sum(subs_w.values()) or 1
        # Only boost subtitle words also attested in wiki or with strong subtitle frequency (>= 30) to keep out noisy OCR.
        for w, cnt in subs_w.items():
            if cnt >= 30 or w in wiki_w:
                blended_w[w] = blended_w.get(w, 0.0) + 1.0 * (cnt / subs_tot)
        for s, cnt in subs_c.items():
            if cnt >= 30 or s in wiki_c:
                blended_c[s] = blended_c.get(s, 0.0) + 1.0 * (cnt / subs_tot)

    scale = 1e8
    top_words = sorted(blended_w.items(), key=lambda kv: -kv[1])[:max_words]
    top_conts = sorted(blended_c.items(), key=lambda kv: -kv[1])[:10_000]

    seqs: list[list[str]] = []
    weights: list[float] = []
    for w, freq in top_words:
        if not w:
            continue
        seqs.append([WORD_PREFIX + w[0]] + list(w[1:]))
        weights.append((freq * scale) ** power)
    for s, freq in top_conts:
        if len(s) < 2:
            continue
        seqs.append(list(s))
        weights.append(((freq * scale) ** power) * 0.5)

    vocab: list[str] = list(SPECIAL_TOKENS)
    seen = set(vocab)
    for ch in PUNCT_CHARS:
        if ch not in seen:
            vocab.append(ch)
            seen.add(ch)
    for ch in LOWER_CHARS:
        for tok in (WORD_PREFIX + ch, ch):
            if tok not in seen:
                vocab.append(tok)
                seen.add(tok)

    pair_score: dict[tuple[str, str], float] = defaultdict(float)
    pair_seqs: dict[tuple[str, str], set[int]] = defaultdict(set)
    for idx, syms in enumerate(seqs):
        w = weights[idx]
        for j in range(len(syms) - 1):
            p = (syms[j], syms[j + 1])
            pair_score[p] += w
            pair_seqs[p].add(idx)

    heap: list[tuple[float, tuple[str, str]]] = [(-sc, p) for p, sc in pair_score.items()]
    heapq.heapify(heap)

    merges_done = 0
    while len(vocab) < vocab_size and heap:
        neg_sc, pair = heapq.heappop(heap)
        cur_sc = pair_score.get(pair, 0.0)
        if cur_sc <= 0.0 or abs(-neg_sc - cur_sc) > 1e-2:
            continue
        a, b = pair
        merged = a + b
        if len(merged) > 18:
            pair_score[pair] = 0.0
            continue

        affected = list(pair_seqs.pop(pair, ()))
        pair_score[pair] = 0.0
        if not affected:
            continue

        touched_pairs: set[tuple[str, str]] = set()
        for idx in affected:
            syms = seqs[idx]
            if len(syms) < 2:
                continue
            w = weights[idx]
            new_syms: list[str] = []
            j = 0
            changed = False
            n = len(syms)
            while j < n:
                if j + 1 < n and syms[j] == a and syms[j + 1] == b:
                    new_syms.append(merged)
                    j += 2
                    changed = True
                else:
                    new_syms.append(syms[j])
                    j += 1
            if not changed:
                continue
            for k in range(len(syms) - 1):
                op = (syms[k], syms[k + 1])
                if op != pair:
                    pair_score[op] -= w
                    touched_pairs.add(op)
            seqs[idx] = new_syms
            for k in range(len(new_syms) - 1):
                np_ = (new_syms[k], new_syms[k + 1])
                pair_score[np_] += w
                pair_seqs[np_].add(idx)
                touched_pairs.add(np_)

        for tp in touched_pairs:
            sc = pair_score.get(tp, 0.0)
            if sc > 1.0:
                heapq.heappush(heap, (-sc, tp))

        if merged not in seen:
            vocab.append(merged)
            seen.add(merged)
            merges_done += 1
            if merges_done % 1000 == 0:
                print(f"  merges={merges_done} vocab={len(vocab)} last={merged!r} score={cur_sc:.1f}", flush=True)

    return vocab


def write_ts_vocab(vocab: list[str], ts_path: Path) -> None:
    escaped = "\\n".join(tok.replace("\\", "\\\\").replace('"', '\\"') for tok in vocab)
    ts_code = (
        "// Auto-generated by py/build_tokenizer.py — Turkish 8K subword vocabulary for Context Model v3.\n"
        f'export const CONTEXT_VOCAB_TEXT = "{escaped}";\n'
    )
    ts_path.write_text(ts_code, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wiki", default="data/work/unigrams.tsv")
    parser.add_argument("--subs", default="data/work/subtitle_counts.tsv")
    parser.add_argument("--vocab-size", type=int, default=8192)
    parser.add_argument("--out", default="data/work/context_v3/vocab.txt")
    parser.add_argument("--ts-out", default="src/context-vocab.ts")
    args = parser.parse_args()

    print(f"Training {args.vocab_size}-token Turkish subword vocab (50% Wiki + 50% Subs)...", flush=True)
    vocab = train_bpe_vocab(Path(args.wiki), Path(args.subs), vocab_size=args.vocab_size)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(vocab) + "\n", encoding="utf-8")
    write_ts_vocab(vocab, Path(args.ts_out))
    print(f"Wrote {len(vocab)} tokens to {out} and {args.ts_out}", flush=True)

    tok = SubwordTokenizer(vocab)
    vset = set(vocab)
    check = [
        "▁kedi", "▁keçi", "▁balkon", "▁sabah", "▁saha", "▁araba", "▁kapı", "▁köy", "▁koy",
        "▁üç", "▁uç", "▁oldu", "▁öldü", "▁yıllar", "▁yollar", "▁haber", "▁her", "▁aldık",
        "▁adı", "▁olur", "▁oluyor", "▁ağladı", "▁aldı", "▁bende", "▁içinde", "▁gül", "▁göl",
        "▁dokuz", "▁etkili", "▁değişti", "▁değişir",
    ]
    print(f"Key words in vocab: {sum(w in vset for w in check)}/{len(check)} (missing: {[w for w in check if w not in vset]})")
    samples = [
        "Ondan hiç haber alamadım, her gün bekledim.",
        "Uzun yıllar sonra yollar tekrar açıldı.",
        "Otelde ne kadar kalacağımızı ve nerede olacağımızı sorduk.",
        "Bahçedeki güller çok güzel kokuyor, göller kuruyor.",
        "Komşunun kedisi balkona atladı, dağ keçisi kaçtı.",
        "Genel olarak içinde vanilyalı krema vardır.",
        "HTTPS, Tor anonimliği ağındaki bağlantılar için de çok önemlidir.",
        "Ankara'ya giderken GOES-15 verilerini inceledik.",
    ]
    for s in samples:
        ids = tok.encode(s)
        print(f"  ({len(ids):2d} tok) {' '.join(tok.decode_tokens(ids))}")


if __name__ == "__main__":
    main()
