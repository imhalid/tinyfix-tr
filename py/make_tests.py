"""Build frozen dev and test sets from held-out Wikipedia documents, one error class at a time.

Each line of bench/<split>/<class>.jsonl is {"id", "class", "wrong", "right"}: "right" is the original sentence and
"wrong" has exactly one injected error (or, for "clean" and "apostrophe_no", none). Documents are split into dev and
test by id hash, so no document feeds both. Tune on dev only.
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

# --- split_join subcategories ---
# 1. Classic high-frequency function/determiner phrases.
JOIN_PAIRS = {
    ("bir", "şey"), ("her", "şey"), ("ya", "da"), ("şu", "an"), ("bir", "şeyler"), ("her", "şeyi"),
    ("bir", "şeyi"), ("her", "zaman"), ("bu", "gün"), ("pek", "çok"), ("bir", "an"), ("o", "an"),
}
SPLIT_WORDS = {
    "hiçbir": ("hiç", "bir"), "birçok": ("bir", "çok"), "birkaç": ("bir", "kaç"),
    "herhangi": ("her", "hangi"), "hiçbiri": ("hiç", "biri"), "birbirine": ("bir", "birine"),
    "birbirinden": ("bir", "birinden"), "hiçbirinin": ("hiç", "birinin"), "birçoğu": ("bir", "çoğu"),
    "birdenbire": ("birden", "bire"), "birtakım": ("bir", "takım"), "herkes": ("her", "kes"),
    "biraz": ("bir", "az"), "birazdan": ("bir", "azdan"), "gitgide": ("git", "gide"),
    "bugünkü": ("bu", "günkü"), "bugüne": ("bu", "güne"), "bugünden": ("bu", "günden"),
}

# 2. Compound verbs (TDK separate vs joined across conjugations).
AUX_ET = re.compile(
    r"^(?:et(?:t[iı]|m[aeıi]|s[aei]|$)|ed(?:i(?:l|p|ş|yor)|e(?:c[ae][kğ]|rek|m[ae]|n(?:l[ae]r)?$|r|y[iı][mz]|bil|l[iı]m|s[iı]n)))"
)
AUX_OL = re.compile(
    r"^(?:ol(?:du(?:[kğmnsy]|l[ae]r|$)|m[au]|s[au]|u(?:p|r|n|yor)|a(?:c[ae][kğ]|m[au]|n|r(?:ak)?$|y[ıi][mz]|bil|l[ıi]m|s[ıi]n)|$))"
)
AUX_KIL_EYLE = re.compile(
    r"^(?:kıl(?:d[ıi]|m[aı]|s[aı]|a(?:c[ae][kğ]|n|r|bil)|ı(?:n|p|yor)|$)|eyle(?:d[iı]|m[ae](?:k|y|d|s|l|z|n|m|ğ|$)|r|s[aei]|y[aei]|n|$))"
)

SEPARATE_ET_STEMS = {
    "fark", "terk", "devam", "kabul", "dikkat", "merak", "kontrol", "takip", "iptal", "yardım",
    "teşekkür", "rica", "ifade", "ilan", "işaret", "iddia", "ihlal", "ikna", "ima", "imha",
    "inşa", "intikal", "ispat", "istifa", "istifade", "itiraz", "icra", "icat", "ihraç", "ithal",
    "idare", "ikamet", "ilave", "intihar", "iştirak", "izah", "mahkum", "maruz", "mecbur", "memnun",
    "meşgul", "muhafaza", "müdahale", "müsaade", "hak", "arz", "yok", "söz", "not", "göç",
    "park", "talep", "tahmin", "tercih", "teslim", "tespit", "teklif", "temsil", "teşvik", "tavsiye",
    "tedavi", "tehdit", "tekrar", "temin", "hareket", "hizmet", "davet", "ziyaret", "şikayet",
}
SEPARATE_OL_STEMS = {
    "neden", "sebep", "sahip", "destek", "engel", "hazır", "hasta", "memnun", "mutlu", "pişman",
    "razı", "şahit", "teslim", "üye", "var", "yok", "mezun", "dahil", "hakim", "mağdur",
    "maruz", "mecbur", "tabi", "talip", "faydalı", "etkili", "yardımcı", "kayıtlı", "bağlı",
}
SEPARATE_KIL_EYLE_STEMS = {"etkili", "mümkün", "zorunlu", "namaz", "nazar", "niyaz", "temaşa"}

# TDK joined compound verbs: (joined_prefix, split_first, aux_re) -> splits joined_prefix + rest into split_first + " " + rest.
JOINED_COMPOUND_VERBS: list[tuple[str, str, re.Pattern[str]]] = [
    ("vaz", "vaz", re.compile(r"^geç")),
    ("baş", "baş", re.compile(r"^vur")),
    ("var", "var", re.compile(r"^say")),
    ("ön", "ön", re.compile(r"^gör")),
    ("alı", "alı", re.compile(r"^koy")),
    ("aff", "af", AUX_ET),
    ("hiss", "his", AUX_ET),
    ("redd", "red", AUX_ET),
    ("hall", "hal", AUX_ET),
    ("zann", "zan", AUX_ET),
    ("kayb", "kayıp", re.compile(f"(?:{AUX_ET.pattern})|(?:{AUX_OL.pattern})")),
    ("kayd", "kayıt", re.compile(f"(?:{AUX_ET.pattern})|(?:{AUX_OL.pattern})")),
    ("seyr", "seyir", AUX_ET),
    ("emr", "emir", AUX_ET),
    ("haps", "hapis", AUX_ET),
    ("nakl", "nakil", AUX_ET),
    ("keşf", "keşif", AUX_ET),
    ("devr", "devir", re.compile(f"(?:{AUX_ET.pattern})|^al(?:[ıia]|d[ıi]|m[aı]|s[aı])")),
    ("sabr", "sabır", AUX_ET),
    ("şükr", "şükür", AUX_ET),
    ("bahs", "bahis", AUX_ET),
    ("feth", "fetih", AUX_ET),
]

# 3. Compound nouns/adjectives (TDK separate vs joined).
SEPARATE_COMPOUND_NOUNS = {
    ("hafta", "sonu"), ("hafta", "içi"), ("yurt", "içi"), ("yurt", "dışı"),
    ("iş", "yeri"), ("iş", "birliği"), ("hava", "yolu"), ("kara", "yolu"),
    ("demir", "yolu"), ("deniz", "yolu"), ("ön", "söz"), ("ana", "dil"),
    ("yer", "çekimi"), ("gün", "batımı"), ("gün", "doğumu"), ("gece", "yarısı"),
    ("öğle", "yemeği"), ("akşam", "yemeği"), ("ana", "cadde"), ("baş", "ağrısı"),
    ("el", "yazması"), ("boş", "zaman"), ("sağ", "ol"), ("hoş", "geldin"),
    ("hoş", "geldiniz"), ("hoş", "bulduk"), ("söz", "konusu"), ("göz", "önünde"),
    ("dil", "bilimi"), ("söz", "dizimi"), ("basın", "toplantısı"),
}
# Base stems (allowing lowercase Turkish inflectional suffixes on the second word).
JOINED_COMPOUND_NOUNS: dict[str, tuple[str, str]] = {
    "havaalanı": ("hava", "alanı"), "havalimanı": ("hava", "limanı"),
    "ilkokul": ("ilk", "okul"), "ortaokul": ("orta", "okul"), "anaokulu": ("ana", "okulu"),
    "başkent": ("baş", "kent"), "başbakan": ("baş", "bakan"), "başrol": ("baş", "rol"),
    "başyapıt": ("baş", "yapıt"), "başhekim": ("baş", "hekim"), "başyazar": ("baş", "yazar"),
    "büyükanne": ("büyük", "anne"), "büyükbaba": ("büyük", "baba"),
    "beyefendi": ("bey", "efendi"), "hanımefendi": ("hanım", "efendi"),
    "açgözlü": ("aç", "gözlü"), "gökyüzü": ("gök", "yüzü"), "yeryüzü": ("yer", "yüzü"),
    "ayakkabı": ("ayak", "kabı"), "bilgisayar": ("bilgi", "sayar"), "buzdolabı": ("buz", "dolabı"),
    "akşamüstü": ("akşam", "üstü"), "öğleüstü": ("öğle", "üstü"), "ayaküstü": ("ayak", "üstü"),
    "sırtüstü": ("sırt", "üstü"), "yüzüstü": ("yüz", "üstü"), "olağanüstü": ("olağan", "üstü"),
    "doğaüstü": ("doğa", "üstü"), "suçüstü": ("suç", "üstü"), "gözaltı": ("göz", "altı"),
    "bilinçaltı": ("bilinç", "altı"), "anayasa": ("ana", "yasa"), "anavatan": ("ana", "vatan"),
    "anayol": ("ana", "yol"), "öngörü": ("ön", "görü"), "özgüven": ("öz", "güven"),
    "özgeçmiş": ("öz", "geçmiş"), "milletvekili": ("millet", "vekili"),
    "cumhurbaşkanı": ("cumhur", "başkanı"), "gökkuşağı": ("gök", "kuşağı"),
    "gözyaşı": ("göz", "yaşı"), "denizaltı": ("deniz", "altı"), "günebakan": ("güne", "bakan"),
    "hanımeli": ("hanım", "eli"), "kuşburnu": ("kuş", "burnu"), "boşboğaz": ("boş", "boğaz"),
    "çokbilmiş": ("çok", "bilmiş"), "vurdumduymaz": ("vurdum", "duymaz"), "gecekondu": ("gece", "kondu"),
}

# 4. Reduplications (ikilemeler — TDK always separate; corrupt by joining).
REDUPLICATION_PAIRS = {
    ("yüz", "yüze"), ("yan", "yana"), ("arka", "arkaya"), ("art", "arda"),
    ("el", "ele"), ("göz", "göze"), ("baş", "başa"), ("iç", "içe"),
    ("üst", "üste"), ("peş", "peşe"), ("kol", "kola"), ("omuz", "omuza"),
    ("diz", "dize"), ("karşı", "karşıya"), ("ara", "sıra"), ("er", "geç"),
    ("aşağı", "yukarı"), ("ileri", "geri"), ("gece", "gündüz"), ("kendi", "kendine"),
    ("günden", "güne"), ("yıldan", "yıla"), ("elden", "ele"), ("dilden", "dile"),
    ("kulaktan", "kulağa"), ("baştan", "başa"), ("uçtan", "uca"), ("az", "çok"),
}
EXCLUDED_IDENTICAL_DUP = {"ve", "de", "da", "ki", "mi", "mı", "mu", "mü", "bir", "bu", "şu", "o", "ne", "ya"}

KI_JOINED = ["oysaki", "halbuki", "mademki", "sanki", "meğerki", "illaki", "belki"]
MI = re.compile(r"^m[iıuü](y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae])?$")
MUSIC_NOTES = {"do", "re", "mi", "fa", "sol", "la", "si"}
MUSIC_AFTER = {
    "majör", "minör", "major", "minor", "bemol", "diyez",
    "notası", "notasi", "anahtarı", "anahtari", "akor", "akoru", "gamı",
}
MI_TRAIL_OK = re.compile(r'^[.,!?;:"”\')…]*$')

LOCATIVE = re.compile(r"^(.{3,})(d[ae]|t[ae])$")
KEYBOARD = ["qwertyuıopğü", "asdfghjklşi", "zxcvbnmöç"]

BACK_VOWELS = set("aıouâû")
FRONT_VOWELS = set("eiöüî")
ROUND_VOWELS = set("ouöüû")

# --- TDK apostrophe classification ---
# Institution / organization head words whose possessive P3sg form takes NO apostrophe per TDK
# ("Ankara Üniversitesinde", "Adalet Partisinin", "Türk Dil Kurumundan").
INSTITUTION_HEADS = {
    "üniversitesi", "fakültesi", "enstitüsü", "yüksekokulu", "okulu", "lisesi", "ilkokulu", "ortaokulu",
    "koleji", "akademisi", "konservatuvarı", "kurumu", "kurulu", "kuruluşu", "bakanlığı", "başkanlığı",
    "müdürlüğü", "genelkurmayı", "komutanlığı", "ordusu", "donanması", "kuvvetleri", "meclisi",
    "parlamentosu", "senatosu", "hükümeti", "kabinesi", "partisi", "örgütü", "teşkilatı", "komisyonu",
    "komitesi", "konseyi", "konferansı", "kongresi", "federasyonu", "konfederasyonu", "derneği",
    "vakfı", "sendikası", "odası", "borsası", "cemiyeti", "kulübü", "takımı", "birliği", "ajansı",
    "bankası", "şirketi", "holdingi", "ortaklığı", "işletmesi", "fabrikası", "hastanesi", "kliniği",
    "belediyesi", "valiliği", "kaymakamlığı", "mahkemesi", "savcılığı", "barosu", "tiyatrosu",
    "operası", "balesi", "orkestrası", "müzesi", "kütüphanesi", "arşivi", "yayınları", "yayınevi",
    "matbaası", "gazetesi", "dergisi", "televizyonu", "radyosu", "kanalı", "stüdyosu", "merkezi",
    "laboratuvarı", "gözlemevi", "rasathanesi", "dairesi", "şubesi", "bölümü", "birimi", "müsteşarlığı",
    "elçiliği", "büyükelçiliği", "konsolosluğu", "temsilciliği", "misyonu", "vakıfları", "odaları",
}
# Exception explicitly granted an apostrophe by TDK ("Avrupa Birliği'ne").
TDK_INSTITUTION_APOSTROPHE_EXCEPTIONS = {("avrupa", "birliği")}
PLURAL_SUFFIX_RE = re.compile(r"^l[ae]r(?:$|[ıiuüae]|d[ae]n?|l[ae]|n[ıiuü]n)")
PLURAL_STEM_RE = re.compile(r"l[ae]r$")
INSTITUTION_NO_APOS_SUFFIX = re.compile(r"^(?:n?[ıiuü]n|nd[ae]n?|nd[ae]ki|n[aeıiuü]|y?l[ae])$")
PLURAL_NO_APOS_RE = re.compile(r"^(.*l[ae]r)(?:[ıiuü]n|d[ae]n?|d[ae]ki|[aeıiuü]|l[ae])$")


def lower_tr(word: str) -> str:
    return word.replace("I", "ı").replace("İ", "i").lower()


def last_vowel(word: str) -> str | None:
    for ch in reversed(word):
        if ch in BACK_VOWELS or ch in FRONT_VOWELS:
            return ch
    return None


def follows_mi_harmony(stem: str, particle: str) -> bool:
    last = last_vowel(stem)
    if not last:
        return True
    back = last in BACK_VOWELS
    rnd = last in ROUND_VOWELS
    want = ("u" if rnd else "ı") if back else ("ü" if rnd else "i")
    high = [ch for ch in particle if ch in "ıiuü"]
    return bool(high) and high[0] == want and all(ch == high[0] for ch in high)


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


def is_tdk_forbidden_apostrophe(stem: str, suffix: str, prev_low: str | None = None) -> str | None:
    """Returns 'plural' or 'institution' when TDK forbids an apostrophe on stem'suffix, else None."""
    low_stem = lower_tr(stem)
    low_suf = lower_tr(suffix)
    if PLURAL_STEM_RE.search(low_stem) or PLURAL_SUFFIX_RE.match(low_suf):
        return "plural"
    if low_stem in INSTITUTION_HEADS:
        if prev_low is not None and (prev_low, low_stem) in TDK_INSTITUTION_APOSTROPHE_EXCEPTIONS:
            return None
        return "institution"
    return None


