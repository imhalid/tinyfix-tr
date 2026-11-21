"""Count Turkish word forms and selected word pairs in Wikipedia, holding out documents for testing.

Writes to data/work/:
  unigrams.tsv   form<TAB>count<TAB>capitalized_mid_sentence_count   (count >= --min-count)
  bigrams.tsv    first second<TAB>count                              (only pairs that join/split candidates need)
  heldout.jsonl  {"id", "text"} for held-out documents, never counted
"""

import argparse
import collections
import hashlib
import json
import re
from pathlib import Path

import pyarrow.parquet as pq

LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
TOKEN = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)?|\d+(?:[.,]\d+)*|[.!?:;,\"()\n]")
SENTENCE_END = {".", "!", "?", ":", "\n"}
PARTICLE = re.compile(r"^(m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae])?|d[ae]|k[iı]|t[ae])$")


def lower_tr(word: str) -> str:
    return word.replace("I", "ı").replace("İ", "i").lower().replace("’", "'")


def is_heldout(doc_id: str, every: int) -> bool:
    return int(hashlib.md5(doc_id.encode()).hexdigest(), 16) % every == 0


def documents(paths: list[Path]):
    for path in paths:
        table = pq.read_table(path, columns=["id", "text"])
        for doc_id, text in zip(table.column("id").to_pylist(), table.column("text").to_pylist()):
            yield doc_id, text


def words_with_flags(text: str):
    """Yields (lowercased word, capitalized mid-sentence) for each word, and None at sentence breaks."""
    at_start = True
    for raw in TOKEN.findall(text):
        if raw[0].isdigit():
            at_start = False
            yield None
            continue
        if not raw[0].isalpha():
            if raw in SENTENCE_END:
                at_start = True
            yield None
            continue
        yield lower_tr(raw), (raw[0].isupper() and not at_start)
        at_start = False


def wanted_pair(first: str, second: str) -> bool:
    return len(first) <= 4 or len(second) <= 4 or bool(PARTICLE.match(second))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="data/raw/trwiki")
    parser.add_argument("--out", default="data/work")
    parser.add_argument("--heldout-every", type=int, default=50)
    parser.add_argument("--min-count", type=int, default=2)
    parser.add_argument("--min-pair", type=int, default=2)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    paths = sorted(Path(args.raw).glob("*.parquet"))

    counts: collections.Counter = collections.Counter()
    capitalized: collections.Counter = collections.Counter()
    pairs: collections.Counter = collections.Counter()
    docs = kept = tokens = 0
    with open(out / "heldout.jsonl", "w") as heldout:
        for doc_id, text in documents(paths):
            docs += 1
            if is_heldout(doc_id, args.heldout_every):
                heldout.write(json.dumps({"id": doc_id, "text": text}, ensure_ascii=False) + "\n")
                continue
            kept += 1
            previous = None
            for item in words_with_flags(text):
                if item is None:
                    previous = None
                    continue
                word, is_cap = item
                counts[word] += 1
                tokens += 1
                if is_cap:
                    capitalized[word] += 1
                if previous is not None and wanted_pair(previous, word):
                    pairs[previous + " " + word] += 1
                previous = word
            if docs % 50000 == 0:
                print(f"{docs} docs, {tokens:,} words, {len(counts):,} forms, {len(pairs):,} pairs", flush=True)

    with open(out / "unigrams.tsv", "w") as file:
        for word, count in counts.most_common():
            if count < args.min_count:
                break
            file.write(f"{word}\t{count}\t{capitalized[word]}\n")
    with open(out / "bigrams.tsv", "w") as file:
        for pair, count in pairs.most_common():
            if count < args.min_pair:
                break
            first, second = pair.split(" ")
            if counts[first + second] or wanted_pair(first, second):
                file.write(f"{pair}\t{count}\n")
    stats = {"documents": docs, "counted_documents": kept, "words": tokens, "forms": len(counts), "pairs": len(pairs)}
    (out / "lexicon_stats.json").write_text(json.dumps(stats, indent=2))
    print(stats)


if __name__ == "__main__":
    main()
