"""Compare the context model with "pick the more common form", and with the two combined, on the validation set.

"hard" examples are the ones where the right answer is not the most common form: the cases a context model is for.
The combined score is model score + weight * log(count + 1), with the weight chosen on the first half of the
validation set and reported on the second half.
"""

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
from train_context import KINDS, ContextScorer, batches, scores_for  # noqa: E402


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

    def lower(word: str) -> str:
        return word.replace("I", "ı").replace("İ", "i").lower()

    def count(ids) -> int:
        span = "".join(decode.get(int(i), "?") for i in ids if i != 0)
        words = lower(span).split(" ")
        return unigrams.get(words[0], 0) if len(words) == 1 else bigrams.get(" ".join(words), 0)

    data = {key: value for key, value in np.load(directory / "valid.npz").items()}
    n, k = data["candidates"].shape[:2]
    logcount = np.full((n, k), -1e4)
    for i in range(n):
        for j in range(data["count"][i]):
            logcount[i, j] = np.log(count(data["candidates"][i, j]) + 1)

    model = ContextScorer(len(alphabet) + 2)
    model.load_state_dict(torch.load(directory / "model" / "context.pt"))
    model.eval()
    model_scores = np.zeros((n, k))
    with torch.no_grad():
        for idx, tokens, segments in batches(data, 1024, False, np.random.default_rng(0)):
            model_scores[idx] = scores_for(model, tokens, segments, data["count"][idx], k, "cpu").numpy()

    label, kind = data["label"], data["kind"]
    hard = logcount.argmax(1) != label
    half = n // 2

    def accuracy(scores, mask):
        return float((scores.argmax(1)[mask] == label[mask]).mean()) if mask.any() else float("nan")

    weights = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3]
    tune = np.arange(n) < half
    best = max(weights, key=lambda w: accuracy(model_scores + w * logcount, tune))
    combined = model_scores + best * logcount
    report = np.arange(n) >= half
    print(f"weight on log count, chosen on the first half: {best}")
    print(f"{'kind':8} {'n':>6} {'hard':>6}   {'counts':>7} {'model':>7} {'both':>7}   hard: {'model':>7} {'both':>7}")
    for index, name in enumerate(KINDS + ["all"]):
        mask = report & (kind == index) if name != "all" else report
        hmask = mask & hard
        print(
            f"{name:8} {mask.sum():6d} {hmask.sum():6d}   {accuracy(logcount, mask):7.4f} {accuracy(model_scores, mask):7.4f} "
            f"{accuracy(combined, mask):7.4f}   hard: {accuracy(model_scores, hmask):7.4f} {accuracy(combined, hmask):7.4f}"
        )


if __name__ == "__main__":
    main()