def match_joined_compound_noun(word: str) -> tuple[str, str] | None:
    """Matches a TDK joined compound noun (optionally inflected) and returns (first, second_with_suffix)."""
    if word in JOINED_COMPOUND_NOUNS:
        return JOINED_COMPOUND_NOUNS[word]
    for base, (first, second) in JOINED_COMPOUND_NOUNS.items():
        if word.startswith(base) and len(word) > len(base):
            rest = word[len(base):]
            if len(rest) <= 8 and rest.isalpha() and rest.islower():
                return first, second + rest
    return None


def match_joined_compound_verb(word: str) -> tuple[str, str] | None:
    """Matches a TDK joined compound verb across conjugations and returns its erroneous split (first, aux)."""
    for prefix, split_first, aux_re in JOINED_COMPOUND_VERBS:
        if word.startswith(prefix) and len(word) >= len(prefix) + 2:
            rest = word[len(prefix):]
            if aux_re.match(rest):
                return split_first, rest
    return None


def is_separate_compound_verb(first: str, second: str) -> bool:
    if first in SEPARATE_ET_STEMS and AUX_ET.match(second):
        return True
    if first in SEPARATE_OL_STEMS and AUX_OL.match(second):
        return True
    if first in SEPARATE_KIL_EYLE_STEMS and AUX_KIL_EYLE.match(second):
        return True
    return False


