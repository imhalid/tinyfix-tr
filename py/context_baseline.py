"""How well does "pick the more common form" do on the context model's validation set? The model has to beat this.

Counts come from the lexicon: a single word by its count, two words by how often they appear together.
"""

import sys
from pathlib import Path

import numpy as np

KINDS = ["marks", "de_da", "ki", "mi"]


def main():
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "data/work/context")
    alphabet = (directory / "alphabet.txt").read_text()
    decode = {index + 2: char for index, char in enumerate(alphabet)}
    unigrams, bigrams = {}, {}
    for line in open("data/work/unigrams.tsv"):
        word, count, _ = line.rstrip("\n").split("\t")
        unigrams[word] = int(count)
    for line in open("data/work/bigrams.tsv"):
        pair, count = line.rstrip("\n").rsplit("\t", 1)
        bigrams[pair] = int(count)

    def text(ids) -> str:
        return "".join(decode.get(int(i), "?") for i in ids if i != 0)

    def lower(word: str) -> str:
        return word.replace("I", "ı").replace("İ", "i").lower()

    def count(span: str) -> int:
        words = lower(span).split(" ")
        return unigrams.get(words[0], 0) if len(words) == 1 else bigrams.get(" ".join(words), 0)

    data = np.load(directory / "valid.npz")
    right = np.zeros(len(KINDS))
    total = np.zeros(len(KINDS))
    for cands, n, label, kind in zip(data["candidates"], data["count"], data["label"], data["kind"]):
        counts = [count(text(cands[j])) for j in range(n)]
        right[kind] += int(np.argmax(counts) == label)
        total[kind] += 1
    print({name: round(float(right[i] / total[i]), 4) for i, name in enumerate(KINDS)}, "all", round(float(right.sum() / total.sum()), 4))


if __name__ == "__main__":
    main()
