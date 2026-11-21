"""Candidate proper names: words written with a capital almost every time they appear mid-sentence.

Counts, over Turkish Wikipedia (held-out documents skipped), how often each word appears in the middle of a sentence
and how often it is capitalized there. A word is a candidate when it is seen at least 40 times mid-sentence and
capitalized at least 97% of those times ("ahmet", "istanbul", "türkçe"). Ordinary words that are often capitalized in
titles or dates ("ocak", "bey") are removed later by scripts/build-names.ts using the morphology's common-word list.

    py/.venv/bin/python py/build_names.py > data/work/name_candidates.tsv
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import CLEAN_TOKEN, SENTENCE_END, documents, is_heldout, lower_tr  # noqa: E402

MIN_MID = 40
MIN_SHARE = 0.97


def main() -> None:
    paths = sorted(Path("data/raw/trwiki").glob("*.parquet"))
    mid: Counter[str] = Counter()
    capital: Counter[str] = Counter()
    for index, (doc_id, text) in enumerate(documents(paths)):
        if index % 100000 == 0:
            print(f"{index} documents", file=sys.stderr)
        if is_heldout(str(doc_id), 50):
            continue
        at_start = True
        for raw in CLEAN_TOKEN.findall(text):
            first = raw[0]
            if not first.isalpha():
                at_start = raw in SENTENCE_END or (at_start and raw in '"(')
                continue
            stem = raw.split("'")[0].split("’")[0]
            # Acronyms ("NATO") and mixed case ("iPhone") are not judged here.
            if len(stem) >= 2 and stem.isupper():
                at_start = False
                continue
            if not at_start:
                word = lower_tr(stem)
                mid[word] += 1
                if first.isupper():
                    capital[word] += 1
            at_start = False
    for word, total in mid.items():
        if len(word) < 2 or total < MIN_MID:
            continue
        caps = capital[word]
        if caps / total >= MIN_SHARE:
            print(f"{word}\t{caps}\t{total}")


if __name__ == "__main__":
    main()
