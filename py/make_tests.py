"""Build frozen dev and test sets from held-out Wikipedia documents, one error class at a time.

Each line of bench/<split>/<class>.jsonl is {"id", "class", "wrong", "right"}: "right" is the original sentence and
"wrong" has exactly one injected error (or, for "clean", none). Documents are split into dev and test by id hash, so
no document feeds both. Tune on dev only.
"""

import argparse
import hashlib
import json
import random
import re
from pathlib import Path

LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
WORD = re.compile(rf"^[{LETTERS}]+(?:'[{LETTERS}]+)?$")
TURKISH_TO_ASCII = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜ])")
BAD = re.compile(r"[=|{}\[\]<>@#*_/\\]|https?:|\d{3,}| (the|of|and|is|was|in|to|with) ", re.IGNORECASE)
NOT_TURKISH_SUFFIX = {"s", "t", "d", "m", "ll", "re", "ve"}

JOIN_PAIRS = [("bir", "şey"), ("her", "şey"), ("ya", "da"), ("şu", "an"), ("bir", "şeyler"), ("her", "şeyi"),
              ("bir", "şeyi"), ("her", "zaman"), ("bu", "gün"), ("pek", "çok"), ("bir", "an"), ("o", "an")]
SPLIT_WORDS = {"hiçbir": ("hiç", "bir"), "birçok": ("bir", "çok"), "birkaç": ("bir", "kaç"),
               "herhangi": ("her", "hangi"), "hiçbiri": ("hiç", "biri"), "birbirine": ("bir", "birine"),
               "birbirinden": ("bir", "birinden"), "hiçbirinin": ("hiç", "birinin"), "birçoğu": ("bir", "çoğu"),
               "birdenbire": ("birden", "bire"), "birtakım": ("bir", "takım"), "herkes": ("her", "kes")}
KI_JOINED = ["oysaki", "halbuki", "mademki", "sanki", "meğerki", "illaki", "belki"]
MI = re.compile(r"^m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae])?$")
LOCATIVE = re.compile(r"^(.{3,})(d[ae]|t[ae])$")
KEYBOARD = ["qwertyuıopğü", "asdfghjklşi", "zxcvbnmöç"]


def lower_tr(word: str) -> str:
    return word.replace("I", "ı").replace("İ", "i").lower()


def neighbors() -> dict[str, str]:
    near = {}
    for r, row in enumerate(KEYBOARD):
        for c, key in enumerate(row):
            found = ""
            for rr, cc in [(r, c - 1), (r, c + 1), (r - 1, c), (r - 1, c + 1), (r + 1, c), (r + 1, c - 1)]:
                if 0 <= rr < len(KEYBOARD) and 0 <= cc < len(KEYBOARD[rr]):
                    found += KEYBOARD[rr][cc]
            near[key] = found
    return near


NEAR = neighbors()


def split_of(doc_id: str) -> str:
    return "dev" if int(hashlib.md5(("split" + doc_id).encode()).hexdigest(), 16) % 2 == 0 else "test"


def sentences(path: Path):
    for line in open(path):
        doc = json.loads(line)
        for paragraph in doc["text"].split("\n"):
            for sentence in SENTENCE_SPLIT.split(paragraph.strip()):
                words = sentence.split()
                if 6 <= len(words) <= 35 and not BAD.search(sentence) and sentence[-1] in ".!?":
                    yield doc["id"], sentence


def load_lexicon(path: Path) -> dict[str, int]:
    counts = {}
    for line in open(path):
        word, count, _ = line.rstrip("\n").split("\t")
        counts[word] = int(count)
    return counts


def bare(token: str) -> tuple[str, str, str]:
    """Splits leading and trailing punctuation off a whitespace token."""
    match = re.match(rf"^([^{LETTERS}]*)(.*?)([^{LETTERS}]*)$", token)
    return match.group(1), match.group(2), match.group(3)


