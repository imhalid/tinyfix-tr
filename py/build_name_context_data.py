"""Mine strictly non-heldout ambiguous Turkish proper-name disambiguation examples from
Turkish Wikipedia (`data/raw/trwiki/*.parquet`) and OpenSubtitles (`data/raw/opensubs/tr.part.txt`).

Strictly excludes:
  - Wikipedia held-out docs: `is_heldout(doc_id, 50)` (`md5(doc_id) % 50 == 0`)
  - OpenSubtitles held-out lines: `line_idx % 50 == 0` (source of `bench/conversation/clean.jsonl`)

Design:
  1. Target vocabulary is STRICTLY the curated `AMBIG` stems in `data/rules/names.tsv` (no noisy
     auto-mined pronouns/common words like `ben`, `sen`, `yeni`, `gün`, `adam`, `devlet`).
  2. Combines:
     - Natural common-noun AND proper-name occurrences of every `AMBIG` stem from Wikipedia & OpenSubtitles.
     - Phonologically-exact **person-name substitution** positives: takes real standalone unambiguous
       person-name contexts from OpenSubtitles & Wikipedia ("Telefonu Mehmet açtı", "Hafta sonu
       Burak'la sahile gittik", "Mesaj atınca Zeynep hemen cevap verdi") and substitutes an `AMBIG`
       given name with exact Turkish vowel harmony & consonant voicing!
     - Phonologically-exact **place-name substitution** positives: takes real standalone unambiguous
       Turkish city/district contexts ("Yarın İzmir'e gidiyoruz", "Antalya'da tatil yaptık") and
       substitutes an `AMBIG` place name ("Çeşme'ye", "Bodrum'da", "Moda'da", "Bebek'te", "Kemer'e")!
  3. Enforces **strict per-word 50/50 positive/negative balance** (separately for bare and suffixed
     forms) so `ContextScorerV3` CANNOT memorize a negative unigram shortcut for everyday words
     like `can`, `barış`, `özlem`, `bahar`, `deniz`, `gül`, `pınar`, `çeşme`, and MUST disambiguate
     purely from Turkish sentence syntax and semantics!

Writes `data/work/name_context/{train.npz, valid.npz, train.jsonl, valid.jsonl}`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import shlex
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import clean_text, lower_tr  # noqa: E402
from build_tokenizer import SubwordTokenizer, upper_tr  # noqa: E402
from context_arch import FEATURE_DIM, LEFT_SUB, RIGHT_SUB, SPAN_SUB  # noqa: E402

MAX_CANDIDATES = 8
KIND_NAME = 5

LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû"
WORD_RE = re.compile(rf"[{LETTERS}]+(?:['’][{LETTERS}]+)?")
ASCII_STRIP = str.maketrans("çğıöşüÇĞİÖŞÜâîûÂÎÛ", "cgiosuCGIOSUaiuAIU")
MARKS_SET = set("çğıöşüÇĞİÖŞÜ")
BACK_VOWELS = set("aıouâû")
FRONT_VOWELS = set("eiöüî")
ROUND_VOWELS = set("ouöüû")
VOICELESS = set("fstkçşhp")
SOFTENING_FINAL = set("pçtk")
VOWELS = BACK_VOWELS | FRONT_VOWELS

# Case / genitive / instrumental / -ki suffixes (matches src/sentence.ts Step 8f exactly; excludes 1sg/3sg possessives)
PROPER_SUFFIX_RE = re.compile(
    r"^(?:n?[ıiuü]n|[dt][ae]n?|[dt][ae]ki|n?[ıiuü]nki|y?l[ae]|y?[aeıiuü])$"
)

HONORIFIC_OR_KIN = {
    "bey", "hanım", "efendi", "paşa", "ağa", "beyefendi", "hanımefendi", "hoca", "usta", "öğretmen",
    "abla", "abi", "ağabey", "hala", "teyze", "amca", "dayı", "enişte", "yenge", "dede", "nine",
}
PRE_TITLES = {
    "dr", "prof", "doç", "av", "op", "uzm", "bay", "bayan", "sayın", "albay", "general",
    "cumhurbaşkanı", "başbakan", "bakan", "vali", "kaymakam", "müdür", "başkan", "doktor",
    "avukat", "hâkim", "hakim", "savcı", "kaptan", "komiser", "mimar", "sultan", "kral",
}
INST_OR_GEO_HEADS = {
    "üniversitesi", "fakültesi", "enstitüsü", "lisesi", "koleji", "okulu", "hastanesi",
    "bakanlığı", "kurumu", "kurulu", "meclisi", "belediyesi", "partisi", "derneği", "vakfı",
    "bankası", "ajansı", "federasyonu", "birliği", "komutanlığı", "müdürlüğü", "başkanlığı",
    "dağı", "dağları", "gölü", "denizi", "okyanusu", "nehri", "ırmağı", "boğazı", "körfezi",
    "kanalı", "mahallesi", "caddesi", "sokağı", "bulvarı", "meydanı", "parkı", "sarayı",
    "köprüsü", "kulesi", "camisi", "camii", "cumhuriyeti", "devleti", "imparatorluğu",
    "krallığı", "savaşı", "antlaşması", "bayramı", "günü", "dönemi", "çağı", "devri",
    "kuvvetleri", "ordusu", "gazetesi", "dergisi", "tiyatrosu", "müzesi", "kulübü", "spor",
}
INVERSE_FRONT = {"kemal", "cemal", "hilal", "bilal", "nihal", "zuhal", "hayal", "celal", "istiklal", "resul", "saat"}

# Unambiguous Turkish & subtitle person names whose standalone occurrences give rich, natural person contexts!
DONOR_PERSONS = {
    # Turkish person names
    "ahmet", "mehmet", "ayşe", "fatma", "ali", "mustafa", "zeynep", "merve", "burak", "selin",
    "kerem", "elif", "hasan", "hüseyin", "murat", "kemal", "ibrahim", "yusuf", "ömer", "ece",
    "ceren", "kaan", "cem", "seda", "derya", "esra", "gamze", "pelin", "sinan", "volkan",
    "serkan", "tolga", "büşra", "kübra", "hakan", "gökhan", "okan", "kadir", "recep", "osman",
    "orhan", "levent", "metin", "selim", "tarık", "furkan", "halil", "ismail", "sibel", "tuğba",
    "tuğçe", "dilara", "melis", "irem", "beyza", "hande", "ebru", "nihan", "funda", "ozan",
    "emrah", "serdar", "serhat", "tamer", "taner", "alper", "berkay", "batuhan", "cenk", "cengiz",
    "ferhat", "harun", "ilker", "koray", "mert", "nihat", "oğuz", "samet", "semih", "sinem",
    "şeyma", "kübra", "cansu", "aylin", "ayla", "burcu", "ceyda", "didem", "meltem", "nalan",
    "neslihan", "nuray", "özge", "selma", "serap", "tülay", "yeliz", "zehra", "filiz", "banu",
    # High-frequency everyday dialogue names in Turkish OpenSubtitles (always human referents!)
    "jack", "sarah", "david", "michael", "rachel", "peter", "tom", "lisa", "sam", "alex",
    "claire", "kate", "paul", "eric", "mike", "luke", "emma", "anna", "mary", "john",
    "harry", "frank", "george", "charlie", "danny", "ryan", "kevin", "brian", "chris", "steve",
    "nick", "bob", "joe", "billy", "tommy", "jimmy", "johnny", "tony", "eddie", "henry",
    "walter", "arthur", "edward", "robert", "richard", "william", "james", "charles", "thomas",
    "daniel", "matthew", "andrew", "martin", "simon", "victor", "maria", "elena", "laura",
    "julia", "sofia", "alice", "emily", "helen", "susan", "linda", "karen", "nancy", "betty",
    "grace", "chloe", "hannah", "olivia", "sophie", "megan", "molly", "jenny", "lucy", "amy",
    "mia", "jake", "josh", "kyle", "adam", "noah", "liam", "ethan", "aaron", "jason", "justin",
    "scott", "alan", "carl", "gary", "larry", "terry", "jerry", "barry", "jeff", "greg",
    "ross", "joey", "chandler", "monica", "phoebe", "ted", "marshall", "lily", "barney",
}

# Unambiguous Turkish cities/districts whose standalone occurrences give natural place contexts!
DONOR_PLACES = {
    "istanbul", "ankara", "izmir", "antalya", "bursa", "adana", "konya", "trabzon", "eskişehir",
    "gaziantep", "samsun", "kayseri", "erzurum", "diyarbakır", "muğla", "marmaris", "fethiye",
    "alanya", "kuşadası", "ayvalık", "alaçatı", "kadıköy", "beşiktaş", "üsküdar", "taksim",
    "bakırköy", "sarıyer", "beyoğlu", "nişantaşı", "şişli", "pendik", "maltepe", "ataşehir",
    "çankaya", "karşıyaka", "bornova", "alsancak", "çanakkale", "edirne", "sakarya", "kocaeli",
    "tekirdağ", "balıkesir", "manisa", "denizli", "ısparta", "burdur", "hatay", "mersin",
    "şanlıurfa", "mardin", "gaziantep", "malatya", "elazığ", "sivas", "nevşehir", "kapadokya",
    "rize", "artvin", "giresun", "sinop", "kastamonu", "zonguldak", "bolu", "düzce",
}

# Ambiguous place names in AMBIG
AMBIG_PLACES = {
    "afyon", "ağrı", "aydın", "bebek", "bodrum", "boğaz", "çeşme", "kartal", "kaş",
    "kemer", "konak", "mısır", "moda", "ordu", "tokat", "tuzla", "uşak", "van",
}

# Extra everyday Turkish given names that are in AMBIG but might not be tagged GIVEN
EXTRA_AMBIG_GIVEN = {"su", "masal", "nergis", "rüzgar", "çınar", "doğuş", "aşkın"}


def cap_tr(word: str) -> str:
    return upper_tr(word[0]) + word[1:] if word else word


def is_heldout(doc_id: str, every: int = 50) -> bool:
    return int(hashlib.md5(doc_id.encode()).hexdigest(), 16) % every == 0


def is_valid_split(doc_key: str, every: int = 20) -> bool:
    return int(hashlib.md5(("val:" + doc_key).encode()).hexdigest(), 16) % every == 0


def last_vowel(word: str) -> str | None:
    for ch in reversed(word):
        if ch in VOWELS:
            return ch
    return None


def follows_harmony(stem: str, vowel: str) -> bool:
    lv = last_vowel(stem)
    if not lv:
        return True
    if stem in INVERSE_FRONT:
        if vowel in ("a", "e"):
            return vowel == "e"
        return vowel in ("i", "ü")
    back = lv in BACK_VOWELS
    rnd = lv in ROUND_VOWELS
    if vowel in ("a", "e"):
        return (vowel == "a") == back
    want = ("u" if rnd else "ı") if back else ("ü" if rnd else "i")
    return vowel == want


def is_valid_proper_suffix(stem: str, suf: str) -> bool:
    if not suf or not PROPER_SUFFIX_RE.match(suf):
        return False
    vowel_final = stem[-1] in VOWELS
    if vowel_final:
        if suf[0] in VOWELS and stem[-1] != "e":
            return False
        if suf.startswith(("la", "le", "t")):
            return False
    else:
        if suf.startswith(("n", "y")):
            return False
        if suf[0] == "d" and stem[-1] in VOICELESS:
            return False
        if suf[0] == "t" and stem[-1] not in VOICELESS:
            return False
    first_v = next((c for c in suf if c in "aeıioöuü"), None)
    if first_v and not follows_harmony(stem, first_v):
        return False
    return True


def parse_case_tag(suf: str) -> str | None:
    """Maps a Turkish proper-name inflectional suffix to a case tag for phonological transfer."""
    if not suf:
        return ""
    if re.fullmatch(r"y?[ae]", suf):
        return "DAT"
    if re.fullmatch(r"y?[ıiuü]", suf):
        return "ACC"
    if re.fullmatch(r"n?[ıiuü]n", suf):
        return "GEN"
    if re.fullmatch(r"[dt][ae]", suf):
        return "LOC"
    if re.fullmatch(r"[dt][ae]n", suf):
        return "ABL"
    if re.fullmatch(r"y?l[ae]", suf):
        return "INS"
    if re.fullmatch(r"[dt][ae]ki", suf):
        return "LOCKI"
    if re.fullmatch(r"n?[ıiuü]nki", suf):
        return "GENKI"
    return None


def inflect_proper_tr(stem: str, case_tag: str) -> str | None:
    """Produces the exact phonologically valid Turkish suffix for `stem` + `case_tag`."""
    if case_tag == "":
        return ""
    lv = last_vowel(stem)
    if not lv:
        return None
    if stem in INVERSE_FRONT:
        a = "e"
        i = "ü" if lv in ROUND_VOWELS else "i"
    else:
        back = lv in BACK_VOWELS
        rnd = lv in ROUND_VOWELS
        a = "a" if back else "e"
        i = ("u" if rnd else "ı") if back else ("ü" if rnd else "i")
    vf = stem[-1] in VOWELS
    dt = "t" if stem[-1] in VOICELESS else "d"
    if case_tag == "DAT":
        return ("y" if vf else "") + a
    if case_tag == "ACC":
        return ("y" if vf else "") + i
    if case_tag == "GEN":
        return ("n" if vf else "") + i + "n"
    if case_tag == "LOC":
        return dt + a
    if case_tag == "ABL":
        return dt + a + "n"
    if case_tag == "INS":
        return ("y" if vf else "") + "l" + a
    if case_tag == "LOCKI":
        return dt + a + "ki"
    if case_tag == "GENKI":
        return ("n" if vf else "") + i + "nki"
    return None


def load_lexicon_stats(unigrams_path: Path) -> tuple[dict[str, int], dict[str, float]]:
    counts: dict[str, int] = {}
    cap_share: dict[str, float] = {}
    with open(unigrams_path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            form, cnt, caps = parts[0], int(parts[1]), int(parts[2])
            counts[form] = cnt
            if cnt > 0 and caps > 0:
                cap_share[form] = min(1.0, caps / cnt)
    return counts, cap_share


def load_names_metadata(names_tsv: Path) -> tuple[dict[str, str], set[str]]:
    """Returns STRICTLY (ambig_display_map, given_set) from `data/rules/names.tsv`."""
    ambig: dict[str, str] = {}
    given: set[str] = set()
    for line in names_tsv.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        low, disp, _, _, sec = parts[:5]
        if sec == "AMBIG":
            ambig[low] = disp
        elif sec == "GIVEN":
            given.add(low)
    given |= EXTRA_AMBIG_GIVEN
    return ambig, given


def extract_morph_bits(words: list[str], cmd: str) -> dict[str, int]:
    if not words:
        return {}
    proc = subprocess.run(
        shlex.split(cmd),
        input="\n".join(words) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    bits: dict[str, int] = {}
    for line in proc.stdout.splitlines():
        if "\t" not in line:
            continue
        w, b = line.split("\t", 1)
        bits[w] = int(b)
    return bits


def build_name_features(
    cands: list[str],
    proper_flags: list[bool],
    base: str,
    suf: str,
    at_start: bool,
    ascii_ctx: int,
    counts: dict[str, int],
    cap_share: dict[str, float],
    given: set[str],
    morph_bits: dict[str, int],
) -> np.ndarray:
    """Computes [MAX_CANDIDATES, 26] features bit-identical to src/context.ts:buildContextFeatures(kind='name')."""
    feats = np.zeros((MAX_CANDIDATES, FEATURE_DIM), dtype=np.float32)
    log_counts = [math.log(counts.get(lower_tr(c), 0) + 1.0) for c in cands]
    max_lc = max(log_counts) if log_counts else 0.0
    stem_cap = cap_share.get(base, 0.0)
    if suf:
        c_apos = counts.get(f"{base}'{suf}", 0)
        c_join = counts.get(f"{base}{suf}", 0)
        apos_share = c_apos / (c_apos + c_join + 1.0)
    else:
        apos_share = 0.0
    is_given = 1.0 if base in given else 0.0
    is_other = 0.0 if base in given else 1.0
    at_start_f = 1.0 if at_start else 0.0

    for j, c in enumerate(cands):
        lc = log_counts[j]
        low = lower_tr(c)
        bits = morph_bits.get(low, 0)
        feats[j, 0] = lc / 15.0
        feats[j, 1] = (lc - max_lc) / 10.0
        feats[j, 2] = lc / 15.0
        feats[j, 3] = 0.0
        feats[j, 4] = 1.0 if any(ch in MARKS_SET for ch in c) else 0.0
        feats[j, 5] = float(ascii_ctx)
        # Slots 6..9 and 18 remain 0.0 -> uniquely identifies kind == "name"!
        for b in range(8):
            feats[j, 10 + b] = float((bits >> b) & 1)
        feats[j, 19] = 1.0 if proper_flags[j] else 0.0
        feats[j, 20] = 1.0 if "'" in c else 0.0
        feats[j, 21] = stem_cap
        feats[j, 22] = apos_share
        feats[j, 23] = is_given
        feats[j, 24] = is_other
        feats[j, 25] = at_start_f
    return feats


def match_ambig_token(
    raw: str,
    ambig: dict[str, str],
    ambig_set: set[str],
    ambig_prefixes: dict[str, list[str]],
    counts: dict[str, int],
) -> tuple[str, str, str, bool] | None:
    """Checks if `raw` is a bare or inflected `AMBIG` token. Returns `(base, disp, suf, is_proper)`."""
    if not raw or len(raw) < 2:
        return None
    if raw.isupper() and len(raw) >= 2:
        return None
    norm = raw.replace("’", "'")
    apos = norm.find("'")
    if apos > 0:
        stem_raw = norm[:apos]
        suf_raw = norm[apos + 1 :]
        if not stem_raw or not suf_raw:
            return None
        if not stem_raw[0].isupper() or stem_raw.isupper():
            return None
        stem_low = lower_tr(stem_raw)
        suf_low = lower_tr(suf_raw)
        if stem_low not in ambig_set:
            return None
        if not is_valid_proper_suffix(stem_low, suf_low):
            return None
        # Skip non-softening forms ("Umut'a" -> "umuta") since core Step 8e handles them deterministically.
        if stem_low[-1] in SOFTENING_FINAL and suf_low[0] in VOWELS and counts.get(stem_low + suf_low, 0) < 5:
            return None
        return stem_low, ambig[stem_low], suf_low, True

    is_cap = norm[0].isupper()
    low = lower_tr(norm)
    if low in ambig_set:
        return low, ambig[low], "", is_cap

    if len(low) >= 4:
        cands = ambig_prefixes.get(low[:3])
        if cands:
            for base in cands:
                if len(base) >= len(low) or not low.startswith(base):
                    continue
                suf = low[len(base) :]
                if not is_valid_proper_suffix(base, suf):
                    continue
                if counts.get(low, 0) < 3:
                    continue
                return base, ambig[base], suf, False
    return None


def match_donor_token(raw: str, donor_set: set[str]) -> tuple[str, str] | None:
    """Matches a capitalized standalone donor name (bare or apostrophe-suffixed). Returns `(donor_low, case_tag)`."""
    if not raw or len(raw) < 2 or not raw[0].isupper() or raw.isupper():
        return None
    norm = raw.replace("’", "'")
    apos = norm.find("'")
    if apos > 0:
        stem_raw = norm[:apos]
        suf_raw = norm[apos + 1 :]
        if not stem_raw or not suf_raw or not stem_raw[0].isupper() or stem_raw.isupper():
            return None
        stem_low = lower_tr(stem_raw)
        if stem_low not in donor_set:
            return None
        case_tag = parse_case_tag(lower_tr(suf_raw))
        if case_tag is None:
            return None
        return stem_low, case_tag
    low = lower_tr(norm)
    if low in donor_set:
        return low, ""
    return None


def iter_examples_from_text(
    text: str,
    source: str,
    ambig: dict[str, str],
    ambig_set: set[str],
    ambig_prefixes: dict[str, list[str]],
    ambig_given_list: list[str],
    ambig_place_list: list[str],
    counts: dict[str, int],
    rng: random.Random,
    want_donor_person: bool,
    want_donor_place: bool,
):
    words = [(m.start(), m.end(), m.group()) for m in WORD_RE.finditer(text)]
    if len(words) < 4:
        return
    cap_ratio = sum(1 for _, _, w in words if w[0].isupper()) / len(words)
    if cap_ratio > 0.55 and len(words) >= 6:
        return

    for i, (start, end, raw) in enumerate(words):
        if i == 0:
            at_start = True
        else:
            gap = text[words[i - 1][1] : start]
            at_start = any(ch in ".!?\n" for ch in gap)

        prev_raw = words[i - 1][2] if i > 0 and text[words[i - 1][1] : start] == " " else ""
        next_raw = words[i + 1][2] if i + 1 < len(words) and text[end : words[i + 1][0]] == " " else ""
        prev_low = lower_tr(prev_raw) if prev_raw else ""
        next_low = lower_tr(next_raw) if next_raw else ""

        has_cap_neighbor = False
        if prev_raw and (
            (prev_raw[0].isupper() and i > 1 and not any(c in ".!?\n" for c in text[words[i - 2][1] : words[i - 1][0]]))
            or prev_low in PRE_TITLES
        ):
            has_cap_neighbor = True
        if next_raw and (next_raw[0].isupper() or next_low in HONORIFIC_OR_KIN or next_low in INST_OR_GEO_HEADS):
            has_cap_neighbor = True

        # 1. Natural AMBIG occurrence (both positive and negative)
        matched = match_ambig_token(raw, ambig, ambig_set, ambig_prefixes, counts)
        if matched is not None:
            base, disp, suf, is_proper = matched
            if at_start and not suf:
                continue
            if not is_proper:
                if next_low in HONORIFIC_OR_KIN or prev_low in PRE_TITLES:
                    continue
                if source == "subs" and next_raw and next_raw[0].isupper() and not next_raw.isupper():
                    continue
            if is_proper and has_cap_neighbor and rng.random() > 0.08:
                continue

            if suf:
                common_cand = cap_tr(base + suf) if at_start else (base + suf)
                proper_cand = f"{disp}'{suf}"
            else:
                common_cand = base
                proper_cand = disp
            if common_cand != proper_cand:
                yield {
                    "left": text[max(0, start - 140) : start],
                    "right": text[end : min(len(text), end + 100)],
                    "base": base,
                    "disp": disp,
                    "suf": suf,
                    "common": common_cand,
                    "proper": proper_cand,
                    "is_proper": is_proper,
                    "at_start": at_start,
                    "source": source,
                    "synthetic_sub": False,
                }
            continue

        # 2. Standalone Donor Person / Place Substitution -> high-quality natural positives for AMBIG names!
        if has_cap_neighbor:
            continue

        if want_donor_person:
            dp = match_donor_token(raw, DONOR_PERSONS)
            if dp is not None:
                _, case_tag = dp
                if at_start and not case_tag:
                    continue
                # Sample an AMBIG given name that supports this case_tag cleanly
                for _ in range(4):
                    target = rng.choice(ambig_given_list)
                    suf = inflect_proper_tr(target, case_tag)
                    if suf is None:
                        continue
                    # For suffixed forms, skip non-softening stems ("umuta", "çiçeke") handled by Step 8e
                    if suf and target[-1] in SOFTENING_FINAL and suf[0] in VOWELS and counts.get(target + suf, 0) < 5:
                        continue
                    disp = ambig[target]
                    common_cand = (cap_tr(target + suf) if at_start else (target + suf)) if suf else target
                    proper_cand = f"{disp}'{suf}" if suf else disp
                    if common_cand == proper_cand:
                        continue
                    yield {
                        "left": text[max(0, start - 140) : start],
                        "right": text[end : min(len(text), end + 100)],
                        "base": target,
                        "disp": disp,
                        "suf": suf,
                        "common": common_cand,
                        "proper": proper_cand,
                        "is_proper": True,
                        "at_start": at_start,
                        "source": source,
                        "synthetic_sub": True,
                    }
                    break
                continue

        if want_donor_place:
            dpl = match_donor_token(raw, DONOR_PLACES)
            if dpl is not None:
                _, case_tag = dpl
                if at_start and not case_tag:
                    continue
                for _ in range(4):
                    target = rng.choice(ambig_place_list)
                    suf = inflect_proper_tr(target, case_tag)
                    if suf is None:
                        continue
                    if suf and target[-1] in SOFTENING_FINAL and suf[0] in VOWELS and counts.get(target + suf, 0) < 5:
                        continue
                    disp = ambig[target]
                    common_cand = (cap_tr(target + suf) if at_start else (target + suf)) if suf else target
                    proper_cand = f"{disp}'{suf}" if suf else disp
                    if common_cand == proper_cand:
                        continue
                    yield {
                        "left": text[max(0, start - 140) : start],
                        "right": text[end : min(len(text), end + 100)],
                        "base": target,
                        "disp": disp,
                        "suf": suf,
                        "common": common_cand,
                        "proper": proper_cand,
                        "is_proper": True,
                        "at_start": at_start,
                        "source": source,
                        "synthetic_sub": True,
                    }
                    break


def encode_sub_fixed(tok: SubwordTokenizer, text: str, length: int, align_right: bool) -> np.ndarray:
    ids = tok.encode(text)
    ids = ids[-length:] if align_right else ids[:length]
    out = np.zeros(length, dtype=np.uint16)
    if align_right:
        out[length - len(ids) :] = ids
    else:
        out[: len(ids)] = ids
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="data/raw/trwiki")
    parser.add_argument("--subtitles", default="data/raw/opensubs/tr.part.txt")
    parser.add_argument("--unigrams", default="data/work/unigrams_conv.tsv")
    parser.add_argument("--names", default="data/rules/names.tsv")
    parser.add_argument("--vocab", default="data/work/context_v3_clean/vocab.txt")
    parser.add_argument("--out", default="data/work/name_context")
    parser.add_argument("--max-per-word-bucket", type=int, default=260, help="cap per (word, has_suf, is_proper)")
    parser.add_argument("--max-subs-lines", type=int, default=2_200_000)
    parser.add_argument("--max-wiki-docs", type=int, default=90_000)
    parser.add_argument("--ascii-aug", type=float, default=0.10)
    parser.add_argument("--morph-cmd", default="node scripts/extract-morph-features.ts")
    parser.add_argument("--seed", type=int, default=19)
    args = parser.parse_args()

    t0 = time.time()
    rng = random.Random(args.seed)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    counts, cap_share = load_lexicon_stats(Path(args.unigrams))
    ambig, given = load_names_metadata(Path(args.names))
    ambig_set = set(ambig.keys())
    ambig_given_list = sorted(w for w in ambig_set if w in given)
    ambig_place_list = sorted(w for w in ambig_set if w in AMBIG_PLACES)
    ambig_prefixes: dict[str, list[str]] = {}
    for w in sorted(ambig_set, key=len, reverse=True):
        ambig_prefixes.setdefault(w[:3], []).append(w)

    print(
        f"Loaded {len(counts):,} unigrams, {len(ambig):,} strict AMBIG stems "
        f"({len(ambig_given_list)} given, {len(ambig_place_list)} places)",
        flush=True,
    )

    # Pools keyed by split -> (word, has_suf, is_proper) -> list[dict]
    pools: dict[str, dict[tuple[str, bool, bool], list[dict]]] = {
        "train": defaultdict(list),
        "valid": defaultdict(list),
    }
    max_pool = {"train": int(args.max_per_word_bucket * 1.4), "valid": 35}

    def add_ex(ex: dict, split: str) -> None:
        key = (ex["base"], bool(ex["suf"]), ex["is_proper"])
        lst = pools[split][key]
        cap = max_pool[split]
        # Prefer natural occurrences over synthetic substitutions when pool is full
        if len(lst) < cap:
            lst.append(ex)
        elif not ex["synthetic_sub"]:
            # Replace a random synthetic entry if any
            idx = rng.randrange(cap)
            if lst[idx]["synthetic_sub"]:
                lst[idx] = ex

    # --- Pass 1: OpenSubtitles (everyday conversational Turkish — strictly skipping line_idx % 50 == 0!) ---
    subs_path = Path(args.subtitles)
    if subs_path.is_file():
        print(f"Mining OpenSubtitles ({subs_path}, up to {args.max_subs_lines:,} lines)...", flush=True)
        with open(subs_path, encoding="utf-8", errors="ignore") as f:
            for idx, line in enumerate(f):
                if idx >= args.max_subs_lines:
                    break
                if idx % 50 == 0:
                    continue  # strictly held-out (source of bench/conversation/clean.jsonl)
                text = line.strip()
                if len(text) < 20 or len(text) > 220:
                    continue
                split = "valid" if is_valid_split(f"sub:{idx}") else "train"
                # Subsample donor substitutions slightly to keep mining fast while saturating all AMBIG stems
                for ex in iter_examples_from_text(
                    text, "subs", ambig, ambig_set, ambig_prefixes,
                    ambig_given_list, ambig_place_list, counts, rng,
                    want_donor_person=True, want_donor_place=True,
                ):
                    add_ex(ex, split)
                if (idx + 1) % 500_000 == 0:
                    tr_n = sum(len(v) for v in pools["train"].values())
                    print(f"  subs line {idx + 1:,}: raw_train_pool={tr_n:,} ({time.time() - t0:.1f}s)", flush=True)

    # --- Pass 2: Turkish Wikipedia (strictly skipping md5(doc_id) % 50 == 0!) ---
    parquets = sorted(Path(args.raw).glob("*.parquet"))
    print(f"Mining Turkish Wikipedia ({len(parquets)} shards, up to {args.max_wiki_docs:,} docs)...", flush=True)
    docs_seen = 0
    for pq_path in parquets:
        if docs_seen >= args.max_wiki_docs:
            break
        pf = pq.ParquetFile(pq_path)
        for batch in pf.iter_batches(batch_size=1024, columns=["id", "text"]):
            ids_col = batch.column("id").to_pylist()
            texts_col = batch.column("text").to_pylist()
            for doc_id, raw_text in zip(ids_col, texts_col):
                if docs_seen >= args.max_wiki_docs:
                    break
                doc_id_s = str(doc_id)
                if is_heldout(doc_id_s, 50):
                    continue  # strictly held-out!
                docs_seen += 1
                split = "valid" if is_valid_split(f"wiki:{doc_id_s}") else "train"
                text = clean_text(raw_text)
                for para in text.split("\n"):
                    para = para.strip()
                    if len(para) < 35:
                        continue
                    for ex in iter_examples_from_text(
                        para, "wiki", ambig, ambig_set, ambig_prefixes,
                        ambig_given_list, ambig_place_list, counts, rng,
                        want_donor_person=(rng.random() < 0.35),
                        want_donor_place=(rng.random() < 0.35),
                    ):
                        add_ex(ex, split)
            if docs_seen % 30_000 == 0:
                tr_n = sum(len(v) for v in pools["train"].values())
                print(f"  wiki docs={docs_seen:,}: raw_train_pool={tr_n:,} ({time.time() - t0:.1f}s)", flush=True)

    # --- Pass 3: Strict per-word 50/50 positive/negative balancing! ---
    rows: dict[str, list[dict]] = {"train": [], "valid": []}
    for split in ("train", "valid"):
        cap_side = args.max_per_word_bucket if split == "train" else 20
        for w in sorted(ambig_set):
            for has_suf in (False, True):
                pos_list = pools[split].get((w, has_suf, True), [])
                neg_list = pools[split].get((w, has_suf, False), [])
                if not pos_list and not neg_list:
                    continue
                rng.shuffle(pos_list)
                rng.shuffle(neg_list)
                # Prefer mixing subs & wiki cleanly (roughly 60/40 if available)
                def take_balanced_src(lst: list[dict], limit: int) -> list[dict]:
                    if len(lst) <= limit:
                        return lst
                    subs_part = [x for x in lst if x["source"] == "subs"]
                    wiki_part = [x for x in lst if x["source"] == "wiki"]
                    want_s = min(len(subs_part), int(limit * 0.62))
                    want_w = min(len(wiki_part), limit - want_s)
                    rem = limit - want_s - want_w
                    if rem > 0:
                        if len(subs_part) - want_s >= rem:
                            want_s += rem
                        else:
                            want_w = min(len(wiki_part), want_w + rem)
                    return subs_part[:want_s] + wiki_part[:want_w]

                # Balance pos vs neg strictly per (word, has_suf) within 1.25x so no word has a runaway prior!
                if pos_list and neg_list:
                    n_min = min(len(pos_list), len(neg_list), cap_side)
                    pos_lim = min(len(pos_list), cap_side, max(n_min, int(len(neg_list) * 1.25)))
                    neg_lim = min(len(neg_list), cap_side, max(n_min, int(len(pos_list) * 1.25)))
                    rows[split].extend(take_balanced_src(pos_list, pos_lim))
                    rows[split].extend(take_balanced_src(neg_list, neg_lim))
                elif neg_list:
                    # Purely-common-only AMBIG stem (e.g. non-given non-place): keep small negative sample
                    rows[split].extend(take_balanced_src(neg_list, min(len(neg_list), 25 if split == "train" else 4)))
        rng.shuffle(rows[split])

    # Print diagnostics for key Turkish ambiguous names
    print(f"Balanced splits: train={len(rows['train']):,}, valid={len(rows['valid']):,}", flush=True)
    diag = Counter()
    for r in rows["train"]:
        diag[(r["base"], bool(r["suf"]), r["is_proper"], r["synthetic_sub"])] += 1
    for b in ("can", "barış", "deniz", "bahar", "özlem", "gül", "pınar", "çeşme", "bodrum", "kemer"):
        sub_d = {k[1:]: v for k, v in diag.items() if k[0] == b}
        print(f"  train[{b:7s}]: {sub_d}", flush=True)

    # Extract morphology bits for all unique candidate forms
    all_forms: set[str] = set()
    for split in ("train", "valid"):
        for r in rows[split]:
            all_forms.add(lower_tr(r["common"]))
            all_forms.add(lower_tr(r["proper"]))
    print(f"Extracting morphology bits for {len(all_forms):,} unique candidate forms...", flush=True)
    morph_bits = extract_morph_bits(sorted(all_forms), args.morph_cmd)

    tok = SubwordTokenizer.load(args.vocab)

    for split in ("train", "valid"):
        split_rows = rows[split]
        n = len(split_rows)
        left_arr = np.zeros((n, LEFT_SUB), dtype=np.uint16)
        right_arr = np.zeros((n, RIGHT_SUB), dtype=np.uint16)
        cand_arr = np.zeros((n, MAX_CANDIDATES, SPAN_SUB), dtype=np.uint16)
        feat_arr = np.zeros((n, MAX_CANDIDATES, FEATURE_DIM), dtype=np.float32)
        count_arr = np.full(n, 2, dtype=np.uint8)
        label_arr = np.zeros(n, dtype=np.uint8)
        kind_arr = np.full(n, KIND_NAME, dtype=np.uint8)
        ascii_arr = np.zeros(n, dtype=np.uint8)
        subtype_arr = np.zeros(n, dtype=np.uint8)

        jsonl_path = out_dir / f"{split}.jsonl"
        with open(jsonl_path, "w", encoding="utf-8") as jf:
            for idx, r in enumerate(split_rows):
                left_s = r["left"]
                right_s = r["right"]
                is_ascii = 0
                if split == "train" and rng.random() < args.ascii_aug:
                    left_s = left_s.translate(ASCII_STRIP)
                    right_s = right_s.translate(ASCII_STRIP)
                    is_ascii = 1
                ascii_arr[idx] = is_ascii

                # 50/50 candidate ordering so model cannot rely on candidate slot index
                if rng.random() < 0.5:
                    cands = [r["common"], r["proper"]]
                    proper_flags = [False, True]
                    lbl = 1 if r["is_proper"] else 0
                else:
                    cands = [r["proper"], r["common"]]
                    proper_flags = [True, False]
                    lbl = 0 if r["is_proper"] else 1

                left_arr[idx] = encode_sub_fixed(tok, left_s, LEFT_SUB, align_right=True)
                right_arr[idx] = encode_sub_fixed(tok, right_s, RIGHT_SUB, align_right=False)
                for j, c in enumerate(cands):
                    cand_arr[idx, j] = encode_sub_fixed(tok, c, SPAN_SUB, align_right=False)
                feat_arr[idx] = build_name_features(
                    cands, proper_flags, r["base"], r["suf"], r["at_start"], is_ascii,
                    counts, cap_share, given, morph_bits,
                )
                label_arr[idx] = lbl
                subtype_arr[idx] = (2 if r["is_proper"] else 0) + (1 if r["suf"] else 0)
                jf.write(json.dumps(r, ensure_ascii=False) + "\n")

        npz_path = out_dir / f"{split}.npz"
        np.savez_compressed(
            npz_path,
            left=left_arr,
            right=right_arr,
            candidates=cand_arr,
            features=feat_arr,
            count=count_arr,
            label=label_arr,
            kind=kind_arr,
            ascii_ctx=ascii_arr,
            subtype=subtype_arr,
        )
        pos_n = sum(1 for r in split_rows if r["is_proper"])
        suf_n = sum(1 for r in split_rows if r["suf"])
        sub_n = sum(1 for r in split_rows if r["source"] == "subs")
        syn_n = sum(1 for r in split_rows if r["synthetic_sub"])
        print(
            f"Wrote {npz_path}: n={n:,} (pos={pos_n:,} [{100*pos_n/max(1,n):.1f}%], "
            f"suf={suf_n:,} [{100*suf_n/max(1,n):.1f}%], subs={sub_n:,}, donor_sub={syn_n:,})",
            flush=True,
        )

    print(f"Done in {time.time() - t0:.1f}s.", flush=True)


if __name__ == "__main__":
    main()
