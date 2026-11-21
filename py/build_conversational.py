"""Add conversational word forms (from subtitles) to the Wikipedia lexicon, without adopting common misspellings.

Wikipedia has almost no first- or second-person forms ("ilettim", "yorumumu", "geliyorum"), so the corrector takes
valid everyday words for typos. Subtitles have them, but they also have errors ("seyehat", "herşey"). A subtitle form
is accepted only when:
  - it is seen at least --min-count times,
  - it is not a listed misspelling (data/rules/known.tsv, also with a suffix),
  - no form one edit or one Turkish mark away is --dominance times more common (that makes it a likely slip).
Accepted forms that Wikipedia has fewer than --keep-wiki-above times get the larger of their Wikipedia count and their
subtitle count scaled to Wikipedia's size. Everything else keeps its Wikipedia count. Word pairs are not taken from subtitles: they get "bende" / "ben de" wrong too often.

Every --heldout-every'th line is never counted; a sample of those becomes bench/conversation/clean.jsonl, a set of
everyday sentences for measuring false alarms.

Writes data/work/unigrams_conv.tsv (same format as unigrams.tsv) and data/work/conversational_stats.json.
"""

import argparse
import collections
import json
import random
import re
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import TOKEN, lower_tr, words_with_flags  # noqa: E402

ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyz"
TOGGLE = {"c": "ç", "g": "ğ", "i": "ı", "o": "ö", "s": "ş", "u": "ü", "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u"}
SENTENCE_END = {".", "!", "?", ":", "\n"}
PARTICLE_ONLY = re.compile(r"^(ki|d[ae]|m[ıiuü](?:y?[ıiuü]m|s[ıiuü]n|y?[ıiuü]z|s[ıiuü]n[ıiuü]z|d[ıiuü]r|d[ıiuü]|ym[ıiuü]ş|ys[ae])?)$")
PARTICLE_END = re.compile(r"^(.{2,}?)(ki|d[ae]|t[ae]|m[ıiuü](?:y?[ıiuü]m|s[ıiuü]n|y?[ıiuü]z|s[ıiuü]n[ıiuü]z|d[ıiuü]r|d[ıiuü]|ym[ıiuü]ş|ys[ae])?)$")
ASCII_SIDE = set("cgiosu")


def mark_variants(word: str):
    """The word with any of its c/g/i/o/s/u turned into ç/ğ/ı/ö/ş/ü (up to 256 forms)."""
    positions = [i for i, ch in enumerate(word) if ch in ASCII_SIDE][:8]
    for mask in range(1, 2 ** len(positions)):
        chars = list(word)
        for bit, position in enumerate(positions):
            if mask >> bit & 1:
                chars[position] = TOGGLE[chars[position]]
        yield "".join(chars)


def neighbors(word: str):
    """Forms one edit or one mark away."""
    for i in range(len(word) + 1):
        a, b = word[:i], word[i:]
        if b:
            yield a + b[1:]
            if len(b) > 1:
                yield a + b[1] + b[0] + b[2:]
            if b[0] in TOGGLE:
                yield a + TOGGLE[b[0]] + b[1:]
            for c in ALPHABET:
                if c != b[0]:
                    yield a + c + b[1:]
        for c in ALPHABET:
            yield a + c + b


def count_lines(lines):
    """Word counts, mid-sentence capital counts, and counts of a word followed by a separate particle ("geldin mi")."""
    counts, caps, particle_pairs = collections.Counter(), collections.Counter(), collections.Counter()
    for line in lines:
        previous = None
        for item in words_with_flags(line, clean=True):
            if item is None:
                previous = None
                continue
            word, is_cap = item
            counts[word] += 1
            if is_cap:
                caps[word] += 1
            if previous is not None and PARTICLE_ONLY.match(word):
                particle_pairs[previous + word] += 1
            previous = word
    return counts, caps, particle_pairs