def is_reduplication(first: str, second: str, lexicon: dict[str, int]) -> bool:
    if (first, second) in REDUPLICATION_PAIRS:
        return True
    return (
        first == second
        and len(first) >= 2
        and first not in EXCLUDED_IDENTICAL_DUP
        and lexicon.get(first, 0) >= 50
    )


def corrupt_split_join(
    tokens: list[str],
    parts: list[tuple[str, str, str]],
    core: list[str],
    lows: list[str],
    order: list[int],
    lexicon: dict[str, int],
    allowed_subtypes: set[str] | None = None,
) -> tuple[str, str] | None:
    """Returns (corrupted_sentence, subtype) across classic, compound_verb, compound_noun, and reduplication."""
    def ok(subtype: str) -> bool:
        return allowed_subtypes is None or subtype in allowed_subtypes

    def rebuild(i: int, new_core: str) -> str:
        return " ".join(tokens[:i] + [parts[i][0] + new_core + parts[i][2]] + tokens[i + 1 :])

    def glue_pair(i: int) -> str:
        return " ".join(tokens[:i] + [parts[i][0] + core[i] + core[i + 1] + parts[i + 1][2]] + tokens[i + 2 :])

    for i in order:
        can_pair = (
            i + 1 < len(tokens)
            and not parts[i][2]
            and not parts[i + 1][0]
            and WORD.match(core[i]) is not None
            and WORD.match(core[i + 1]) is not None
            and "'" not in core[i]
            and "'" not in core[i + 1]
            and core[i + 1][0].islower()
        )
        # 1. Compound verbs (separate -> joined, or joined -> split)
        if ok("compound_verb"):
            if can_pair and is_separate_compound_verb(lows[i], lows[i + 1]):
                return glue_pair(i), "compound_verb"
            if core[i] and core[i][0].islower() and WORD.match(core[i]) and "'" not in core[i]:
                cv = match_joined_compound_verb(lows[i])
                if cv is not None:
                    return rebuild(i, cv[0] + " " + cv[1]), "compound_verb"
        # 2. Compound nouns/adjectives (separate -> joined, or joined -> split)
        if ok("compound_noun"):
            if can_pair and (lows[i], lows[i + 1]) in SEPARATE_COMPOUND_NOUNS:
                return glue_pair(i), "compound_noun"
            if core[i] and core[i][0].islower() and WORD.match(core[i]) and "'" not in core[i]:
                cn = match_joined_compound_noun(lows[i])
                if cn is not None:
                    return rebuild(i, cn[0] + " " + cn[1]), "compound_noun"
        # 3. Reduplications / ikilemeler (always separate -> joined)
        if ok("reduplication") and can_pair and core[i][0].islower():
            if is_reduplication(lows[i], lows[i + 1], lexicon):
                return glue_pair(i), "reduplication"
        # 4. Classic determiner/function pairs and splits
        if ok("classic"):
            if can_pair and (lows[i], lows[i + 1]) in JOIN_PAIRS:
                return glue_pair(i), "classic"
            if lows[i] in SPLIT_WORDS and core[i] and core[i][0].islower():
                first, second = SPLIT_WORDS[lows[i]]
                return rebuild(i, first + " " + second), "classic"
    return None


