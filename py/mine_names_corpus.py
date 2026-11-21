"""Mine Turkish proper-name, acronym, person-name, surname, multi-word phrase, and ambiguous-word
statistics from strictly non-heldout Turkish Wikipedia (`data/raw/trwiki`) and OpenSubtitles
(`data/raw/opensubs/tr.part.txt`).

Outputs to `data/work/names_corpus/`:
  - word_stats.tsv    : word, wiki_cap_low, wiki_low_low, wiki_cap_cap, wiki_cap_num, wiki_allcap, subs_cap, subs_low, subs_allcap
  - first_names.tsv   : lowercase_first, display, count
  - surnames.tsv      : lowercase_surname, display, count
  - phrases.tsv       : lowercase_phrase, display, cap_count, apos_count, noapos_count
  - acronyms.tsv      : lowercase, upper, allcap_wiki, total_wiki, allcap_subs, total_subs
"""

from __future__ import annotations

import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_lexicon import CLEAN_TOKEN, LETTERS, SENTENCE_END, clean_text, documents, is_heldout, lower_tr  # noqa: E402
from build_tokenizer import upper_tr  # noqa: E402

OUT_DIR = Path("data/work/names_corpus")

# Biography & person-name anchor patterns
BIO_RE = re.compile(
    rf"(?<![{LETTERS}])([A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]{{1,18}})\s+([A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]{{1,20}})"
    rf"(?=\s*\((?:d\.\s*)?\d{{4}}|\s*,\s*(?:Türk|Osmanlı|İstanbul|Ankara|İzmir|gazeteci|yazar|şair|oyuncu|siyasetçi|akademisyen|doktor|avukat|mimar|ressam|müzisyen|şarkıcı|futbolcu|basketbolcu|voleybolcu|yönetmen|tarihçi|ekonomist|asker|general|bürokrat|hukukçu|bilim|profesör))"
)
TITLE_PERSON_RE = re.compile(
    rf"(?:Prof\.\s*Dr\.|Doç\.\s*Dr\.|Op\.\s*Dr\.|Uzm\.\s*Dr\.|Dr\.|Av\.|Cumhurbaşkanı|Başbakan|Bakan|Vali|Kaymakam|Albay|General|Orgeneral|Amiral|Mareşal|Yüzbaşı|Binbaşı|Komiser|Başkomiser|Hâkim|Savcı|Kaptan|Mimar|Dekan|Rektör)\s+"
    rf"([A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]{{1,18}})(?:\s+([A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]{{1,20}}))?"
)
HONORIFIC_PERSON_RE = re.compile(
    rf"(?<![{LETTERS}])([A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]{{1,18}})(?:\s+([A-ZÇĞİÖŞÜ][a-zçğıöşüâîû]{{1,20}}))?\s+(?:Bey|Hanım|Paşa|Efendi|Ağa)(?:['’][a-zçğıöşü]+)?(?![{LETTERS}])"
)

INTERNAL_LOWER = {"ve", "ile", "ya", "veya", "de", "da"}

# Suffixes that can follow a multi-word phrase's final head word (with or without apostrophe)
INFLECT_TAIL_RE = re.compile(
    r"^(.*?)(?:'([a-zçğıöşü]+))?$"
)


def is_cap_word(tok: str) -> bool:
    return len(tok) >= 2 and tok[0].isupper() and not tok.isupper() and tok[1:].islower()


def is_allcap_word(tok: str) -> bool:
    return len(tok) >= 2 and tok.isupper() and tok.isalpha()