def corrupt(cls: str, sentence: str, rng: random.Random, lexicon: dict[str, int]) -> str | None:
    tokens = sentence.split(" ")
    parts = [bare(token) for token in tokens]
    core = [p[1] for p in parts]
    lows = [lower_tr(w) for w in core]
    order = list(range(len(tokens)))
    rng.shuffle(order)

    def rebuild(i: int, new_core: str) -> list[str]:
        return tokens[:i] + [parts[i][0] + new_core + parts[i][2]] + tokens[i + 1 :]

    if cls == "ascii_word":
        for i in order:
            if WORD.match(core[i]) and core[i].translate(TURKISH_TO_ASCII) != core[i]:
                return " ".join(rebuild(i, core[i].translate(TURKISH_TO_ASCII)))
    elif cls == "ascii_sentence":
        if sentence.translate(TURKISH_TO_ASCII) != sentence:
            return sentence.translate(TURKISH_TO_ASCII)
    elif cls == "split_join":
        for i in order:
            if i + 1 < len(tokens) and not parts[i][2] and not parts[i + 1][0] and (lows[i], lows[i + 1]) in JOIN_PAIRS:
                return " ".join(tokens[:i] + [parts[i][0] + core[i] + core[i + 1] + parts[i + 1][2]] + tokens[i + 2 :])
            if lows[i] in SPLIT_WORDS and core[i][0].islower():
                first, second = SPLIT_WORDS[lows[i]]
                return " ".join(rebuild(i, first + " " + second))
    elif cls in ("mi", "ki", "de_da_join"):
        for i in order:
            if i == 0 or parts[i - 1][2] or parts[i][0] or not WORD.match(core[i - 1]):
                continue
            hit = (cls == "mi" and MI.match(lows[i])) or (cls == "ki" and lows[i] == "ki") or (
                cls == "de_da_join" and lows[i] in ("de", "da") and core[i - 1][0].islower())
            if hit:
                joined = parts[i - 1][0] + core[i - 1] + core[i] + parts[i][2]
                return " ".join(tokens[: i - 1] + [joined] + tokens[i + 1 :])
        if cls == "ki":
            for i in order:
                if lows[i] in KI_JOINED and core[i][0].islower():
                    return " ".join(rebuild(i, core[i][:-2] + " " + core[i][-2:]))
    elif cls == "de_da_split":
        for i in order:
            match = LOCATIVE.match(lows[i]) if WORD.match(core[i]) and "'" not in core[i] else None
            if match and lexicon.get(match.group(1), 0) >= 1000 and core[i][0].islower():
                return " ".join(rebuild(i, core[i][: -2] + " " + core[i][-2:]))
    elif cls == "apostrophe":
        for i in order:
            if "'" in core[i] and core[i][0].isupper() and WORD.match(core[i]) and i > 0 and (
                    core[i].split("'")[1] not in NOT_TURKISH_SUFFIX):
                return " ".join(rebuild(i, core[i].replace("'", "")))
    elif cls == "typo":
        for i in order:
            word = lows[i]
            if not WORD.match(core[i]) or len(word) < 4 or core[i][0].isupper() or "'" in word:
                continue
            for _ in range(10):
                kind = rng.choice(["sub", "del", "ins", "swap"])
                p = rng.randrange(1, len(word))
                if kind == "sub" and NEAR.get(word[p]):
                    new = word[:p] + rng.choice(NEAR[word[p]]) + word[p + 1 :]
                elif kind == "del":
                    new = word[:p] + word[p + 1 :]
                elif kind == "ins" and NEAR.get(word[p]):
                    new = word[:p] + rng.choice(NEAR[word[p]]) + word[p:]
                elif kind == "swap" and p + 1 < len(word):
                    new = word[:p] + word[p + 1] + word[p] + word[p + 2 :]
                else:
                    continue
                if new != word and new not in lexicon:
                    return " ".join(rebuild(i, new))
    elif cls == "clean":
        return sentence
    return None


CLASSES = {"ascii_word": 400, "ascii_sentence": 200, "split_join": 300, "mi": 300, "ki": 300,
           "de_da_join": 300, "de_da_split": 300, "apostrophe": 300, "typo": 400, "clean": 2000}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--heldout", default="data/work/heldout.jsonl")
    parser.add_argument("--lexicon", default="data/work/unigrams.tsv")
    parser.add_argument("--out", default="bench")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    lexicon = load_lexicon(Path(args.lexicon))
    pool = {"dev": [], "test": []}
    for doc_id, sentence in sentences(Path(args.heldout)):
        pool[split_of(doc_id)].append(sentence)
    for split, items in pool.items():
        rng.shuffle(items)
        used: set[str] = set()
        directory = Path(args.out) / split
        directory.mkdir(parents=True, exist_ok=True)
        for cls, wanted in CLASSES.items():
            rows = []
            for sentence in items:
                if len(rows) >= wanted:
                    break
                if sentence in used:
                    continue
                wrong = corrupt(cls, sentence, rng, lexicon)
                if wrong is None or (cls != "clean" and wrong == sentence):
                    continue
                used.add(sentence)
                rows.append({"id": f"{split}-{cls}-{len(rows)}", "class": cls, "wrong": wrong, "right": sentence})
            with open(directory / f"{cls}.jsonl", "w") as file:
                for row in rows:
                    file.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(split, cls, len(rows), f"(pool {len(items)})")


if __name__ == "__main__":
    main()
