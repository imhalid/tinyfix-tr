import { lowerTr, upperTr } from "./turkish.ts";

/**
 * Sentence punctuation and capitals: a missing space after a full stop ("merhaba.ben" -> "merhaba. Ben") and a
 * lowercase first word of a sentence ("merhaba" at the start of a paragraph, "...geldim. sonra" -> ". Sonra").
 *
 * Deliberately conservative: nothing is changed after abbreviations ("Dr.", "vb."), ordinals and decimals ("3. sınıf",
 * "3.5"), initials ("A."), an ellipsis ("..." often continues the sentence), or inside things that only look like words
 * around a dot (domains, e-mail addresses, file names, URLs). A missing space is only fixed when the words on both
 * sides of the dot are real Turkish words.
 */

/** Minimal shape shared with Corrector's Correction (kind is "punct" for changes made here). */
export interface SentenceCorrection {
  start: number;
  end: number;
  original: string;
  replacement: string;
  kind: "punct";
  margin: number;
}

interface AnyCorrection {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

/** Common Turkish (and a few English) abbreviations written with a full stop. */
const ABBREVIATIONS = new Set([
  "vb", "vs", "vd", "dr", "prof", "doç", "doc", "yrd", "öğr", "ogr", "gör", "gor", "av", "op", "uzm", "örn", "orn",
  "bkz", "bk", "krş", "krs", "yy", "no", "sn", "st", "tel", "cad", "sok", "mah", "apt", "s", "sf", "çev", "cev",
  "haz", "ed", "der", "alm", "ing", "fr", "lat", "ar", "far", "tic", "ltd", "şti", "sti", "aş", "as", "inc", "co",
  "mr", "mrs", "ms", "jr", "sr", "etc", "eg", "ie", "vol", "fig", "ca", "ör", "or", "mö", "bnb", "hz", "san", "tic",
  "bul", "blv", "km", "cm", "mm", "kg", "gr", "lt", "ml", "sa", "dk", "sn", "hz", "mhz", "ghz", "khz", "kb", "mb", "gb",
  "subsp", "sp", "spp", "var", "pav", "nr", "vb", "yy", "yyl", "ss", "pp", "tr", "ing", "fr", "ital", "bros", "jr",
]);

/** File extensions and top-level domains: "dosya.pdf", "site.com" are not two sentences. */
const NOT_A_SENTENCE_START = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "io", "ai", "dev", "app", "tr", "uk", "us", "info", "biz", "xyz",
  "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "css", "scss", "json", "md", "txt", "pdf", "doc", "docx", "xls",
  "xlsx", "ppt", "pptx", "odt", "rtf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "mp3", "mp4", "wav", "mov",
  "avi", "mkv", "zip", "rar", "gz", "tar", "exe", "dmg", "apk", "py", "java", "kt", "swift", "rs", "go", "rb", "php",
  "sh", "sql", "xml", "csv", "yml", "yaml", "toml", "lock", "log", "env", "ini", "cfg",
]);

/**
 * Suffixes a name takes after an apostrophe ("Ahmet'le", "İstanbul'da"). Used when the apostrophe was left out:
 * "ahmetle" -> "Ahmet'le". Vowel harmony is not checked; the whole word must also not be an ordinary word.
 */
const NAME_SUFFIXES = new Set(
  (
    "a e ya ye ı i u ü yı yi yu yü da de ta te dan den tan ten ın in un ün nın nin nun nün yın yin yun yün " +
    "la le yla yle lı li lu lü ca ce ça çe cı ci cu cü daki deki taki teki dakı dır dir dur dür tır tir tur tür " +
    "sı si su sü sın sin sun sün sına sine " +
    "nda nde ndan nden na ne nı ni nu nü yken iken ydı ydi ydu ydü"
  ).split(" "),
);

/** Names that take suffixes without an apostrophe: languages and -li/-ci derivations ("Türkçeyi", "Ankaralı"). */
const NO_APOSTROPHE_NAME = /(?:ca|ce|ça|çe|lı|li|lu|lü|cı|ci|cu|cü|çı|çi|çu|çü)$/;