def scan_wiki() -> dict:
    paths = sorted(Path("data/raw/trwiki").glob("*.parquet"))
    wiki_cap_low: Counter[str] = Counter()
    wiki_low_low: Counter[str] = Counter()
    wiki_cap_cap: Counter[str] = Counter()
    wiki_cap_num: Counter[str] = Counter()
    wiki_allcap: Counter[str] = Counter()
    wiki_total_mid: Counter[str] = Counter()
    display_form: dict[str, Counter[str]] = defaultdict(Counter)
    allcap_form: dict[str, Counter[str]] = defaultdict(Counter)

    first_names: Counter[str] = Counter()
    first_disp: dict[str, Counter[str]] = defaultdict(Counter)
    surnames: Counter[str] = Counter()
    surname_disp: dict[str, Counter[str]] = defaultdict(Counter)

    phrase_cap: Counter[str] = Counter()
    phrase_disp: dict[str, Counter[str]] = defaultdict(Counter)
    phrase_apos: Counter[str] = Counter()
    phrase_noapos: Counter[str] = Counter()

    t0 = time.time()
    n_docs = 0
    for index, (doc_id, raw_text) in enumerate(documents(paths)):
        if is_heldout(str(doc_id), 50):
            continue
        n_docs += 1
        if n_docs % 100000 == 0:
            print(f"[wiki] {n_docs:,} docs ({time.time()-t0:.1f}s)", file=sys.stderr, flush=True)

        text = clean_text(raw_text, cut_tail=True)

        # Person names from biography/title/honorific anchors
        for m in BIO_RE.finditer(text):
            f, s = m.group(1), m.group(2)
            fl, sl = lower_tr(f), lower_tr(s)
            first_names[fl] += 2
            first_disp[fl][f] += 2
            surnames[sl] += 2
            surname_disp[sl][s] += 2
        for m in TITLE_PERSON_RE.finditer(text):
            f, s = m.group(1), m.group(2)
            fl = lower_tr(f)
            first_names[fl] += 1
            first_disp[fl][f] += 1
            if s:
                sl = lower_tr(s)
                surnames[sl] += 1
                surname_disp[sl][s] += 1
        for m in HONORIFIC_PERSON_RE.finditer(text):
            f, s = m.group(1), m.group(2)
            fl = lower_tr(f)
            first_names[fl] += 1
            first_disp[fl][f] += 1
            if s:
                sl = lower_tr(s)
                surnames[sl] += 1
                surname_disp[sl][s] += 1

        # Token-level casing and multi-word capitalized phrase mining
        at_start = True
        prev_kind = "start"  # "start", "low", "cap", "num", "punct"
        cur_phrase: list[tuple[str, str, bool]] = []  # (raw_stem, lower_stem, had_apos)

        def flush_phrase():
            nonlocal cur_phrase
            # Trim trailing internal lowercase conjunctions
            while cur_phrase and cur_phrase[-1][1] in INTERNAL_LOWER and cur_phrase[-1][0][0].islower():
                cur_phrase.pop()
            if 2 <= len(cur_phrase) <= 6:
                low_key = " ".join(x[1] for x in cur_phrase)
                disp = " ".join(x[0] for x in cur_phrase)
                phrase_cap[low_key] += 1
                if len(phrase_disp[low_key]) < 4:
                    phrase_disp[low_key][disp] += 1
                if cur_phrase[-1][2]:
                    phrase_apos[low_key] += 1
                else:
                    phrase_noapos[low_key] += 1
            cur_phrase = []

        for raw in CLEAN_TOKEN.findall(text):
            first = raw[0]
            if not first.isalpha():
                flush_phrase()
                if first.isdigit():
                    at_start = False
                    prev_kind = "num"
                elif raw in SENTENCE_END:
                    at_start = True
                    prev_kind = "start"
                elif at_start and raw in '"(':
                    prev_kind = "start"
                else:
                    at_start = False
                    prev_kind = "punct"
                continue

            has_apos = ("'" in raw) or ("’" in raw)
            stem = raw.split("'")[0].split("’")[0]
            if not stem:
                flush_phrase()
                at_start = False
                prev_kind = "punct"
                continue

            low = lower_tr(stem)
            is_ac = is_allcap_word(stem)
            is_cp = (not is_ac) and stem[0].isupper()
            is_lo = stem[0].islower()

            if not at_start:
                wiki_total_mid[low] += 1
                if is_ac:
                    wiki_allcap[low] += 1
                    if len(allcap_form[low]) < 3:
                        allcap_form[low][stem] += 1
                elif is_cp:
                    if prev_kind == "low":
                        wiki_cap_low[low] += 1
                    elif prev_kind == "cap":
                        wiki_cap_cap[low] += 1
                    elif prev_kind == "num":
                        wiki_cap_num[low] += 1
                    if len(display_form[low]) < 3:
                        display_form[low][stem] += 1
                elif is_lo:
                    if prev_kind == "low":
                        wiki_low_low[low] += 1

                # Phrase tracking (strictly mid-sentence so sentence-start words don't pollute)
                if is_cp and is_cap_word(stem):
                    cur_phrase.append((stem, low, has_apos))
                    if has_apos:
                        flush_phrase()
                elif is_lo and low in INTERNAL_LOWER and cur_phrase and len(cur_phrase) <= 4:
                    cur_phrase.append((low, low, False))
                else:
                    flush_phrase()
            else:
                flush_phrase()

            at_start = False
            prev_kind = "cap" if (is_cp or is_ac) else "low"
        flush_phrase()

    print(f"[wiki] done {n_docs:,} docs in {time.time()-t0:.1f}s", file=sys.stderr, flush=True)
    return {
        "wiki_cap_low": wiki_cap_low,
        "wiki_low_low": wiki_low_low,
        "wiki_cap_cap": wiki_cap_cap,
        "wiki_cap_num": wiki_cap_num,
        "wiki_allcap": wiki_allcap,
        "wiki_total_mid": wiki_total_mid,
        "display_form": display_form,
        "allcap_form": allcap_form,
        "first_names": first_names,
        "first_disp": first_disp,
        "surnames": surnames,
        "surname_disp": surname_disp,
        "phrase_cap": phrase_cap,
        "phrase_disp": phrase_disp,
        "phrase_apos": phrase_apos,
        "phrase_noapos": phrase_noapos,
    }


