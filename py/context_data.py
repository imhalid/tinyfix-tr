"""Build training examples for the context model from Wikipedia documents the test sets never use.

Each example is a span of text, the characters on both sides of it, and 2-4 candidate spans that the corrector could
confuse with each other: "ben de" / "bende", "evdeki" / "evde ki", "sevgimi" / "sevgi mi", "oldu" / "öldü".
The span that was really there is the label. The model learns to score the candidate that fits the context highest.

Writes data/work/context/<split>.npz with uint8 character ids:
  left [N, LEFT], right [N, RIGHT], candidates [N, MAX_CANDIDATES, SPAN], count [N], label [N], kind [N]
"""

import argparse
import hashlib
import random
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

LEFT, RIGHT, SPAN, MAX_CANDIDATES = 80, 40, 24, 4
LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
WORD = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)?")
FOLD = str.maketrans("çğıöşüâîû", "cgiosuaiu")
QUESTION = re.compile(r"^m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae]|yd[iıuü]|yken)?$")
KINDS = ["marks", "de_da", "ki", "mi"]

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


def lower_tr(word: str) -> str:
    return word.replace("I", "ı").replace("İ", "i").lower()


def is_heldout(doc_id: str, every: int = 50) -> bool:
    return int(hashlib.md5(doc_id.encode()).hexdigest(), 16) % every == 0


def load_counts(path: Path) -> dict[str, int]:
    counts = {}
    for line in open(path):
        word, count, _ = line.rstrip("\n").split("\t")
        counts[word] = int(count)
    return counts


def mark_groups(counts: dict[str, int], min_count: int) -> dict[str, list[str]]:
    """Words that only differ in Turkish marks, most common first: "oldu" -> ["oldu", "öldü"]."""
    groups = defaultdict(list)
    for word, count in counts.items():
        if count >= min_count and "'" not in word:
            groups[word.translate(FOLD)].append(word)
    return {fold: sorted(words, key=lambda w: -counts[w])[:MAX_CANDIDATES] for fold, words in groups.items() if len(words) > 1}


def examples_for_paragraph(text: str, counts, groups, rng: random.Random, want: dict[str, int]):
    """Yields (kind, span start, span end, candidates with the true one first) for one paragraph."""
    words = [(m.start(), m.end(), m.group()) for m in WORD.finditer(text)]
    for index, (start, end, raw) in enumerate(words):
        low = lower_tr(raw)
        previous = words[index - 1] if index > 0 else None
        joined_to_previous = previous is not None and text[previous[1] : start] == " "
        if "'" in low:
            continue
        # A separate particle after a word: "ben de", "diyor ki", "geldin mi".
        if joined_to_previous and raw.islower():
            p_start, _, p_raw = previous
            p_low = lower_tr(p_raw)
            if "'" not in p_low and p_raw[0].islower():
                span = text[p_start:end]
                glued = p_raw + raw
                if low in ("de", "da") and want["de_da"] > 0:
                    yield "de_da", p_start, end, [span, glued]
                elif low == "ki" and want["ki"] > 0:
                    yield "ki", p_start, end, [span, glued]
                elif QUESTION.match(low) and want["mi"] > 0:
                    yield "mi", p_start, end, [span, glued]
        if not raw.islower():
            continue
        # A word with the same ending glued on: "evde", "evdeki", "sevgimi".
        for kind, suffixes in (("de_da", ("de", "da", "te", "ta")), ("ki", ("ki",)), ("mi", ("mi", "mı", "mu", "mü"))):
            if want[kind] > 0 and len(low) >= 5 and low.endswith(suffixes):
                stem = raw[:-2]
                if counts.get(lower_tr(stem), 0) >= 5 and counts.get(low, 0) >= 2:
                    yield kind, start, end, [raw, f"{stem} {raw[-2:]}"]
        # The same letters with or without Turkish marks: "oldu" / "öldü".
        if want["marks"] > 0:
            group = groups.get(low.translate(FOLD))
            if group and low in group and rng.random() < 0.35:
                yield "marks", start, end, [raw] + [w for w in group if w != low]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="data/raw/trwiki")
    parser.add_argument("--unigrams", default="data/work/unigrams.tsv")
    parser.add_argument("--out", default="data/work/context")
    parser.add_argument("--per-kind", type=int, default=200_000)
    parser.add_argument("--valid-share", type=float, default=0.02)
    parser.add_argument("--min-group-count", type=int, default=5)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    counts = load_counts(Path(args.unigrams))
    groups = mark_groups(counts, args.min_group_count)
    print(f"{len(groups):,} groups of words that differ only in marks", flush=True)

    want = {kind: args.per_kind for kind in KINDS}
    rows: dict[str, list] = {"train": [], "valid": []}
    paths = sorted(Path(args.raw).glob("*.parquet"))
    docs = 0
    for path in paths:
        table = pq.read_table(path, columns=["id", "text"])
        order = list(range(table.num_rows))
        rng.shuffle(order)
        ids, texts = table.column("id").to_pylist(), table.column("text").to_pylist()
        for row in order:
            if all(value <= 0 for value in want.values()):
                break
            doc_id, text = ids[row], texts[row]
            if is_heldout(doc_id):
                continue
            docs += 1
            split = "valid" if int(hashlib.md5(("ctx" + doc_id).encode()).hexdigest(), 16) % 1000 < args.valid_share * 1000 else "train"
            for paragraph in text.split("\n"):
                if len(paragraph) < 40:
                    continue
                for kind, start, end, candidates in examples_for_paragraph(paragraph, counts, groups, rng, want):
                    if end - start > SPAN or want[kind] <= 0:
                        continue
                    # Keep at most two examples per kind per paragraph so no document dominates.
                    if rng.random() < 0.5:
                        continue
                    candidates = list(dict.fromkeys(candidates))[:MAX_CANDIDATES]
                    order_c = list(range(len(candidates)))
                    rng.shuffle(order_c)
                    shuffled = [candidates[i] for i in order_c]
                    label = order_c.index(0)
                    left = paragraph[max(0, start - LEFT) : start]
                    right = paragraph[end : end + RIGHT]
                    rows[split].append((KINDS.index(kind), left, right, shuffled, label))
                    if split == "train":
                        want[kind] -= 1
            if docs % 20000 == 0:
                print(docs, "docs", {k: args.per_kind - v for k, v in want.items()}, flush=True)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for split, items in rows.items():
        rng.shuffle(items)
        n = len(items)
        left = np.zeros((n, LEFT), np.uint8)
        right = np.zeros((n, RIGHT), np.uint8)
        cands = np.zeros((n, MAX_CANDIDATES, SPAN), np.uint8)
        count = np.zeros(n, np.uint8)
        label = np.zeros(n, np.uint8)
        kind = np.zeros(n, np.uint8)
        for i, (k, l, r, cs, y) in enumerate(items):
            left[i] = encode(l, LEFT, align_right=True)
            right[i] = encode(r, RIGHT, align_right=False)
            for j, c in enumerate(cs):
                cands[i, j] = encode(c, SPAN, align_right=False)
            count[i], label[i], kind[i] = len(cs), y, k
        np.savez_compressed(out / f"{split}.npz", left=left, right=right, candidates=cands, count=count, label=label, kind=kind)
        print(split, n, {name: int((kind == i).sum()) for i, name in enumerate(KINDS)})
    (out / "alphabet.txt").write_text(ALPHABET)


if __name__ == "__main__":
    main()