def corrupt(
    cls: str,
    sentence: str,
    rng: random.Random,
    lexicon: dict[str, int],
    allowed_subtypes: set[str] | None = None,
) -> tuple[str, str] | None:
    """Returns (wrong, right) for one sentence under `cls`, or None if no suitable site exists."""
    tokens = sentence.split(" ")
    parts = [bare(token) for token in tokens]
    core = [p[1] for p in parts]
    lows = [lower_tr(w) for w in core]
    order = list(range(len(tokens)))
    rng.shuffle(order)

    def rebuild(i: int, new_core: str) -> str:
        return " ".join(tokens[:i] + [parts[i][0] + new_core + parts[i][2]] + tokens[i + 1 :])

    if cls == "ascii_word":
        for i in order:
            if WORD.match(core[i]) and core[i].translate(TURKISH_TO_ASCII) != core[i]:
                return rebuild(i, core[i].translate(TURKISH_TO_ASCII)), sentence
    elif cls == "ascii_sentence":
        if sentence.translate(TURKISH_TO_ASCII) != sentence:
            return sentence.translate(TURKISH_TO_ASCII), sentence
    elif cls == "split_join":
        res = corrupt_split_join(tokens, parts, core, lows, order, lexicon, allowed_subtypes)
        if res is not None:
            return res[0], sentence
    elif cls in ("mi", "ki", "de_da_join"):
        for i in order:
            if i == 0 or parts[i - 1][2] or parts[i][0] or not WORD.match(core[i - 1]):
                continue
            if cls == "mi":
                if not MI.match(lows[i]):
                    continue
                # Exclude capitalized acronyms/codes ("MI6", "Mi-24", "Bana Mı") and hyphen/digit-attached tokens.
                if not core[i].islower() or not MI_TRAIL_OK.match(parts[i][2]):
                    continue
                if len(core[i - 1]) >= 2 and core[i - 1].isupper():
                    continue
                # Exclude musical note "mi" ("mi bemol", "mi minör", "re mi fa").
                if lows[i] == "mi":
                    if i + 1 < len(lows) and lows[i + 1] in MUSIC_AFTER:
                        continue
                    if lows[i - 1] in MUSIC_NOTES:
                        continue
                # Exclude the noun "müdür" (director) and disharmonious non-question tokens.
                if lows[i] == "müdür" and "?" not in sentence:
                    continue
                if not follows_mi_harmony(lows[i - 1], lows[i]):
                    continue
                hit = True
            elif cls == "ki":
                hit = lows[i] == "ki" and core[i].islower()
            else:
                hit = lows[i] in ("de", "da") and core[i].islower() and core[i - 1][0].islower()
            if hit:
                joined = parts[i - 1][0] + core[i - 1] + core[i] + parts[i][2]
                return " ".join(tokens[: i - 1] + [joined] + tokens[i + 1 :]), sentence
        if cls == "ki":
            for i in order:
                if lows[i] in KI_JOINED and core[i][0].islower():
                    return rebuild(i, core[i][:-2] + " " + core[i][-2:]), sentence
    elif cls == "de_da_split":
        for i in order:
            match = LOCATIVE.match(lows[i]) if WORD.match(core[i]) and "'" not in core[i] else None
            if match and lexicon.get(match.group(1), 0) >= 1000 and core[i][0].islower():
                return rebuild(i, core[i][:-2] + " " + core[i][-2:]), sentence
    elif cls == "apostrophe":
        for i in order:
            if "'" in core[i] and core[i][0].isupper() and WORD.match(core[i]) and i > 0:
                stem, suffix = core[i].split("'", 1)
                if suffix in NOT_TURKISH_SUFFIX:
                    continue
                prev_low = lows[i - 1] if i > 0 else None
                if is_tdk_forbidden_apostrophe(stem, suffix, prev_low) is not None:
                    continue
                return rebuild(i, core[i].replace("'", "")), sentence
    elif cls == "apostrophe_no":
        # TDK-forbidden apostrophe cases (institutions & -lar/-ler plurals): both wrong and right are the TDK-correct
        # form without apostrophe, so benchmark runs report TDK-violation rate (wrong-change) separately.
        for i in order:
            if i == 0 or not WORD.match(core[i]) or not core[i][0].isupper():
                continue
            prev_low = lows[i - 1]
            if "'" in core[i]:
                stem, suffix = core[i].split("'", 1)
                if suffix in NOT_TURKISH_SUFFIX:
                    continue
                if is_tdk_forbidden_apostrophe(stem, suffix, prev_low) is not None:
                    clean_sentence = rebuild(i, core[i].replace("'", ""))
                    return clean_sentence, clean_sentence
            else:
                low = lows[i]
                # Already written without apostrophe per TDK: institution P3sg+suffix or capitalized plural+suffix.
                matched_inst = any(
                    low.startswith(head)
                    and (prev_low, head) not in TDK_INSTITUTION_APOSTROPHE_EXCEPTIONS
                    and INSTITUTION_NO_APOS_SUFFIX.match(low[len(head):]) is not None
                    for head in INSTITUTION_HEADS
                )
                matched_plural = PLURAL_NO_APOS_RE.match(low) is not None and len(low) >= 7
                if matched_inst or matched_plural:
                    return sentence, sentence
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
                    return rebuild(i, new), sentence
    elif cls == "clean":
        return sentence, sentence
    return None