/** Titles written before a name: "dr. ahmet" -> "Dr. Ahmet". */
const TITLES = new Set(["dr", "prof", "doç", "doc", "av", "op", "uzm", "yrd", "öğr", "ogr", "gör", "gor", "sn", "mr", "mrs", "ms"]);

const LETTER = /\p{L}/u;
/** Only Latin-script lowercase letters are capitalized (Turkish and others); other scripts are left alone. */
const LOWER = /^[a-zçğıöşüâîûäëïóúñ]/;
const ROMAN = /^[IVXLCDM]+$/;
const WORD_CHAR = /[\p{L}\p{N}'’]/u;

function capitalize(word: string): string {
  return word ? upperTr(word[0]!) + word.slice(1) : word;
}

/** Index just past the word starting at `start` (letters, digits and inner apostrophes). */
function wordEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
  return end;
}

/** Start of the word that ends at `end` (exclusive). */
function wordStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
  return start;
}

/** The word right after it looks like part of a URL, an e-mail address, a path or a dotted name. */
function continuesAsAddress(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return false;
  if ("@/\\:_=#&?%".includes(next) && next !== "?") return true;
  if (next === "?" && LETTER.test(text[end + 1] ?? "")) return true;
  return (next === "." || next === "-") && WORD_CHAR.test(text[end + 1] ?? "");
}

/** The word before it is glued to an address-like thing ("www.site", "a@b", "x/y", "v1.2"). */
function precededByAddress(text: string, start: number): boolean {
  const prev = text[start - 1];
  return prev !== undefined && "@/\\:_.#".includes(prev);
}

/**
 * Is the full stop at `dot` (or the end of a "?!" run) a sentence end? Ellipses, abbreviations, initials, ordinals and
 * numbers don't count.
 */
function endsSentence(text: string, punctStart: number, punctEnd: number): boolean {
  const run = text.slice(punctStart, punctEnd);
  if (run.includes("…") || /\.\./.test(run)) return false;
  const before = text[punctStart - 1];
  if (before === undefined || !WORD_CHAR.test(before)) return false;
  const start = wordStart(text, punctStart);
  const word = text.slice(start, punctStart);
  if (/\p{N}/u.test(word)) return false;
  if (word.length === 1) return false;
  // Roman-numeral ordinals ("XVIII. yüzyıl"), units and abbreviations with inner capitals ("MHz.").
  if (ROMAN.test(word) || /\p{Lu}/u.test(word.slice(1))) return false;
  if (ABBREVIATIONS.has(lowerTr(word))) return false;
  if (precededByAddress(text, start)) return false;
  // "!" or "?" after a capitalized word in mid-sentence is usually part of a name or title ("Hola! magazin").
  if (!run.includes(".") || run.startsWith("!") || run.startsWith("?")) {
    const capitalized = /^\p{Lu}/u.test(word);
    if (capitalized && !isSentenceStartAt(text, start)) return false;
  }
  return true;
}