def scan_opensubs(max_lines: int = 8_000_000) -> dict:
    subs_cap: Counter[str] = Counter()
    subs_low: Counter[str] = Counter()
    subs_allcap: Counter[str] = Counter()
    t0 = time.time()
    path = Path("data/raw/opensubs/tr.part.txt")
    if not path.is_file():
        return {"subs_cap": subs_cap, "subs_low": subs_low, "subs_allcap": subs_allcap}

    with open(path, encoding="utf-8", errors="ignore") as f:
        for idx, line in enumerate(f):
            if idx >= max_lines:
                break
            if idx % 50 == 0:
                continue
            if idx % 2_000_000 == 0 and idx > 0:
                print(f"[subs] {idx:,} lines ({time.time()-t0:.1f}s)", file=sys.stderr, flush=True)
            # Skip ALL-CAPS subtitle lines
            if line.isupper():
                continue
            at_start = True
            for raw in CLEAN_TOKEN.findall(line):
                first = raw[0]
                if not first.isalpha():
                    at_start = raw in SENTENCE_END or (at_start and raw in '"(-–—')
                    continue
                stem = raw.split("'")[0].split("’")[0]
                if not stem:
                    at_start = False
                    continue
                if not at_start:
                    low = lower_tr(stem)
                    if is_allcap_word(stem):
                        subs_allcap[low] += 1
                    elif stem[0].isupper():
                        subs_cap[low] += 1
                    else:
                        subs_low[low] += 1
                at_start = False

    print(f"[subs] done in {time.time()-t0:.1f}s", file=sys.stderr, flush=True)
    return {"subs_cap": subs_cap, "subs_low": subs_low, "subs_allcap": subs_allcap}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    w = scan_wiki()
    s = scan_opensubs()

    # 1. Write word_stats.tsv
    all_words = set(w["wiki_total_mid"].keys()) | set(s["subs_cap"].keys())
    rows = []
    for word in all_words:
        if len(word) < 2:
            continue
        wcl = w["wiki_cap_low"][word]
        wll = w["wiki_low_low"][word]
        wcc = w["wiki_cap_cap"][word]
        wcn = w["wiki_cap_num"][word]
        wac = w["wiki_allcap"][word]
        sc = s["subs_cap"][word]
        sl = s["subs_low"][word]
        sac = s["subs_allcap"][word]
        if wcl + wcc + wac + sc < 15:
            continue
        disp = w["display_form"][word].most_common(1)[0][0] if w["display_form"][word] else (upper_tr(word[0]) + word[1:])
        rows.append((word, disp, wcl, wll, wcc, wcn, wac, sc, sl, sac))
    rows.sort(key=lambda r: -(r[2] + r[4] + r[6]))
    with open(OUT_DIR / "word_stats.tsv", "w", encoding="utf-8") as f:
        f.write("word\tdisp\tw_cap_low\tw_low_low\tw_cap_cap\tw_cap_num\tw_allcap\ts_cap\ts_low\ts_allcap\n")
        for r in rows:
            f.write("\t".join(map(str, r)) + "\n")
    print(f"Wrote {len(rows):,} word_stats rows", file=sys.stderr)

    # 2. Write acronyms.tsv
    acros = []
    for word, ac_cnt in w["wiki_allcap"].items():
        if len(word) < 2 or len(word) > 10 or not word.isalpha():
            continue
        tot_w = w["wiki_total_mid"][word]
        if ac_cnt < 40 or ac_cnt / max(tot_w, 1) < 0.85:
            continue
        upper = w["allcap_form"][word].most_common(1)[0][0]
        sc_ac = s["subs_allcap"][word]
        sc_tot = sc_ac + s["subs_cap"][word] + s["subs_low"][word]
        acros.append((word, upper, ac_cnt, tot_w, sc_ac, sc_tot))
    acros.sort(key=lambda r: -r[2])
    with open(OUT_DIR / "acronyms.tsv", "w", encoding="utf-8") as f:
        f.write("word\tupper\tw_allcap\tw_total\ts_allcap\ts_total\n")
        for r in acros:
            f.write("\t".join(map(str, r)) + "\n")
    print(f"Wrote {len(acros):,} acronyms", file=sys.stderr)

    # 3. Write first_names.tsv and surnames.tsv
    with open(OUT_DIR / "first_names.tsv", "w", encoding="utf-8") as f:
        for lw, cnt in w["first_names"].most_common():
            if cnt < 3:
                break
            disp = w["first_disp"][lw].most_common(1)[0][0]
            f.write(f"{lw}\t{disp}\t{cnt}\n")
    with open(OUT_DIR / "surnames.tsv", "w", encoding="utf-8") as f:
        for lw, cnt in w["surnames"].most_common():
            if cnt < 3:
                break
            disp = w["surname_disp"][lw].most_common(1)[0][0]
            f.write(f"{lw}\t{disp}\t{cnt}\n")
    print(f"Wrote {sum(1 for _,c in w['first_names'].items() if c>=3):,} first names, {sum(1 for _,c in w['surnames'].items() if c>=3):,} surnames", file=sys.stderr)

    # 4. Write phrases.tsv
    p_rows = []
    for key, cnt in w["phrase_cap"].items():
        if cnt < 10:
            continue
        disp = w["phrase_disp"][key].most_common(1)[0][0]
        p_rows.append((key, disp, cnt, w["phrase_apos"][key], w["phrase_noapos"][key]))
    p_rows.sort(key=lambda r: -r[2])
    with open(OUT_DIR / "phrases.tsv", "w", encoding="utf-8") as f:
        f.write("lower\tdisplay\tcap_count\tapos_count\tnoapos_count\n")
        for r in p_rows:
            f.write("\t".join(map(str, r)) + "\n")
    print(f"Wrote {len(p_rows):,} phrases", file=sys.stderr)


if __name__ == "__main__":
    main()