CLASSES = {
    "ascii_word": 400,
    "ascii_sentence": 200,
    "split_join": 300,
    "mi": 300,
    "ki": 300,
    "de_da_join": 300,
    "de_da_split": 300,
    "apostrophe": 300,
    "apostrophe_no": 200,
    "typo": 400,
    "clean": 2000,
}

SPLIT_JOIN_SUBTYPES = ("compound_verb", "compound_noun", "reduplication", "classic")


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
            if cls == "split_join":
                # Balance split_join across all four subcategories, then fill any remaining quota with any subtype.
                per_sub = wanted // len(SPLIT_JOIN_SUBTYPES)
                sub_counts = {s: 0 for s in SPLIT_JOIN_SUBTYPES}
                for sentence in items:
                    if len(rows) >= wanted:
                        break
                    if sentence in used:
                        continue
                    open_subs = {s for s, c in sub_counts.items() if c < per_sub}
                    if not open_subs:
                        open_subs = set(SPLIT_JOIN_SUBTYPES)
                    tokens = sentence.split(" ")
                    parts = [bare(token) for token in tokens]
                    core = [p[1] for p in parts]
                    lows = [lower_tr(w) for w in core]
                    order = list(range(len(tokens)))
                    rng.shuffle(order)
                    res = corrupt_split_join(tokens, parts, core, lows, order, lexicon, open_subs)
                    if res is None or res[0] == sentence:
                        continue
                    wrong, subtype = res
                    used.add(sentence)
                    sub_counts[subtype] += 1
                    rows.append({"id": f"{split}-{cls}-{len(rows)}", "class": cls, "subtype": subtype, "wrong": wrong, "right": sentence})
                # Second pass if any subtype fell short of its share
                if len(rows) < wanted:
                    for sentence in items:
                        if len(rows) >= wanted:
                            break
                        if sentence in used:
                            continue
                        tokens = sentence.split(" ")
                        parts = [bare(token) for token in tokens]
                        core = [p[1] for p in parts]
                        lows = [lower_tr(w) for w in core]
                        order = list(range(len(tokens)))
                        rng.shuffle(order)
                        res = corrupt_split_join(tokens, parts, core, lows, order, lexicon, None)
                        if res is None or res[0] == sentence:
                            continue
                        wrong, subtype = res
                        used.add(sentence)
                        sub_counts[subtype] += 1
                        rows.append({"id": f"{split}-{cls}-{len(rows)}", "class": cls, "subtype": subtype, "wrong": wrong, "right": sentence})
                with open(directory / f"{cls}.jsonl", "w") as file:
                    for row in rows:
                        file.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(split, cls, len(rows), sub_counts, f"(pool {len(items)})")
                continue

            for sentence in items:
                if len(rows) >= wanted:
                    break
                if sentence in used:
                    continue
                res = corrupt(cls, sentence, rng, lexicon)
                if res is None:
                    continue
                wrong, right = res
                if cls not in ("clean", "apostrophe_no") and wrong == right:
                    continue
                used.add(sentence)
                rows.append({"id": f"{split}-{cls}-{len(rows)}", "class": cls, "wrong": wrong, "right": right})
            with open(directory / f"{cls}.jsonl", "w") as file:
                for row in rows:
                    file.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(split, cls, len(rows), f"(pool {len(items)})")


if __name__ == "__main__":
    main()
