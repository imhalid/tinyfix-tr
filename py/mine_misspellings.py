"""Find likely common misspellings in subtitles, for a person (or Gemini Neon) to review before they are listed.

A candidate is a form that
  - subtitles use often (--min-subtitle times): it is common enough to matter,
  - edited text (Wikipedia) almost never uses: real words appear there too,
  - has a "twin" one edit or one Turkish mark away that is far more common in both sources.
That catches "seyehat" (seyahat) and "yanlız" (yalnız), but not pairs like "yatıyorsun" / "yaşıyorsun", which both
appear in Wikipedia. Listed misspellings (data/rules/known.tsv) are skipped.

Writes data/rules/mined-candidates.tsv: wrong, right, subtitle and Wikipedia counts of each, the kind of edit.
"""

import argparse
from pathlib import Path

ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyz"
TOGGLE = {"c": "ç", "g": "ğ", "i": "ı", "o": "ö", "s": "ş", "u": "ü", "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u"}


def edits(word: str):
    """(form, kind, position) one edit or one mark away."""
    for i in range(len(word) + 1):
        a, b = word[:i], word[i:]
        if b:
            yield a + b[1:], "extra letter", i
            if len(b) > 1:
                yield a + b[1] + b[0] + b[2:], "swapped letters", i
            if b[0] in TOGGLE:
                yield a + TOGGLE[b[0]] + b[1:], "Turkish mark", i
            for c in ALPHABET:
                if c != b[0]:
                    yield a + c + b[1:], "wrong letter", i
        for c in ALPHABET:
            yield a + c + b, "missing letter", i


def load(path: Path) -> dict[str, int]:
    counts = {}
    for line in open(path):
        parts = line.rstrip("\n").split("\t")
        counts[parts[0]] = int(parts[1])
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--subtitles", default="data/work/subtitle_counts.tsv")
    parser.add_argument("--wiki", default="data/work/unigrams.tsv")
    parser.add_argument("--known", default="data/rules/known.tsv")
    parser.add_argument("--out", default="data/rules/mined-candidates.tsv")
    parser.add_argument("--min-subtitle", type=int, default=20)
    parser.add_argument("--max-wiki", type=int, default=5)
    parser.add_argument("--ratio", type=float, default=20)
    parser.add_argument("--min-length", type=int, default=4)
    args = parser.parse_args()
    sub, wiki = load(Path(args.subtitles)), load(Path(args.wiki))
    known = {line.split("\t")[0] for line in open(args.known) if line and not line.startswith("#")}

    rows = []
    for word, count in sub.items():
        if count < args.min_subtitle or len(word) < args.min_length or not word.isalpha() or word in known:
            continue
        if wiki.get(word, 0) > args.max_wiki:
            continue
        best = None
        for other, kind, position in edits(word):
            if other == word:
                continue
            o_sub, o_wiki = sub.get(other, 0), wiki.get(other, 0)
            if o_sub < args.ratio * count or o_wiki < args.ratio * max(wiki.get(word, 0), 1):
                continue
            if best is None or o_sub > best[1]:
                best = (other, o_sub, o_wiki, kind, position)
        if best:
            other, o_sub, o_wiki, kind, position = best
            # Subtitle OCR reads "l" as "ı" or "I" ("nasıı", "değiı"): not something people type.
            if kind == "wrong letter" and len(other) == len(word) and any(
                a == "l" and b in "ıi" for a, b in zip(other, word)
            ):
                continue
            # Missing Turkish letters are already the corrector's "marks" rule, not a list entry.
            if kind == "Turkish mark":
                continue
            at_end = "end" if position >= len(word) - 2 else "inside"
            rows.append((word, other, count, o_sub, wiki.get(word, 0), o_wiki, kind, at_end))
    rows.sort(key=lambda row: -row[2])
    with open(args.out, "w") as file:
        file.write("# wrong\tright\twrong_subtitles\tright_subtitles\twrong_wiki\tright_wiki\tedit\twhere\n")
        for row in rows:
            file.write("\t".join(map(str, row)) + "\n")
    print(f"{len(rows)} candidates written to {args.out}")


if __name__ == "__main__":
    main()
