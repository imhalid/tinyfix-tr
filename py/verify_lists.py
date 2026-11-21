"""Check a list of known misspellings against corpus counts before the corrector uses it.

Input: a Markdown file with "### MISSPELLINGS", "### SEPARATE_ALWAYS", "### JOINED_ALWAYS" sections of
"wrong<TAB>right[<TAB>note]" lines (as written by Gemini Neon). A rule is kept only when the right form is seen
at least --min-right times and at least --ratio times as often as the wrong form. Everything else goes to
review.tsv with the reason, for a person to decide.

Writes data/rules/known.tsv and data/rules/review.tsv.
"""

import argparse
from pathlib import Path

SECTIONS = {"MISSPELLINGS", "SEPARATE_ALWAYS", "JOINED_ALWAYS"}
# Not verified against TDK: kept out until a person checks them.
HELD_BACK = {"illaki", "illa ki"}


def lower_tr(text: str) -> str:
    return text.replace("I", "ı").replace("İ", "i").lower().replace("’", "'")


def load(path: Path, key_columns: int) -> dict[str, int]:
    counts = {}
    with open(path) as file:
        for line in file:
            parts = line.rstrip("\n").split("\t")
            counts[parts[0]] = int(parts[1])
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("lists")
    parser.add_argument("--unigrams", default="data/work/unigrams.tsv")
    parser.add_argument("--bigrams", default="data/work/bigrams.tsv")
    parser.add_argument("--out", default="data/rules")
    parser.add_argument("--min-right", type=int, default=20)
    parser.add_argument("--ratio", type=float, default=10)
    args = parser.parse_args()
    unigrams = load(Path(args.unigrams), 1)
    bigrams = load(Path(args.bigrams), 2)

    def count(phrase: str) -> int | None:
        words = phrase.split(" ")
        if len(words) == 1:
            return unigrams.get(words[0], 0)
        if len(words) == 2:
            return bigrams.get(phrase, 0)
        return None

    section = None
    kept, review, seen = [], [], set()
    for line in open(args.lists):
        line = line.rstrip("\n")
        if line.startswith("### "):
            section = line[4:].strip()
            continue
        if section not in SECTIONS or "\t" not in line:
            continue
        wrong, right = (lower_tr(part.strip()) for part in line.split("\t")[:2])
        if not wrong or not right or wrong == right or wrong in seen:
            continue
        seen.add(wrong)
        if wrong in HELD_BACK or right in HELD_BACK:
            review.append((wrong, right, "", "", section, "not verified against TDK"))
            continue
        wrong_count, right_count = count(wrong), count(right)
        if wrong_count is None or right_count is None:
            review.append((wrong, right, "", "", section, "more than two words: can't count"))
        elif right_count < args.min_right:
            review.append((wrong, right, wrong_count, right_count, section, "right form too rare in corpus"))
        elif right_count < args.ratio * wrong_count:
            review.append((wrong, right, wrong_count, right_count, section, "wrong form too common in corpus"))
        else:
            kept.append((wrong, right, wrong_count, right_count, section))

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "known.tsv", "w") as file:
        file.write("# wrong\tright\twrong_count\tright_count\tsection   (verified: right >= %d and >= %gx wrong)\n" % (args.min_right, args.ratio))
        for row in kept:
            file.write("\t".join(map(str, row)) + "\n")
    with open(out / "review.tsv", "w") as file:
        file.write("# wrong\tright\twrong_count\tright_count\tsection\treason\n")
        for row in review:
            file.write("\t".join(map(str, row)) + "\n")
    print(f"kept {len(kept)}, review {len(review)}")


if __name__ == "__main__":
    main()