/** Is the word at `start` the first word of a sentence (start of the text or after ". ", "! ", "? ")? */
function isSentenceStartAt(text: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && /[\s"'“‘«(\[]/u.test(text[index]!)) index--;
  return index < 0 || ".!?…".includes(text[index]!);
}

/**
 * Adds missing spaces and sentence-start capitals to `corrections` (sorted, non-overlapping) and returns the new
 * sorted list. A capital for a word that another rule already changes goes into that change's replacement.
 * `isWord` tells whether a lowercase form is a real Turkish word.
 */
export function applySentenceRules<T extends AnyCorrection>(
  text: string,
  corrections: readonly T[],
  isWord: (lower: string) => boolean,
  /**
   * The capitalized spelling of a proper name from its lowercase form ("ahmet" -> "Ahmet"), if it is one. With
   * `common` only very frequent names count: they are the only ones trusted when the apostrophe is missing.
   */
  nameFor: (lower: string, common?: boolean) => string | undefined = () => undefined,
  /**
   * Stems Turkish morphology finds for a lowercase form, or null when it doesn't know the form. A suffixed name is
   * only split off when every stem is the name itself: "istanbula" (istanbul + a) yes, "belli" (bel + li) and
   * "hatayı" (hata + yı) no, although "Bell" and "Hatay" are names.
   */
  stemsOf: (lower: string) => readonly string[] | null = () => null,
): Array<T | SentenceCorrection> {
  const result: Array<T | SentenceCorrection> = [...corrections];
  const covering = (start: number, end: number) => result.findIndex((fix) => fix.start < end && fix.end > start);
  /** Dots that get a space here: the word before them is not part of an address after all. */
  const spaced = new Set<number>();

  // 1. Missing space after a sentence end between two real words: "merhaba.ben" -> "merhaba. Ben".
  for (const match of text.matchAll(/(\p{L}{2,})([.!?])(\p{L}{2,})/gu)) {
    const leftStart = match.index;
    const left = match[1]!;
    const punctAt = leftStart + left.length;
    const rightStart = punctAt + 1;
    const right = match[3]!;
    const rightEnd = rightStart + right.length;
    if (WORD_CHAR.test(text[leftStart - 1] ?? "") || precededByAddress(text, leftStart)) continue;
    if (WORD_CHAR.test(text[rightEnd] ?? "") || continuesAsAddress(text, rightEnd)) continue;
    if (/\p{Lu}/u.test(left.slice(1)) || /\p{Lu}/u.test(right.slice(1))) continue;
    if (covering(punctAt, punctAt + 1) !== -1) continue;
    const wordFix = covering(rightStart, rightEnd);
    const leftFix = covering(leftStart, punctAt);
    // A word another rule fixes is judged by its fixed form ("cok" -> "çok").
    const asFixed = (index: number, fallback: string) => {
      const fix = index === -1 ? undefined : result[index];
      return fix && !fix.replacement.includes(" ") ? fix.replacement : fallback;
    };
    const leftLower = lowerTr(asFixed(leftFix, left));
    const rightLower = lowerTr(asFixed(wordFix, right));
    if (ABBREVIATIONS.has(leftLower) || NOT_A_SENTENCE_START.has(rightLower)) continue;
    if (!isWord(leftLower) || !isWord(rightLower)) continue;
    const punct = text[punctAt]!;
    spaced.add(punctAt);
    if (wordFix === -1) {
      result.push({
        start: punctAt,
        end: rightEnd,
        original: text.slice(punctAt, rightEnd),
        replacement: `${punct} ${capitalize(right)}`,
        kind: "punct",
        margin: 6,
      });
    } else {
      const existing = result[wordFix]!;
      if (existing.start !== rightStart) continue;
      // Another rule already fixes the word ("merhaba.cok" -> "çok"): the space goes in front of that fix.
      result.splice(wordFix, 1, {
        ...existing,
        start: punctAt,
        original: text.slice(punctAt, existing.end),
        replacement: `${punct} ${capitalize(existing.replacement)}`,
      });
    }
  }
  result.sort((a, b) => a.start - b.start);

  // 2. Proper names are always capitalized: "dr. ahmet" -> "Dr. Ahmet", "ahmetle" -> "Ahmet'le".
  for (const match of text.matchAll(/\p{L}+(?:['’]\p{L}+)?/gu)) {
    const start = match.index;
    const word = match[0];
    const end = start + word.length;
    if (!LOWER.test(word) || /\p{Lu}/u.test(word)) continue;
    if (WORD_CHAR.test(text[start - 1] ?? "") || precededByAddress(text, start)) continue;
    if (continuesAsAddress(text, end) && !spaced.has(end)) continue;
    // Romanizations with tone numbers ("caan2") and code are not names.
    if (/[\p{N}_]/u.test(text[end] ?? "")) continue;
    if (covering(start, end) !== -1) continue;
    const apostrophe = word.search(/['’]/);
    let replacement: string | undefined;
    if (apostrophe > 0) {
      const name = nameFor(word.slice(0, apostrophe));
      if (name) replacement = name + word.slice(apostrophe);
    } else {
      replacement = nameFor(word);
      // The name list leaves out ordinary words, so "istanbula" can only be "İstanbul'a"; only very common names.
      // A foreign word just before ("piña colada") means a foreign phrase, not a Turkish name with a suffix.
      const previous = /(\p{L}+)[^\p{L}]*$/u.exec(text.slice(Math.max(0, start - 40), start))?.[1];
      const foreignBefore = previous !== undefined && !/^\p{Lu}/u.test(previous) && !isWord(lowerTr(previous));
      if (!replacement && word.length >= 5 && !foreignBefore) {
        for (let cut = word.length - 1; cut >= 3; cut--) {
          const rest = word.slice(cut);
          if (!NAME_SUFFIXES.has(rest)) continue;
          const base = word.slice(0, cut);
          const name = nameFor(base, true);
          const stems = name ? stemsOf(word) : null;
          const unknown = stems === null || stems.length === 0;
          if (unknown ? isWord(word) : stems.some((stem) => stem !== base)) {
            if (name) break;
            continue;
          }
          if (name) {
            replacement = NO_APOSTROPHE_NAME.test(name) ? name + rest : `${name}'${rest}`;
            break;
          }
        }
      }
    }
    if (replacement && replacement !== word) {
      result.push({ start, end, original: word, replacement, kind: "punct", margin: 6 });
    }
  }
  result.sort((a, b) => a.start - b.start);

  // Titles before a name: "dr. ahmet" -> "Dr. Ahmet".
  for (const match of text.matchAll(/\p{L}+(?=\.\s+\p{L})/gu)) {
    const start = match.index;
    const word = match[0];
    const end = start + word.length;
    if (!TITLES.has(word) || WORD_CHAR.test(text[start - 1] ?? "")) continue;
    const nextStart = end + 1 + /^\s+/u.exec(text.slice(end + 1))![0].length;
    const nextFix = result.find((fix) => fix.start === nextStart);
    const nextText = nextFix ? nextFix.replacement : text.slice(nextStart);
    if (!/^\p{Lu}/u.test(nextText) || covering(start, end) !== -1) continue;
    result.push({ start, end, original: word, replacement: capitalize(word), kind: "punct", margin: 6 });
  }
  result.sort((a, b) => a.start - b.start);

  // 3. Lowercase first word of a sentence.
  const starts: number[] = [];
  const lead = /^[\s"'“‘«(\[]*/u.exec(text);
  starts.push(lead ? lead[0].length : 0);
  for (const match of text.matchAll(/([.!?…]+)(["'”’»)\]]*)(\s+)(["'“‘«(\[]*)/gu)) {
    const punctStart = match.index;
    const punctEnd = punctStart + match[1]!.length;
    if (!endsSentence(text, punctStart, punctEnd)) continue;
    // After a closing quote or bracket the sentence usually goes on: "“Ne oldu?” dedi."
    if (match[2]) continue;
    starts.push(match.index + match[0].length);
  }
  for (const start of starts) {
    if (!LOWER.test(text[start] ?? "")) continue;
    const end = wordEnd(text, start);
    const word = text.slice(start, end);
    if (word.length === 0 || /\p{N}/u.test(word) || /\p{Lu}/u.test(word)) continue;
    // A lone letter is a letter being talked about ("i" harfi), except the pronoun "o".
    if (word.length === 1 && word !== "o") continue;
    if (!spaced.has(end) && continuesAsAddress(text, end)) continue;
    const index = covering(start, end);
    if (index === -1) {
      result.push({ start, end, original: word, replacement: capitalize(word), kind: "punct", margin: 6 });
      continue;
    }
    const existing = result[index]!;
    // A fix that already starts at this word (a change made by another rule, or the missing-space fix above, which
    // already capitalized it) gets a capital first letter.
    if (existing.start === start && LOWER.test(existing.replacement)) {
      result[index] = { ...existing, replacement: capitalize(existing.replacement) };
    }
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}