def filter_with_morphology(words: list[str], cmd: str) -> tuple[set[str], set[str]]:
    """Runs the repo's morphology validator; returns (valid_words, pure_verb_words)."""
    if not words:
        return set(), set()
    proc = subprocess.run(
        shlex.split(cmd),
        input="\n".join(words) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    valid, pure_verbs = set(), set()
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        w = parts[0].strip()
        valid.add(w)
        if len(parts) > 1 and parts[1].strip() == "V":
            pure_verbs.add(w)
    return valid, pure_verbs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--subtitles", default="data/raw/opensubs/tr.part.txt")
    parser.add_argument("--unigrams", default="data/work/unigrams.tsv")
    parser.add_argument("--known", default="data/rules/known.tsv")
    parser.add_argument("--out", default="data/work/unigrams_conv.tsv")
    parser.add_argument("--bench", default="bench/conversation")
    parser.add_argument("--min-count", type=int, default=5)
    parser.add_argument("--dominance", type=float, default=50)
    parser.add_argument("--heldout-every", type=int, default=50)
    parser.add_argument("--keep-wiki-above", type=int, default=20)
    parser.add_argument("--mark-dominance", type=float, default=5)
    parser.add_argument("--glued-ratio", type=float, default=3)
    parser.add_argument("--trust-count", type=int, default=30)
    parser.add_argument("--bench-size", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=3)
    parser.add_argument("--morph-cmd", default="node scripts/check-morphology.ts")
    parser.add_argument("--no-morphology", action="store_true", help="skip morphology validation of subtitle forms")
    args = parser.parse_args()

    wiki, wiki_caps = {}, {}
    for line in open(args.unigrams):
        word, count, caps = line.rstrip("\n").split("\t")
        wiki[word], wiki_caps[word] = int(count), int(caps)
    wiki_total = sum(wiki.values())
    wrong_forms = [line.split("\t")[0] for line in open(args.known) if line and not line.startswith("#")]
    wrong_single = {w for w in wrong_forms if " " not in w}
    wrong_stems = sorted((w for w in wrong_single if len(w) >= 4), key=len, reverse=True)

    counted, heldout = [], []
    with open(args.subtitles, errors="replace") as file:
        for index, line in enumerate(file):
            line = line.strip().lstrip("-# ").strip()
            if not line:
                continue
            (heldout if index % args.heldout_every == 0 else counted).append(line)
    print(f"{len(counted):,} lines counted, {len(heldout):,} held out", flush=True)
    sub, sub_caps, separate = count_lines(counted)
    sub_total = sum(sub.values())
    scale = wiki_total / sub_total
    print(f"{sub_total:,} subtitle words, {len(sub):,} forms; scale {scale:.2f}", flush=True)

    def is_listed_misspelling(word: str) -> bool:
        return word in wrong_single or any(word.startswith(stem) and len(word) - len(stem) <= 6 for stem in wrong_stems)

    def combined(word: str) -> float:
        return wiki.get(word, 0) + scale * sub.get(word, 0)

    eligible_words = [
        word
        for word, count in sub.items()
        if count >= args.min_count and (word.isalpha() or "'" in word)
    ]
    if args.no_morphology:
        morph_valid, pure_verbs = None, set()
    else:
        morph_valid, pure_verbs = filter_with_morphology(eligible_words, args.morph_cmd)
        print(f"morphology accepted {len(morph_valid):,}/{len(eligible_words):,} subtitle forms ({len(pure_verbs):,} pure verbs)", flush=True)

    accepted, rejected = {}, collections.Counter()
    for word, count in sub.items():
        if count < args.min_count or not word.isalpha() and "'" not in word:
            continue
        if is_listed_misspelling(word):
            rejected["listed misspelling"] += 1
            continue
        # Reject morphologically invalid forms from subtitles ("farkettim", "terketti", OCR noise like "nasıı"),
        # so frequent subtitle misspellings cannot enter unigrams_conv.tsv even when above --trust-count.
        if morph_valid is not None and word not in morph_valid:
            rejected["invalid morphology"] += 1
            continue
        # Subtitles often glue particles on ("diyorki", "gelecekmisin"). A form that could be a word plus a particle is
        # taken only when subtitles write it as one word clearly more often than as two: "olduğumu" (one word) yes,
        # "gelebilirmiyim" (usually "gelebilir miyim") no. de/da forms are never taken: "bende" is both a word and a
        # common misspelling of "ben de", and the counts can't tell them apart.
        particle = PARTICLE_END.match(word)
        if particle and wiki.get(particle.group(1), 0) >= 5 and wiki.get(word, 0) < args.keep_wiki_above:
            is_de_da = particle.group(2) in ("de", "da", "te", "ta")
            if is_de_da or sub[word] < args.glued_ratio * separate.get(word, 0):
                rejected["glued particle"] += 1
                continue
        mine = combined(word)
        # Typed without Turkish letters ("karimla", "yazicidan") when a marked form is clearly more common.
        if any(combined(other) >= args.mark_dominance * mine for other in mark_variants(word)):
            rejected["missing Turkish letters"] += 1
            continue
        # A rare form next to a far more common one is probably a slip ("seyehat"). A form seen often is kept even then:
        # Turkish forms one letter apart are often both real ("yatıyorsun" / "yaşıyorsun", "olmuştun" / "olmuştur").
        if sub[word] < args.trust_count and any(combined(other) >= args.dominance * mine for other in set(neighbors(word)) if other != word and (other in wiki or other in sub)):
            rejected["dominated by a near form"] += 1
            continue
        accepted[word] = count
    print(f"accepted {len(accepted):,}, rejected {dict(rejected)}", flush=True)

    new_forms = 0
    with open(args.out, "w") as out:
        merged = dict(wiki)
        for word, count in accepted.items():
            if word not in merged:
                new_forms += 1
            # Words Wikipedia already knows well keep their Wikipedia count: subtitle counts would distort the ratios
            # that splits and joins compare ("bende" is common in subtitles partly as a misspelling of "ben de",
            # while pair counts stay Wikipedia's). Subtitles only fill in forms Wikipedia barely has.
            if wiki.get(word, 0) < args.keep_wiki_above:
                merged[word] = max(wiki.get(word, 0), round(scale * count))
        for word, count in sorted(merged.items(), key=lambda item: -item[1]):
            w_count = wiki.get(word, 0)
            w_caps = wiki_caps.get(word, 0)
            boosted = word in accepted and w_count < args.keep_wiki_above
            if boosted:
                caps = max(w_caps, round(scale * sub_caps.get(word, 0)))
            elif (
                word in pure_verbs
                and word in accepted
                and w_count >= args.keep_wiki_above
                and sub[word] >= 50
                and sub_caps.get(word, 0) / sub[word] < 0.1
                and w_caps / w_count >= 0.4
            ):
                # Pure inflected verbs ("geliyorum", "gördün", "yaparım") appear mostly in capitalized titles on
                # Wikipedia; blend with subtitle capitalization so they are not mistaken for proper nouns.
                caps = round(count * (w_caps + sub_caps.get(word, 0)) / (w_count + sub[word]))
            else:
                caps = w_caps
            out.write(f"{word}\t{count}\t{caps}\n")

    rng = random.Random(args.seed)
    candidates = [line for line in heldout if 5 <= len(line.split()) <= 30 and line[-1] in ".!?" and not re.search(r"[#@<>{}\[\]|]", line)]
    rng.shuffle(candidates)
    bench = Path(args.bench)
    bench.mkdir(parents=True, exist_ok=True)
    with open(bench / "clean.jsonl", "w") as file:
        for i, line in enumerate(candidates[: args.bench_size]):
            file.write(json.dumps({"id": f"conv-clean-{i}", "class": "clean", "wrong": line, "right": line}, ensure_ascii=False) + "\n")
    with open(Path(args.out).with_name("subtitle_counts.tsv"), "w") as file:
        for word, count in sub.most_common():
            if count < 2:
                break
            file.write(f"{word}\t{count}\n")
    stats = {"subtitle_words": sub_total, "subtitle_forms": len(sub), "accepted": len(accepted), "new_forms": new_forms, "rejected": dict(rejected), "scale": scale}
    Path("data/work/conversational_stats.json").write_text(json.dumps(stats, indent=2))
    print(stats)


if __name__ == "__main__":
    main()
