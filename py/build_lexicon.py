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
# A number with its suffix ("1977'de", "3’ü") is one token: the suffix is not a word of its own.
CLEAN_TOKEN = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)?|\d+(?:[.,]\d+)*(?:['’][{LETTERS}]+)?|[.!?:;,\"()\n]")

# Section headings after which a Wikipedia article is only references, links and lists of (often foreign) titles.
TAIL_SECTIONS = {
    "kaynakça", "kaynaklar", "dipnotlar", "notlar", "dış bağlantılar", "ayrıca bakınız", "konuyla ilgili yayınlar",
    "bibliyografya", "ek okumalar", "ileri okumalar", "ek kaynaklar", "kaynak", "dış linkler",
}
# Lines that are wiki tables, templates or HTML rather than prose.
MARKUP_LINE = re.compile(r"^\s*(?:\{\||\|\}|\|-|\||!|<)|\w+=\"|style=|class=|colspan|rowspan|bgcolor|cellspacing|<\/?\w+[^>]*>")
HTML_TAG = re.compile(r"<[^>]+>")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
# Common function words of English, French and German. Words that are also Turkish ("on", "at", "her", "can", "has",
# "his", "der", "et", "it", "in", "is", "as", "an", "be", "la", "le", "mit") are left out on purpose.
FOREIGN = set(
    "the of and to for with are was were by from this that or which not have their but they who what when where "
    "how all will would should into than then there these those its "
    "les des du une est dans pour die das und ist von".split()
)
# Units written after a number ("50 km", "500 mi"): counting them makes "mi" and "km" look like words.
UNITS = set("km cm mm m kg g mg mi ft in ha ml l lb oz mph hz khz mhz ghz kw mw gw kwh v w kb mb gb tb km² m² m³ ".split())
KEEP_SINGLE = {"o", "e", "a"}


def clean_text(text: str, cut_tail: bool = True) -> str:
    """Prose only: drops wiki markup lines, reference sections and sentences that are mostly in another language."""
    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if cut_tail and lower_tr(stripped.rstrip(":")) in TAIL_SECTIONS:
            break
        if not stripped:
            lines.append("")
            continue
        if MARKUP_LINE.search(stripped):
            continue
        stripped = HTML_TAG.sub(" ", stripped)
        kept = []
        for sentence in SENTENCE_SPLIT.split(stripped):
            words = re.findall(rf"[{LETTERS}]+", sentence)
            foreign = sum(1 for word in words if word.lower() in FOREIGN)
            if foreign >= 2 and foreign >= 0.1 * len(words):
                continue
            kept.append(sentence)
        lines.append(" ".join(kept))
    return "\n".join(lines)
SENTENCE_END = {".", "!", "?", ":", "\n"}
PARTICLE = re.compile(r"^(m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae])?|d[ae]|k[iı]|t[ae])$")


def lower_tr(word: str) -> str:
    return word.replace("I", "ı").replace("İ", "i").lower().replace("’", "'")


def count(text: str, counts, capitalized, pairs, clean: bool) -> int:
    """Adds the words and wanted pairs of one text to the counters; returns how many words it had."""
    words = 0
    previous = None
    for item in words_with_flags(text, clean=clean):
        if item is None:
            previous = None
            continue
        word, is_cap = item
        counts[word] += 1
        words += 1
        if is_cap:
            capitalized[word] += 1
        if previous is not None and wanted_pair(previous, word):
            pairs[previous + " " + word] += 1
        previous = word
    return words


def is_heldout(doc_id: str, every: int) -> bool:
    return int(hashlib.md5(doc_id.encode()).hexdigest(), 16) % every == 0


def documents(paths: list[Path]):
    for path in paths:
        table = pq.read_table(path, columns=["id", "text"])
        for doc_id, text in zip(table.column("id").to_pylist(), table.column("text").to_pylist()):
            yield doc_id, text


def words_with_flags(text: str, clean: bool = False):
    """Yields (lowercased word, capitalized mid-sentence) for each word, and None at sentence breaks.

    With clean=True, acronyms ("ISBN", "FIFA", Roman "II", "TBMM'nin"), stray single letters and units after a
    number are not words: they break the chain like a number does.
    """
    at_start = True
    after_number = False
    for raw in (CLEAN_TOKEN if clean else TOKEN).findall(text):
        if raw[0].isdigit():
            at_start = False
            after_number = True
            yield None
            continue
        if clean and raw[0].isalpha():
            stem = re.split(r"['’]", raw, maxsplit=1)[0]
            is_unit = after_number and lower_tr(raw) in UNITS
            after_number = False
            if (len(stem) >= 2 and stem.isupper()) or is_unit or (len(raw) == 1 and lower_tr(raw) not in KEEP_SINGLE):
                at_start = False
                yield None
                continue
        else:
            after_number = False
        if not raw[0].isalpha():
            if raw in SENTENCE_END:
                at_start = True
            yield None
            continue
        yield lower_tr(raw), (raw[0].isupper() and not at_start)
        at_start = False


def wanted_pair(first: str, second: str) -> bool:
    return len(first) <= 4 or len(second) <= 4 or bool(PARTICLE.match(second))


PAGE_NUMBER = re.compile(r"^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$")
LINE_HYPHEN = re.compile(rf"([{LETTERS}])[-\u00ad]\n\s*([{LETTERS.replace('A-Z', '').replace('ÇĞİÖŞÜ', '')}])")


def book_paragraphs(path: Path):
    """Paragraphs of a plain-text book: page numbers dropped, words broken across lines ("gel-\nmek") joined."""
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\u00ad\n", "")
    text = LINE_HYPHEN.sub(r"\1\2", text)
    lines = [line for line in text.split("\n") if not PAGE_NUMBER.match(line)]
    # A blank line separates paragraphs; single line breaks inside a paragraph are just wrapping.
    for block in re.split(r"\n\s*\n", "\n".join(lines)):
        paragraph = " ".join(line.strip() for line in block.split("\n") if line.strip())
        if paragraph:
            yield paragraph


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="data/raw/trwiki")
    parser.add_argument("--out", default="data/work")
    parser.add_argument("--heldout-every", type=int, default=50)
    parser.add_argument("--min-count", type=int, default=2)
    parser.add_argument("--min-pair", type=int, default=2)
    parser.add_argument("--no-clean", action="store_true", help="count raw text as before (markup, references, acronyms)")
    parser.add_argument("--books", default="data/raw/books", help="folder of UTF-8 .txt books (public domain) to count too")
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
            tokens += count(text if args.no_clean else clean_text(text), counts, capitalized, pairs, not args.no_clean)
            if docs % 50000 == 0:
                print(f"{docs} docs, {tokens:,} words, {len(counts):,} forms, {len(pairs):,} pairs", flush=True)

    # Books: every --heldout-every'th paragraph is held out (data/work/books_heldout.jsonl) for a future test set.
    book_files = sorted(Path(args.books).glob("*.txt")) if Path(args.books).is_dir() else []
    book_words = 0
    with open(out / "books_heldout.jsonl", "w") as heldout:
        for path in book_files:
            for index, paragraph in enumerate(book_paragraphs(path)):
                if index % args.heldout_every == args.heldout_every - 1:
                    heldout.write(json.dumps({"id": f"{path.stem}#{index}", "text": paragraph}, ensure_ascii=False) + "\n")
                    continue
                book_words += count(clean_text(paragraph, cut_tail=False), counts, capitalized, pairs, True)
    tokens += book_words
    if book_files:
        print(f"{len(book_files)} books, {book_words:,} words", flush=True)

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
    stats = {"clean": not args.no_clean, "books": len(book_files), "book_words": book_words, "documents": docs, "counted_documents": kept, "words": tokens, "forms": len(counts), "pairs": len(pairs)}
    (out / "lexicon_stats.json").write_text(json.dumps(stats, indent=2))
    print(stats)


if __name__ == "__main__":
    main()
