import type { KnownMisspellings, NameEntry } from "./known.ts";
import { lowerTr, upperTr } from "./turkish.ts";
import {
  DERIV_LOOKING_KEEP_APOS,
  DIRECTIONS,
  EVENT_HEADS,
  GENERIC_ALONE_INST_HEADS,
  GENERIC_INST_MODIFIERS,
  GEO_HEADS,
  HEAD_SUFFIX_RE,
  INSTITUTION_HEADS,
  LANGUAGE_NAMES,
  MONTHS,
  NO_APOS_PROPER_SUFFIX_RE,
  NO_APOS_RELIGION_OR_DERIVED,
  NON_APOSTROPHE_SUFFIX_RE,
  NON_INST_PREFIX,
  PERSON_REL_BEFORE,
  PLURAL_PLACE_KEEP_APOS,
  POST_HONORIFICS,
  PRE_TITLES_ABBR,
  PRE_TITLES_FULL,
  PROPER_INFLECTIONAL_SUFFIX_RE,
  SAYIN_COMPOUND_FIRST,
  SAYIN_COMPOUND_TAIL,
  SAYIN_TITLES,
  STATE_HEADS,
  TITLE_CONJUNCTIONS,
  WEEKDAYS,
  capTr,
  foldTurkish,
  harmonizeAsciiSuffix,
  isInstitutionHead,
  isKinshipWord,
  isMediaTypeWord,
  isPhonologicallyValidProperSuffix,
  splitCalendarWord,
  splitHeadWord,
  splitHonorific,
} from "./rules/proper-names.ts";

/**
 * Sentence punctuation, TDK proper-name capitalization, multi-word phrases, titles, dates,
 * missing spaces after full stops, and apostrophe insertion/removal/relocation.
 *
 * Deliberately conservative on clean text: abbreviations ("Dr.", "vb."), ordinals/decimals
 * ("3. sınıf", "3.5", "09.15'te"), initials ("A."), ellipses ("..."), URLs, emails, and file
 * names are left untouched.
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

/** Optional rich lexical/morphological resources supplied by Corrector for full TDK proper-name rules. */
export interface SentenceResources {
  readonly known?: KnownMisspellings;
  readonly capitalShare?: (lower: string) => number;
  readonly count?: (lower: string) => number;
  readonly pair?: (first: string, second: string) => number;
  readonly isMorphWord?: (lower: string) => boolean;
  /** Optional contextual disambiguator for ambiguous names (core linear model or pre-scored context). */
  readonly disambiguateAmbig?: (
    tokens: readonly SentenceToken[],
    index: number,
    base: string,
    displayBase: string,
    suffix: string,
    hadApostrophe: boolean,
  ) => string | null;
}

export interface SentenceToken {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  eff: string;
  low: string;
  readonly isWord: boolean;
  readonly isNumber: boolean;
  /** Non-whitespace separator between previous token and this token. */
  readonly sepBefore: string;
  /** Exact raw substring between previous token and this token. */
  readonly gapBefore: string;
  /** Exact raw substring between this token and next token. */
  gapAfter: string;
  readonly atStart: boolean;
  locked: boolean;
}

/** Common Turkish (and a few English) abbreviations written with a full stop. */
export const ABBREVIATIONS = new Set([
  "vb", "vs", "vd", "dr", "prof", "doç", "doc", "yrd", "öğr", "ogr", "gör", "gor", "av", "op", "uzm", "örn", "orn",
  "bkz", "bk", "krş", "krs", "yy", "no", "sn", "st", "tel", "cad", "sok", "mah", "apt", "s", "sf", "çev", "cev",
  "haz", "ed", "der", "alm", "ing", "fr", "lat", "ar", "far", "tic", "ltd", "şti", "sti", "aş", "as", "inc", "co",
  "mr", "mrs", "ms", "jr", "sr", "etc", "eg", "ie", "vol", "fig", "ca", "ör", "or", "mö", "bnb", "hz", "san",
  "bul", "blv", "km", "cm", "mm", "kg", "gr", "lt", "ml", "sa", "dk", "mhz", "ghz", "khz", "kb", "mb", "gb",
  "subsp", "sp", "spp", "var", "pav", "nr", "yyl", "ss", "pp", "tr", "ital", "bros",
  "müh", "muh", "mim", "ecz", "dt", "vet", "arb",
]);

/** File extensions and top-level domains: "dosya.pdf", "site.com" are not two sentences. */
export const NOT_A_SENTENCE_START = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "io", "ai", "dev", "app", "tr", "uk", "us", "info", "biz", "xyz",
  "html", "htm", "js", "mjs", "ts", "tsx", "jsx", "css", "scss", "json", "md", "txt", "pdf", "doc", "docx", "xls",
  "xlsx", "ppt", "pptx", "odt", "rtf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "mp3", "mp4", "wav", "mov",
  "avi", "mkv", "zip", "rar", "gz", "tar", "exe", "dmg", "apk", "py", "java", "kt", "swift", "rs", "go", "rb", "php",
  "sh", "sql", "xml", "csv", "yml", "yaml", "toml", "lock", "log", "env", "ini", "cfg",
]);

/** Suffixes accepted in minimal (no-resources) fallback mode for unit tests. */
const FALLBACK_NAME_SUFFIXES = new Set(
  (
    "a e ya ye ı i u ü yı yi yu yü da de ta te dan den tan ten ın in un ün nın nin nun nün yın yin yun yün " +
    "la le yla yle lı li lu lü ca ce ça çe cı ci cu cü daki deki taki teki dakı dır dir dur dür tır tir tur tür " +
    "sı si su sü sın sin sun sün sına sine " +
    "nda nde ndan nden na ne nı ni nu nü yken iken ydı ydi ydu ydü"
  ).split(" "),
);

const NO_APOSTROPHE_NAME = /(?:ca|ce|ça|çe|lı|li|lu|lü|cı|ci|cu|cü|çı|çi|çu|çü)$/;
const LETTER = /\p{L}/u;
const LOWER = /^[a-zçğıöşüâîûäëïóúñ]/;
const ROMAN = /^[IVXLCDM]+$/;
const WORD_CHAR = /[\p{L}\p{N}'’]/u;

/** Verbal-noun predicate words following lowercase "alman" ("alman gerek", "alman daha iyi olur"). */
const ALMAN_VERBAL_NEXT = new Set([
  "gerek", "gerekiyor", "gerekir", "gerekecek", "gerekti", "gerekirdi", "lazım", "şart",
  "zorunlu", "mümkün", "daha", "iyi", "doğru", "yanlış", "saçma", "mantıklı", "için",
  "halde", "durumunda", "mı", "mi", "bile", "da", "de", "olur", "olacak", "önemli",
]);

/** Religious/social context words near "alevi" that disambiguate it from "alev + i" ("its flame"). */
const ALEVI_SECT_CTX = new Set([
  "sünni", "şii", "bektaşi", "aile", "aileler", "köy", "köyü", "köyde", "mahalle", "inanç",
  "inancı", "kültür", "kültürü", "toplum", "toplumu", "vatandaş", "cemevi", "cem", "dede",
  "mezhep", "mezhebi", "gelenek", "geleneği", "halk", "türkmen", "islam", "müslüman",
]);

/** Words that indicate a human possessor right after an ambiguous name's genitive ("Bahar'ın annesi", "Kaya'nın masasına"). */
const HUMAN_POSSESSED_NEXT = new Set([
  "annesi", "annesini", "annesine", "annesinde", "annesinden", "annesinin", "annesiyle",
  "babası", "babasını", "babasına", "babasında", "babasından", "babasının", "babasıyla",
  "ablası", "ablasını", "ablasına", "abisi", "abisini", "abisine", "ağabeyi",
  "kardeşi", "kardeşini", "kardeşine", "kardeşiyle", "eşi", "karısı", "kocası", "oğlu", "kızı",
  "evi", "evini", "evine", "evinde", "evinden", "evinin",
  "ofisi", "ofisini", "ofisine", "ofisinde", "ofisinden",
  "masası", "masasını", "masasına", "masasında", "masasından",
  "arabası", "arabasını", "arabasına", "arabasında", "arabasıyla",
  "telefonu", "telefonunu", "numarası", "numarasını", "düğünü", "düğününe", "düğününü",
  "doğum", "ödevi", "ödevini", "sınav", "sonucu", "şarkıları", "şarkılarını", "romanları",
  "romanlarını", "şiirleri", "şiirlerini", "kitabı", "kitabını", "eserleri", "eserlerini",
  "bisikleti", "bisikletini", "çantası", "çantasını", "defteri", "defterini",
  "kalemi", "gözlüğü", "bilgisayarı", "işi", "işini", "yeni",
]);

/** Single-word famous literary titles that take capitalization + apostrophe after an author's genitive ("Tanpınar'ın Huzur'unu okumak"). */
const SINGLE_WORD_WORKS = new Set([
  "huzur", "yaban", "eylül", "çalıkuşu", "tutunamayanlar", "sefiller", "dava", "şato",
  "dönüşüm", "veba", "körlük", "simyacı", "satranç", "yabancı", "kumarbaz", "budala",
  "ecinniler", "diriliş", "obligomov", "oblomov", "goriot", "emma", "dracula", "frankenstein",
]);

/** Single-word famous Turkish newspapers/magazines before "dergisi/gazetesi" ("Varlık dergisine"). */
const SINGLE_WORD_PUBLICATIONS = new Set([
  "varlık", "cumhuriyet", "hürriyet", "milliyet", "sabah", "sözcü", "posta", "zaman",
  "birgün", "evrensel", "karar", "akşam", "güneş", "takvim", "yeniçağ", "aydınlık",
  "notos", "hece", "dergâh", "dergah", "kafa", "bavul", "ot", "uykusuz", "penguen",
  "leman", "atlas", "papirüs", "hisar", "yön", "kadro", "markopaşa", "akbaba", "millî",
]);

/** Verbs/nouns proving a literary work context after "<Author>'ın <Work>". */
const READING_CTX_RE = /^(?:oku|bitir|yaz|incele|beğen|sev|anlat|kitap|roman|eser|yayım|basıl|çevir|bırak|başla)/;

/** Common words that should NEVER be capitalized as surnames after a first name when followed by a typical compound/verb. */
const COMMON_OBJECT_AFTER_SURNAME_VERBS = new Set([
  "yaktı", "yakıyor", "yakmış", "yaksın", "attı", "atıyor", "atmış", "topladı", "topluyor",
  "aldı", "alıyor", "gördü", "görüyor", "yedi", "yiyor", "içti", "içiyor", "açtı", "açıyor",
  "taktı", "takıyor", "giydi", "giyiyor", "sürdü", "sürüyor", "kırdı", "kırıyor", "kesti", "kesiyor",
  "döktü", "döküyor", "çizdi", "çiziyor", "yazdı", "yazıyor", "okudu", "okuyor", "söyledi", "söylüyor",
  "verdi", "veriyor", "tuttu", "tutuyor", "buldu", "buluyor", "dikti", "dikiyor",
]);

/** Common Turkish words that collide with surnames as nouns/adjectives/verbs and need extra care after a first name. */
const VERY_COMMON_SURNAME_COLLISIONS = new Set([
  "ak", "al", "ay", "can", "er", "gün", "kan", "kır", "ok", "su", "bal", "baş", "dağ", "dal",
  "gök", "gül", "taş", "tok", "ulu", "boz", "sarı", "kara", "uzun", "kısa", "büyük", "küçük",
  "genç", "yeni", "eski", "iyi", "güzel", "doğru", "açık", "kapalı", "sert", "kuru", "özel",
  "temel", "uyar", "uçar", "gezer", "sever", "okur", "keser", "yazar", "bakar", "tutar",
  "gider", "gelir", "bilir", "kalır", "alır", "verir", "eder", "olur", "döner", "düşer",
  "ateş", "çiçek", "güneş", "bulut", "deniz", "toprak", "yıldız", "kaya", "demir", "çelik",
  "altın", "gümüş", "bakır", "tunç", "ipek", "şeker", "ekşi", "tatlı", "kuzu", "kurt",
  "aslan", "kaplan", "kartal", "şahin", "doğan", "ceylan", "tavşan", "koç", "kılıç",
  "kalkan", "bayrak", "sancak", "uçak", "kalem", "kitap", "duman", "rüzgar", "yağmur",
  "bahar", "eylül", "nisan", "mayıs", "ocak", "bayram", "barış", "savaş", "zafer", "umut",
  "sevgi", "özlem", "mutlu", "güven", "erdem", "onur", "ufuk", "huzur", "varlık", "öykü",
  "masal", "rüya", "hayal", "neşe", "sevinç", "kader", "melek", "nur", "pınar", "ırmak",
  "nehir", "dere", "göl", "orman", "çınar", "meşe", "lale", "menekşe", "kiraz", "elmas",
  "inci", "mercan", "yakut", "sedef", "zengin", "fakir", "yalnız", "çalışkan", "sağlam",
  "parlak", "keskin", "önder", "öner", "sayın", "seçkin", "bilgin", "kahraman", "usta",
  "terzi", "çoban", "avcı", "balcı", "bağcı", "yazıcı", "yapıcı", "topçu", "dalgıç",
  "kalaycı", "ekinci", "sütçü", "tütüncü", "çiftçi", "köse", "topal", "koca", "kocaman",
  "torun", "kardeş", "arkadaş", "komşu", "misafir", "yoldaş", "yurt", "yayla", "kural",
  "metin", "saygın", "coşkun", "ergin", "yetkin", "sezer", "güler", "tekin", "şen", "tan",
  "oral", "arslan", "yılmaz", "korkmaz", "durmaz", "sönmez", "dönmez", "ölmez", "solmaz",
  "söylemez", "yüksel", "uyan", "uyanık", "uslu", "yaman", "yanık", "yeşil", "kızıl", "mavi",
  "üstün", "ünlü", "uğurlu", "varol", "vural", "yaşar", "yavuz", "yurtsever", "başar",
  "gündüz", "gürbüz", "kaymak", "pala", "tarhan", "tosun", "yörük", "dursun", "poyraz",
]);

/** Common Turkish adjectives/months/nouns in SEED_GIVEN that must NOT trigger alone after relationship words ("kızım mutlu oldu"). */
const COMMON_GIVEN_ADJECTIVES = new Set([
  "mutlu", "zeki", "emin", "adil", "aziz", "galip", "halis", "kamil", "kudret", "mahir",
  "metin", "nadir", "nezih", "önder", "sadık", "saygın", "seçkin", "servet", "şeref", "şerif",
  "taşkın", "temel", "ulvi", "yaman", "yücel", "yüksel", "arzu", "duygu", "eylem", "gaye",
  "gizem", "gözde", "imge", "kıymet", "pembe", "seher", "şirin", "yaprak", "yeter", "adalet",
  "bayram", "cuma", "eylül", "nisan", "kasım", "ramazan", "devrim", "savaş", "zafer", "sultan",
  "barış", "umut", "sevgi", "özlem", "güven", "inanç", "huzur", "neşe", "sevinç", "hayal",
  "rüya", "masal", "öykü", "doğa", "ışık", "güneş", "bulut", "yağmur", "toprak", "çiçek",
  "gül", "bahar", "deniz", "can", "kaya", "demir", "çelik", "ateş", "yıldız", "kader",
  "nur", "ipek", "evren", "pınar", "gönül", "aslı", "cihan", "saadet", "defne", "doruk",
]);

function capitalize(word: string): string {
  return word ? upperTr(word[0]!) + word.slice(1) : word;
}

function wordEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
  return end;
}

function wordStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
  return start;
}

function continuesAsAddress(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return false;
  if ("@/\\:_=#&?%".includes(next) && next !== "?") return true;
  if (next === "?" && LETTER.test(text[end + 1] ?? "")) return true;
  return (next === "." || next === "-") && WORD_CHAR.test(text[end + 1] ?? "");
}

function precededByAddress(text: string, start: number): boolean {
  const prev = text[start - 1];
  return prev !== undefined && "@/\\:_.#".includes(prev);
}

function endsSentence(text: string, punctStart: number, punctEnd: number): boolean {
  const run = text.slice(punctStart, punctEnd);
  if (run.includes("…") || /\.\./.test(run)) return false;
  const before = text[punctStart - 1];
  if (before === undefined || !WORD_CHAR.test(before)) return false;
  const start = wordStart(text, punctStart);
  const word = text.slice(start, punctStart);
  if (/\p{N}/u.test(word)) return false;
  if (word.length === 1) return false;
  if (ROMAN.test(word) || /\p{Lu}/u.test(word.slice(1))) return false;
  if (ABBREVIATIONS.has(lowerTr(word))) return false;
  if (precededByAddress(text, start)) return false;
  if (!run.includes(".") || run.startsWith("!") || run.startsWith("?")) {
    const capitalized = /^\p{Lu}/u.test(word);
    if (capitalized && !isSentenceStartAt(text, start)) return false;
  }
  return true;
}

function isSentenceStartAt(text: string, start: number): boolean {
  let index = start - 1;
  while (index >= 0 && /[\s"'“‘«(\[]/u.test(text[index]!)) index--;
  return index < 0 || ".!?…".includes(text[index]!);
}

/**
 * Checks whether a dot/exclamation/question glued between two letter runs (`left[punct]right`) is a
 * real missing-space sentence boundary (and NOT a domain, filename, abbreviation, or camelCase/address).
 */
export function isMissingSpaceBoundary(
  text: string,
  leftStart: number,
  left: string,
  punctAt: number,
  rightStart: number,
  right: string,
  isWordOrFixable: (lower: string) => boolean,
): boolean {
  const rightEnd = rightStart + right.length;
  if (WORD_CHAR.test(text[leftStart - 1] ?? "") || precededByAddress(text, leftStart)) return false;
  if (WORD_CHAR.test(text[rightEnd] ?? "") || continuesAsAddress(text, rightEnd)) return false;
  if (/\p{Lu}/u.test(left.slice(1)) || /\p{Lu}/u.test(right.slice(1))) return false;
  const leftLower = lowerTr(left);
  const rightLower = lowerTr(right);
  if (ABBREVIATIONS.has(leftLower) || NOT_A_SENTENCE_START.has(rightLower)) return false;
  if (!isWordOrFixable(leftLower) || !isWordOrFixable(rightLower)) return false;
  void punctAt;
  return true;
}

/**
 * Adds missing spaces, TDK proper-name capitals, multi-word phrases, titles, dates,
 * apostrophe fixes, and sentence-start capitals to `corrections` (sorted, non-overlapping).
 */
export function applySentenceRules<T extends AnyCorrection>(
  text: string,
  corrections: readonly T[],
  isWord: (lower: string) => boolean,
  nameFor: (lower: string, common?: boolean) => string | undefined = () => undefined,
  stemsOf: (lower: string) => readonly string[] | null = () => null,
  resources?: SentenceResources,
): Array<T | SentenceCorrection> {
  const result: Array<T | SentenceCorrection> = [...corrections];
  const covering = (start: number, end: number) => result.findIndex((fix) => fix.start < end && fix.end > start);
  const spaced = new Set<number>();

  // ---------------------------------------------------------------------------
  // 1. Missing space after a sentence end between two real words: "merhaba.ben" -> "merhaba. Ben".
  // ---------------------------------------------------------------------------
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
      result.splice(wordFix, 1, {
        ...existing,
        start: punctAt,
        original: text.slice(punctAt, existing.end),
        replacement: `${punct} ${capitalize(existing.replacement)}`,
      });
    }
  }
  result.sort((a, b) => a.start - b.start);

  // ---------------------------------------------------------------------------
  // Minimal fallback path when called directly from unit tests without `resources`.
  // Preserves exact original behavior of `src/sentence.test.ts`!
  // ---------------------------------------------------------------------------
  if (!resources || !resources.known?.hasProperData) {
    applyMinimalRules(text, result, spaced, isWord, nameFor, stemsOf);
    applySentenceStartCapitals(text, result, spaced);
    result.sort((a, b) => a.start - b.start);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Full TDK Proper-Name & Apostrophe Engine (using `resources.known`)
  // ---------------------------------------------------------------------------
  const known = resources.known;
  const isMorphWord = resources.isMorphWord ?? isWord;
  const capShare = resources.capitalShare ?? (() => 0);
  const lexCount = resources.count ?? (() => 0);
  const lexPair = resources.pair ?? (() => 0);

  // Build token list of words & numbers (skipping address/code-glued tokens) with post-core effective forms.
  const tokens: SentenceToken[] = [];
  const TOKEN_RE = /\p{L}+(?:['’]\p{L}+)*|\d+/gu;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;
    const isNum = /^\d+$/.test(raw);
    if (!isNum) {
      if (precededByAddress(text, start)) continue;
      if (continuesAsAddress(text, end) && !spaced.has(end)) continue;
      if (/[\p{N}_]/u.test(text[end] ?? "") || /[\p{N}_]/u.test(text[start - 1] ?? "")) continue;
    }
    let eff = raw;
    let lockedByCore = false;
    const covIdx = covering(start, end);
    if (covIdx !== -1) {
      const fix = result[covIdx]!;
      if (fix.start === start && fix.end === end && !fix.replacement.includes(" ")) {
        eff = fix.replacement;
      } else if (spaced.has(fix.start) && fix.end === end && fix.replacement.includes(" ")) {
        eff = fix.replacement.slice(fix.replacement.indexOf(" ") + 1);
      } else {
        // Multi-word core split/join fix ("Belliki" -> "Belli ki", "Yarın ki" -> "Yarınki"): never overwrite!
        lockedByCore = true;
      }
    }
    const prevTok = tokens.at(-1);
    const gapBefore = prevTok ? text.slice(prevTok.end, start) : text.slice(0, start);
    if (prevTok) prevTok.gapAfter = gapBefore;
    const sepBefore = gapBefore.trim();
    const atStart =
      isSentenceStartAt(text, start) ||
      (prevTok !== undefined && spaced.has(prevTok.end) && gapBefore.length === 1);
    tokens.push({
      start,
      end,
      raw,
      eff,
      low: lowerTr(eff),
      isWord: !isNum,
      isNumber: isNum,
      sepBefore,
      gapBefore,
      gapAfter: text.slice(end),
      atStart,
      locked: lockedByCore,
    });
  }

  /** Helper: set a single token's effective replacement, merging cleanly with any existing core/missing-space fix. */
  const setToken = (tok: SentenceToken, nextText: string, lock = false): void => {
    if (lock) tok.locked = true;
    // Never emit a change whose ONLY difference is curly ’ vs straight ' apostrophe.
    if (nextText === tok.eff || nextText.replaceAll("'", "’") === tok.eff) return;
    tok.eff = nextText;
    tok.low = lowerTr(nextText);
    const idx = covering(tok.start, tok.end);
    if (idx === -1) {
      if (nextText !== tok.raw) {
        result.push({ start: tok.start, end: tok.end, original: tok.raw, replacement: nextText, kind: "punct", margin: 6 });
        result.sort((a, b) => a.start - b.start);
      }
      return;
    }
    const existing = result[idx]!;
    if (existing.start === tok.start && existing.end === tok.end) {
      if (nextText === tok.raw) {
        result.splice(idx, 1);
      } else {
        result[idx] = { ...existing, replacement: nextText };
      }
      return;
    }
    if (spaced.has(existing.start) && existing.end === tok.end) {
      const spIdx = existing.replacement.indexOf(" ");
      if (spIdx !== -1) {
        result[idx] = { ...existing, replacement: existing.replacement.slice(0, spIdx + 1) + nextText };
      }
    }
  };

  /** True when adjacent tokens `a` and `b` are separated only by whitespace (no comma/period/newline). */
  const adjSpace = (a: SentenceToken, b: SentenceToken): boolean => /^[ \t]+$/.test(b.gapBefore);
  /** True when `a` is followed by "." + spaces and then `b` (for abbreviated titles like "Prof. Dr. Ahmet"). */
  const adjDotSpace = (a: SentenceToken, b: SentenceToken): boolean => /^\.[ \t]+$/.test(b.gapBefore);
  /** True when a token is already capitalized (excluding sentence start unless unmistakably a proper noun). */
  const isCap = (tok: SentenceToken): boolean => /^\p{Lu}/u.test(tok.eff);
  const isAllCaps = (tok: SentenceToken): boolean => tok.eff.length >= 2 && tok.eff === upperTr(tok.eff) && tok.eff !== lowerTr(tok.eff);
  const isMixedInnerCap = (tok: SentenceToken): boolean => !isAllCaps(tok) && /\p{Lu}/u.test(tok.eff.slice(1));

  /** Check whether text has ASCII-typing evidence (e.g. a core mark fix already occurred or no Turkish diacritics). */
  const textHasTurkishMarks = /[çğıöşüâîû]/i.test(text);
  const sentenceHasAsciiFixes = result.some((r) => {
    const o = lowerTr(r.original);
    const rep = lowerTr(r.replacement);
    return o !== rep && foldTurkish(o) === foldTurkish(rep);
  });

  /** Lookup a proper name entry either exact or unique ASCII-folded (when safe). */
  const lookupName = (stemLow: string, allowAscii: boolean): NameEntry | undefined => {
    const exact = known.nameEntry(stemLow);
    if (exact) return exact;
    if (allowAscii && !/[çğıöşüâîû]/.test(stemLow) && !isMorphWord(stemLow)) {
      return known.asciiNameEntry(stemLow);
    }
    return undefined;
  };

  /** True when a lowercase form is strictly a common word (has a morphological stem other than `base`). */
  const isCommonWordCollision = (wholeLow: string, baseLow: string): boolean => {
    const stems = stemsOf(wholeLow);
    if (stems === null || stems.length === 0) return isWord(wholeLow);
    // If morphology recognizes the whole form via a common-word stem different from `baseLow`, it's a collision ("belli", "hatayı", "emrinin").
    return stems.some((s) => s !== baseLow && s !== lowerTr(baseLow));
  };

  /** Checks if `tok` can serve as a person's first name (Turkish given name or ambiguous given name; never languages/places). */
  const resolveGivenName = (tok: SentenceToken): { display: string; suffix: string; hadApos: boolean } | null => {
    if (!tok.isWord || isAllCaps(tok) || isMixedInnerCap(tok)) return null;
    const low = tok.low;
    const lookupPersonFirst = (s: string): string | undefined => {
      const g = known.givenNameFor(s);
      if (g) return g;
      const ne = known.nameEntry(s);
      if (ne && !ne.noApos && !LANGUAGE_NAMES.has(s) && !NO_APOS_RELIGION_OR_DERIVED.has(s)) {
        return known.givenNameFor(s) ?? (known.ambigNameFor(s) ? undefined : undefined);
      }
      return undefined;
    };
    const apos = low.indexOf("'");
    if (apos > 0) {
      const stem = low.slice(0, apos);
      const suf = low.slice(apos + 1);
      const disp = lookupPersonFirst(stem) ?? (known.nameEntry(stem)?.noApos ? undefined : known.nameFor(stem));
      if (disp && PROPER_INFLECTIONAL_SUFFIX_RE.test(suf)) return { display: disp, suffix: suf, hadApos: true };
      return null;
    }
    const bare = known.givenNameFor(low);
    if (bare) return { display: bare, suffix: "", hadApos: false };
    // Try suffixed given name (never split everyday common Turkish words like "arasında", "savaşta")
    for (let cut = low.length - 1; cut >= 3; cut--) {
      const base = low.slice(0, cut);
      const suf = low.slice(cut);
      const disp = known.givenNameFor(base);
      if (!disp) continue;
      if (isCommonWordCollision(low, base)) continue;
      if (isMorphWord(low) && !known.nameEntry(base) && lexCount(`${base}'${suf}`) < Math.max(5, lexCount(low) * 2)) continue;
      if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(lowerTr(disp), suf)) {
        return { display: disp, suffix: suf, hadApos: false };
      }
      if (sentenceHasAsciiFixes || !textHasTurkishMarks) {
        const harm = harmonizeAsciiSuffix(lowerTr(disp), suf);
        if (harm) return { display: disp, suffix: harm, hadApos: false };
      }
    }
    if ((sentenceHasAsciiFixes || !textHasTurkishMarks) && !/[çğıöşüâîû]/.test(low)) {
      const asc = known.asciiNameEntry(low);
      if (asc && !asc.noApos && known.givenNameFor(lowerTr(asc.name))) {
        return { display: asc.name, suffix: "", hadApos: false };
      }
    }
    return null;
  };

  /** Checks if `tok` can serve as a person's surname (bare or suffixed). */
  const resolveSurname = (tok: SentenceToken, allowCommon: boolean): { display: string; suffix: string; hadApos: boolean; isCommon: boolean } | null => {
    if (!tok.isWord || isAllCaps(tok) || isMixedInnerCap(tok)) return null;
    const low = tok.low;
    const apos = low.indexOf("'");
    if (apos > 0) {
      const stem = low.slice(0, apos);
      const suf = low.slice(apos + 1);
      const disp = known.surnameFor(stem) ?? known.nameFor(stem) ?? (allowCommon ? known.ambigNameFor(stem) : undefined);
      if (disp && PROPER_INFLECTIONAL_SUFFIX_RE.test(suf)) {
        return { display: disp, suffix: suf, hadApos: true, isCommon: VERY_COMMON_SURNAME_COLLISIONS.has(stem) };
      }
      if (allowCommon && isCap(tok) && !tok.atStart && PROPER_INFLECTIONAL_SUFFIX_RE.test(suf)) {
        return { display: tok.eff.slice(0, apos), suffix: suf, hadApos: true, isCommon: false };
      }
      return null;
    }
    const dispBare = known.surnameFor(low);
    if (dispBare) {
      const isCom = VERY_COMMON_SURNAME_COLLISIONS.has(low);
      if (!isCom || allowCommon) return { display: dispBare, suffix: "", hadApos: false, isCommon: isCom };
    }
    // Never invent an apostrophe inside an already-capitalized mid-sentence foreign/Turkish name ("Fatma Aliye", "Robert Belle", "Bay Reede")
    // unless the apostrophe form clearly dominates in the corpus.
    const alreadyCapMid = isCap(tok) && !tok.atStart;
    if (alreadyCapMid && known.givenNameFor(low)) return null;
    for (let cut = low.length - 1; cut >= 2; cut--) {
      const base = low.slice(0, cut);
      const suf = low.slice(cut);
      const disp = known.surnameFor(base) ?? (!alreadyCapMid ? known.nameFor(base) : undefined);
      if (!disp) continue;
      if (isCommonWordCollision(low, base)) continue;
      if (alreadyCapMid && !(lexCount(`${base}'${suf}`) >= 10 && lexCount(low) < 5)) continue;
      const isCom = VERY_COMMON_SURNAME_COLLISIONS.has(base);
      if (isCom && !allowCommon) continue;
      if (isMorphWord(low) && !known.nameEntry(base) && capShare(low) < 0.35 && lexCount(low) >= 20) continue;
      if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(lowerTr(disp), suf)) {
        return { display: disp, suffix: suf, hadApos: false, isCommon: isCom };
      }
      if (sentenceHasAsciiFixes || !textHasTurkishMarks) {
        const harm = harmonizeAsciiSuffix(lowerTr(disp), suf);
        if (harm) return { display: disp, suffix: harm, hadApos: false, isCommon: isCom };
      }
    }
    return null;
  };

  /** Formats a proper name + suffix according to apostrophe policy. */
  const formatProper = (displayBase: string, suffix: string, takesApos: boolean): string => {
    if (!suffix) return displayBase;
    return takesApos ? `${displayBase}'${suffix}` : `${displayBase}${suffix}`;
  };

  // ===========================================================================
  // STEP 2: Multi-word Canonical & Mined Proper Phrases (PHRASE_APOS / PHRASE_NOAPOS)
  // Runs BEFORE wrong-apostrophe and single-word passes so novel titles like
  // "Saatleri Ayarlama Enstitüsü'nü" or "Beyaz Kale'sini" or "İnce Memed'ini" win!
  // ===========================================================================
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord || tok.locked) continue;
    const candidates = known.phrasesStartingWith(tok.low, true);
    if (candidates.length === 0) continue;

    for (const phrase of candidates) {
      const len = phrase.words.length;
      if (i + len > tokens.length) continue;
      // Check adjacency (space-only between phrase words)
      let ok = true;
      for (let k = 1; k < len; k++) {
        if (!adjSpace(tokens[i + k - 1]!, tokens[i + k]!)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // Match words 0 .. len-2 (exact or ASCII-folded)
      for (let k = 0; k < len - 1; k++) {
        const tw = tokens[i + k]!.low;
        const pw = phrase.words[k]!;
        if (tw !== pw && foldTurkish(tw) !== foldTurkish(pw)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      // Match final word: bare OR with inflectional suffix (with or without apostrophe)
      const lastTok = tokens[i + len - 1]!;
      const lastPw = phrase.words[len - 1]!;
      const lastDisp = phrase.displayWords[len - 1]!;
      const lastLow = lastTok.low;
      const apos = lastLow.indexOf("'");
      let matchedSuffix: string | null = null;

      if (lastLow === lastPw || foldTurkish(lastLow) === foldTurkish(lastPw)) {
        matchedSuffix = "";
      } else if (apos > 0) {
        const stem = lastLow.slice(0, apos);
        const suf = lastLow.slice(apos + 1);
        if ((stem === lastPw || foldTurkish(stem) === foldTurkish(lastPw)) && (HEAD_SUFFIX_RE.test(suf) || PROPER_INFLECTIONAL_SUFFIX_RE.test(suf))) {
          matchedSuffix = suf;
        }
      } else {
        // Also handle "Beyaz Kalesini" where core already turned it into "Kalesi'ni" (check raw too!)
        const rawLow = lowerTr(lastTok.raw);
        for (const form of rawLow !== lastLow ? [lastLow, rawLow] : [lastLow]) {
          if (form.startsWith(lastPw) && form.length > lastPw.length) {
            const suf = form.slice(lastPw.length);
            const p3sg = /[aeıioöuüâîû]$/.test(lastPw) && (INSTITUTION_HEADS.has(lastPw) || GEO_HEADS.has(lastPw) || STATE_HEADS.has(lastPw) || EVENT_HEADS.has(lastPw));
            if ((PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) || HEAD_SUFFIX_RE.test(suf)) && isPhonologicallyValidProperSuffix(lastPw, suf, { p3sgHead: p3sg })) {
              matchedSuffix = suf;
              break;
            }
            const harm = harmonizeAsciiSuffix(lastPw, suf, { p3sgHead: p3sg });
            if (harm) {
              matchedSuffix = harm;
              break;
            }
          } else {
            const fForm = foldTurkish(form);
            const fPw = foldTurkish(lastPw);
            if (fForm.startsWith(fPw) && fForm.length > fPw.length) {
              const suf = form.slice(lastPw.length);
              const p3sg = /[aeıioöuüâîû]$/.test(lastPw) && (INSTITUTION_HEADS.has(lastPw) || GEO_HEADS.has(lastPw) || STATE_HEADS.has(lastPw) || EVENT_HEADS.has(lastPw));
              if ((PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) || HEAD_SUFFIX_RE.test(suf)) && isPhonologicallyValidProperSuffix(lastPw, suf, { p3sgHead: p3sg })) {
                matchedSuffix = suf;
                break;
              }
              const harm = harmonizeAsciiSuffix(lastPw, suf, { p3sgHead: p3sg });
              if (harm) {
                matchedSuffix = harm;
                break;
              }
            }
          }
        }
      }

      // Special case: core already injected wrong split on a book title like "Beyaz Kalesini" -> "Beyaz Kalesi'ni"
      if (matchedSuffix === null && apos > 0) {
        const joined = lastLow.replaceAll("'", "");
        if (joined.startsWith(lastPw) && joined.length > lastPw.length) {
          const suf = joined.slice(lastPw.length);
          if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(lastPw, suf)) {
            matchedSuffix = suf;
          }
        }
      }

      if (matchedSuffix === null) continue;

      // Apply the matched multi-word phrase!
      for (let k = 0; k < len - 1; k++) {
        setToken(tokens[i + k]!, phrase.displayWords[k]!, true);
      }
      setToken(lastTok, formatProper(lastDisp, matchedSuffix, phrase.takesApos), true);
      i += len - 1;
      break;
    }
  }

  // ===========================================================================
  // STEP 3: Specific Dates ("12 haziran 2027 cumartesi", "17 aralıka", "25 ocak ile 8 şubat")
  // ===========================================================================
  for (let i = 0; i < tokens.length - 1; i++) {
    const dayTok = tokens[i]!;
    const monthTok = tokens[i + 1]!;
    if (!dayTok.isNumber || !monthTok.isWord || monthTok.locked) continue;
    if (!adjSpace(dayTok, monthTok)) continue;
    // Day must be 1..31 and NOT an ordinal ("3.") or decimal ("3.5")
    const dayNum = Number(dayTok.raw);
    if (dayNum < 1 || dayNum > 31) continue;
    if (dayTok.sepBefore === "." || dayTok.gapBefore.endsWith(".") || dayTok.gapBefore.endsWith(",")) continue;

    const mSplit = splitCalendarWord(monthTok.low, MONTHS);
    if (!mSplit) continue;
    setToken(monthTok, formatProper(capTr(mSplit.stem), mSplit.suffix, true), true);

    // Optional year (4 digits) + optional weekday ("12 haziran 2027 cumartesi", "12 haziran cumartesi")
    let nextIdx = i + 2;
    if (
      nextIdx < tokens.length &&
      tokens[nextIdx]!.isNumber &&
      adjSpace(tokens[nextIdx - 1]!, tokens[nextIdx]!) &&
      /^\d{4}$/.test(tokens[nextIdx]!.raw)
    ) {
      nextIdx++;
    }
    if (nextIdx < tokens.length && tokens[nextIdx]!.isWord && adjSpace(tokens[nextIdx - 1]!, tokens[nextIdx]!)) {
      const wTok = tokens[nextIdx]!;
      const wSplit = splitCalendarWord(wTok.low, WEEKDAYS);
      if (wSplit) {
        setToken(wTok, formatProper(capTr(wSplit.stem), wSplit.suffix, true), true);
      }
    }
  }

  // ===========================================================================
  // STEP 4: Wrong-Apostrophe Removal & Relocation (TDK kesme_yanlis W1–W6)
  // ===========================================================================
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord || tok.locked) continue;
    if (!tok.eff.includes("'") && !tok.eff.includes("’")) continue;
    // Protect hyphenated foreign/compound suffixes ("Luffy-san'ın", "U-Bot'larında", "Fatu-Krey'li")
    if (tok.gapBefore.endsWith("-")) continue;

    const norm = tok.eff.replaceAll("’", "'");
    const parts = norm.split("'");
    if (parts.some((p) => p.length === 0)) continue;

    // W1: Multiple apostrophes ("Mehmet'le'ydim" -> "Mehmet'leydim", "Kemal'in'kiler" -> "Kemal'inkiler", "İzmir'li'ler" -> "İzmirliler")
    // Protect foreign names with an internal stem apostrophe ("G'Kar'a", "Teal'c'in", "d'Aragon'dan", "Goa'uld'ları")!
    if (parts.length >= 3) {
      const stem = parts[0]!;
      const rest1 = parts[1]!;
      const restAll = parts.slice(1).join("");
      const lowStem = lowerTr(stem);
      const lowRest1 = lowerTr(rest1);
      const isTurkishSuffixMid =
        stem.length >= 3 &&
        /^[a-zçğıöşü]+$/.test(rest1) &&
        (PROPER_INFLECTIONAL_SUFFIX_RE.test(lowRest1) || NON_APOSTROPHE_SUFFIX_RE.test(lowRest1));
      if (!isTurkishSuffixMid) continue;
      if (NON_APOSTROPHE_SUFFIX_RE.test(lowRest1) || LANGUAGE_NAMES.has(lowStem) || NO_APOS_RELIGION_OR_DERIVED.has(lowStem)) {
        setToken(tok, stem + restAll, true);
      } else {
        setToken(tok, `${stem}'${restAll}`, true);
      }
      continue;
    }

    // Single apostrophe: stem'suffix
    const stem = parts[0]!;
    const suffix = parts[1]!;
    const lowStem = lowerTr(stem);
    const lowSuffix = lowerTr(suffix);
    const prevTok = i > 0 && adjSpace(tokens[i - 1]!, tok) ? tokens[i - 1] : undefined;

    // Protect ALL-CAPS acronyms ("TDK'nin", "ÖSYM'nin", "ABD'nin") and foreign apostrophe names ("O'Connor", "d'Arc")
    if (stem.length >= 2 && stem === upperTr(stem) && stem !== lowerTr(stem)) continue;
    if (stem.length < 3 || /^\p{Lu}/u.test(suffix)) continue;

    // W2: Derivational or plural suffix right after apostrophe ("İzmir'li", "Tokat'lıymış", "Türk'çe", "Müslüman'lık", "Marks'çı", "Tanrı'sal", "Alman'lar")
    if (NON_APOSTROPHE_SUFFIX_RE.test(lowSuffix)) {
      const joined = stem + suffix;
      const lowJoined = lowerTr(joined);
      const stemEntry = known.nameEntry(lowStem);
      const properDisp = stemEntry ? stemEntry.name : isCap(tok) ? stem : undefined;
      if (properDisp && (isMorphWord(lowJoined) || lexCount(lowJoined) >= 1 || lowSuffix.startsWith("l") || /^[cçs]/.test(lowSuffix))) {
        setToken(tok, properDisp + suffix, true);
        continue;
      }
    }

    // W3a: Language name before apostrophe ("Fransızca'da", "Rusça'sı", "almanca'ya", "ispanyolca'dan")
    if (LANGUAGE_NAMES.has(lowStem)) {
      setToken(tok, capTr(lowStem) + suffix, true);
      continue;
    }

    // W3b: Derived religion/ideology/demonym before apostrophe ("Hristiyanlık'ta", "Müslümanlık'ta", "Ankaralı'nın", "Atatürkçü'nün")
    // Never strip apostrophe from a proper place/country name ("Arnavutluk'un", "Kadirli'ye", "Birleşik Krallık'ta")!
    if (NO_APOS_RELIGION_OR_DERIVED.has(lowStem)) {
      setToken(tok, capTr(lowStem) + suffix, true);
      continue;
    }
    const existingProperStem = known.nameEntry(lowStem);
    if (!DERIV_LOOKING_KEEP_APOS.has(lowStem) && (!existingProperStem || existingProperStem.noApos)) {
      const aposCount = lexCount(lowStem + "'" + lowSuffix);
      const joinCount = lexCount(lowStem + lowSuffix);
      if (/l[ıiuü]k$/.test(lowStem) && lowStem.length >= 6 && aposCount <= joinCount) {
        const root = lowStem.slice(0, -3);
        if (known.nameEntry(root) && isMorphWord(lowStem + lowSuffix)) {
          setToken(tok, (isCap(tok) ? stem : capTr(lowStem)) + suffix, true);
          continue;
        }
      }
      if (/(?:l[ıiuü]|[cç][ıiuü])$/.test(lowStem) && lowStem.length >= 6 && aposCount * 3 <= joinCount) {
        const root = lowStem.slice(0, -2);
        if (known.nameEntry(root) && isMorphWord(lowStem + lowSuffix)) {
          setToken(tok, (isCap(tok) ? stem : capTr(lowStem)) + suffix, true);
          continue;
        }
      }
    }

    // W3c: Plural proper noun before apostrophe ("Japonlar'ın", "Almanlar'ın", "Türkler'in", "Ahmetler'e", "Yılmazlar'ın")
    if (/l[ae]r$/.test(lowStem) && lowStem.length >= 6 && !PLURAL_PLACE_KEEP_APOS.has(lowStem)) {
      const singular = lowStem.slice(0, -3);
      if (
        known.nameEntry(singular) ||
        known.givenNameFor(singular) ||
        known.surnameFor(singular) ||
        known.ambigNameFor(singular) ||
        singular === "alman" ||
        NO_APOS_RELIGION_OR_DERIVED.has(singular) ||
        (singular.length >= 5 && /l[ıiuü]$/.test(singular) && known.nameEntry(singular.slice(0, -2)))
      ) {
        setToken(tok, (isCap(tok) ? stem : capTr(lowStem)) + suffix, true);
        continue;
      }
    }

    // W4: Institution head before apostrophe ("Millî Eğitim Bakanlığı'na", "Ankara Üniversitesi'ne", "Anadolu Ajansı'nın")
    if (isInstitutionHead(lowStem, prevTok?.low)) {
      const disp = isCap(tok) ? stem : capTr(lowStem);
      setToken(tok, disp + suffix, true);
      if (isCap(tok)) tok.locked = true;
      continue;
    }

    // W5: Misplaced apostrophe inside a proper name's suffix chain ("Selinin'kini" -> "Selin'inkini",
    //     "Ahmetin'ki" -> "Ahmet'inki", "İstanbulda'ki" -> "İstanbul'daki", "İstanbulda'n" -> "İstanbul'dan")
    if (!known.nameEntry(lowStem) && !known.givenNameFor(lowStem) && !known.surnameFor(lowStem) && !known.ambigNameFor(lowStem)) {
      const isKiOrCop = /^(?:ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|ki(?:n[aeıiuü]|nd[ae]n?|n[ıiuü]n)?|yd[ıiuü][mk]?|ym[ıiuü]ş|n|m)$/.test(lowSuffix);
      if (isKiOrCop) {
        for (let cut = lowStem.length - 1; cut >= 3; cut--) {
          const base = lowStem.slice(0, cut);
          const firstSuf = lowStem.slice(cut);
          const disp = known.nameFor(base) ?? known.givenNameFor(base) ?? known.surnameFor(base);
          if (!disp) continue;
          const combinedSuf = firstSuf + lowSuffix;
          if (PROPER_INFLECTIONAL_SUFFIX_RE.test(combinedSuf) && isPhonologicallyValidProperSuffix(lowerTr(disp), combinedSuf)) {
            setToken(tok, `${disp}'${combinedSuf}`, true);
            break;
          }
        }
        if (tok.locked) continue;
      }
    }

    // W6: Common noun with wrong apostrophe
    const lowJoined = lowStem + lowSuffix;
    if (!isCap(tok)) {
      // Lowercase stem'suffix:
      // 1) Known unconditional proper name -> capitalize ("ahmet'e" -> "Ahmet'e", "ankara'dan" -> "Ankara'dan")
      const nameEnt = lookupName(lowStem, sentenceHasAsciiFixes);
      if (nameEnt) {
        const fixedSuf = harmonizeAsciiSuffix(lowerTr(nameEnt.name), lowSuffix) ?? suffix;
        setToken(tok, formatProper(nameEnt.name, fixedSuf, !nameEnt.noApos), true);
        continue;
      }
      // 2) Known Turkish given/surname with apostrophe that CANNOT be a common Turkish word ("emre'yi" -> "Emre'yi", "aslı'yı" -> "Aslı'yı")
      const personDisp = known.givenNameFor(lowStem) ?? known.surnameFor(lowStem);
      if (personDisp && !isMorphWord(lowJoined)) {
        setToken(tok, `${personDisp}'${suffix}`, true);
        continue;
      }
      // 2b) Honorific after a person name ("Mustafa ağa'nın" -> handled in Step 7d as "Mustafa Ağa'nın", don't strip!)
      if (
        POST_HONORIFICS.has(lowStem) &&
        prevTok !== undefined &&
        (known.givenNameFor(prevTok.low) !== undefined || known.nameEntry(prevTok.low) !== undefined || (isCap(prevTok) && !prevTok.atStart))
      ) {
        continue;
      }
      // 3) Ordinary common Turkish noun (NOT in AMBIG and NOT a foreign loanword like "single'ı", "rock'ın") -> remove apostrophe
      const lowAposCount = lexCount(lowStem + "'" + lowSuffix);
      if (
        !known.ambigNameFor(lowStem) &&
        isMorphWord(lowJoined) &&
        (lowAposCount === 0 || lowAposCount * 3 < lexCount(lowJoined))
      ) {
        setToken(tok, stem + suffix, true);
        continue;
      }
      // 4) Ambiguous lowercase stem'suffix ("deniz'e girmeye" vs "deniz'e söyle"):
      if (known.ambigNameFor(lowStem) && isMorphWord(lowJoined)) {
        const nextTok = i + 1 < tokens.length ? tokens[i + 1] : undefined;
        // Common idiom/collocation check for lowercase ambiguous noun with wrong apostrophe (e.g. "deniz'e girmeye/atla/yüz/dökül")
        const commonCue =
          (lowStem === "deniz" && nextTok !== undefined && /^(?:gir|yüz|atla|dökül|açıl|bak|in)/.test(nextTok.low)) ||
          (lowStem === "gül" && nextTok !== undefined && /^(?:bahçe|su|reçel|yaprak|diken|koku)/.test(nextTok.low));
        if (commonCue) {
          setToken(tok, stem + suffix, true);
          continue;
        }
        if (resources.disambiguateAmbig) {
          const decided = resources.disambiguateAmbig(tokens, i, lowStem, known.ambigNameFor(lowStem)!, lowSuffix, true);
          if (decided) {
            setToken(tok, decided, true);
            continue;
          }
        }
      }
    } else if (tok.atStart) {
      // Sentence-start capitalized common noun with wrong apostrophe ("Babam'ın", "Toplantı'ya", "Ofis'te", "Okul'da")
      // Protects proper place/institution names like "Bebek'te", "Moda'da", "Boğaz'da", "Meclis'te".
      if (
        !known.nameEntry(lowStem) &&
        !known.ambigNameFor(lowStem) &&
        !known.givenNameFor(lowStem) &&
        !known.surnameFor(lowStem) &&
        !MONTHS.has(lowStem) &&
        !WEEKDAYS.has(lowStem) &&
        capShare(lowStem) < 0.55 &&
        isMorphWord(lowJoined) &&
        lexCount(lowJoined) >= 10 &&
        lexCount(lowStem + "'" + lowSuffix) * 8 < lexCount(lowJoined)
      ) {
        setToken(tok, stem + suffix, true);
        continue;
      }
    }
  }

  // ===========================================================================
  // STEP 5: Capitalized Internal Conjunctions inside Capitalized Titles ("Radyo Ve Televizyon", "Leyla İle Mecnun")
  // ===========================================================================
  for (let i = 1; i < tokens.length - 1; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord || tok.locked || tok.atStart) continue;
    if (tok.eff !== "Ve" && tok.eff !== "İle") continue;
    const prev = tokens[i - 1]!;
    const next = tokens[i + 1]!;
    if (!prev.isWord || !next.isWord || !adjSpace(prev, tok) || !adjSpace(tok, next)) continue;
    if (isCap(prev) && !isAllCaps(prev) && isCap(next) && !isAllCaps(next)) {
      setToken(tok, lowerTr(tok.eff), true);
    }
  }

  // ===========================================================================
  // STEP 6: Compositional Institutions, Geo/Landmarks, Directions, Events
  // ===========================================================================
  // 6a. Compositional Institutions ("Boğaziçi üniversitesinde", "Marmara üniversitesine",
  //     "Eskişehir Osmangazi üniversitesinde", "Yıldız pastanesinden", "Ankara Üniversitesi siyasal bilgiler fakültesi",
  //     "Bankacılık düzenleme ve denetleme kurumunun", "Başakşehir çam ve sakura şehir hastanesinde")
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord || tok.locked) continue;
    const hSplit = splitHeadWord(tok.low, INSTITUTION_HEADS);
    if (!hSplit) continue;
    const prev = tokens[i - 1]!;
    if (!prev.isWord || !adjSpace(prev, tok)) continue;
    if (!isInstitutionHead(hSplit.head, prev.low)) continue;

    // Walk left up to 5 words collecting valid institution name tokens
    // Never treat a genitive person name ("Sinan Güler'in polikliniğinde") as an institution anchor!
    if (prev.low.includes("'")) continue;
    let startIdx = i;
    let hasProperAnchor = false;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const cur = tokens[j]!;
      const right = tokens[j + 1]!;
      if (!cur.isWord || !adjSpace(cur, right) || cur.low.includes("'")) break;
      const lw = cur.low;
      // Allow internal conjunction "ve" / "ile" ONLY if something valid is to its left
      if ((lw === "ve" || lw === "ile") && j > 0 && tokens[j - 1]!.isWord && adjSpace(tokens[j - 1]!, cur)) {
        startIdx = j;
        continue;
      }
      const isNameToken =
        known.nameEntry(lw) !== undefined ||
        known.acronymFor(lw) !== undefined ||
        (isCap(cur) && !cur.atStart && !NON_INST_PREFIX.has(lw)) ||
        (isCap(cur) && cur.atStart && (known.nameEntry(lw) !== undefined || GENERIC_INST_MODIFIERS.has(lw) || capShare(lw) >= 0.45));
      const isInstMod = GENERIC_INST_MODIFIERS.has(lw) || INSTITUTION_HEADS.has(lw);
      const isAmbigShopName =
        j === i - 1 &&
        known.ambigNameFor(lw) !== undefined &&
        (hSplit.head === "pastanesi" || hSplit.head === "bakkaliyesi" || hSplit.head === "lokantası" || hSplit.head === "restoranı" || hSplit.head === "oteli" || hSplit.head === "kafesi" || hSplit.head === "fırını" || hSplit.head === "eczanesi" || hSplit.head === "kitabevi" || hSplit.head === "yayınevi" || hSplit.head === "lisesi" || hSplit.head === "koleji" || hSplit.head === "hastanesi" || hSplit.head === "üniversitesi" || hSplit.head === "bankası");
      // Check if `cur` is a strong proper anchor (not just a generic modifier like "tıp" or "devlet")
      if (isNameToken && !NON_INST_PREFIX.has(lw) && !GENERIC_INST_MODIFIERS.has(lw)) {
        hasProperAnchor = true;
        startIdx = j;
        continue;
      }
      if (isAmbigShopName) {
        hasProperAnchor = true;
        startIdx = j;
        continue;
      }
      if (INSTITUTION_HEADS.has(lw) && (cur.locked || isCap(cur))) {
        // Preceded by an already-identified university/institution ("Ankara Üniversitesi siyasal bilgiler fakültesi")
        hasProperAnchor = true;
        startIdx = j;
        break;
      }
      if (isInstMod) {
        // Specific capitalized institution prefixes at start ("Bankacılık düzenleme ve denetleme kurumunun", "Sosyal Güvenlik")
        if (isCap(cur) && !cur.atStart && !NON_INST_PREFIX.has(lw)) hasProperAnchor = true;
        if (lw === "dokuz" || lw === "ondokuz" || lw === "marmara" || lw === "boğaziçi" || lw === "uludağ" || lw === "osmangazi" || lw === "hacettepe" || lw === "gazi" || lw === "ege" || lw === "anadolu" || lw === "ziraat" || lw === "içişleri" || lw === "dışişleri" || lw === "bankacılık" || lw === "sosyal" || lw === "bakanlar" || lw === "meteoroloji" || lw === "radyo" || lw === "diyanet") {
          hasProperAnchor = true;
        }
        startIdx = j;
        continue;
      }
      break;
    }
    // Trim leading conjunctions ("ve", "ile")
    while (startIdx < i && (tokens[startIdx]!.low === "ve" || tokens[startIdx]!.low === "ile")) startIdx++;
    // Guard against bare generic phrases like "tıp fakültesi", "hukuk fakültesi", "devlet hastanesi", "ilçe belediyesi"
    // and indefinite appositives like "bir Irak hastanesinde", "bir Pakistan askeri mahkemesi", "Sony Mobile şirketi", "Beta Gençlikspor kulübü".
    if (startIdx >= i || !hasProperAnchor) continue;
    if (startIdx > 0 && tokens[startIdx - 1]!.low === "bir") continue;
    if (tokens[startIdx]!.gapBefore.endsWith("-")) continue;
    if (
      startIdx === i - 1 &&
      GENERIC_ALONE_INST_HEADS.has(hSplit.head) &&
      NON_INST_PREFIX.has(tokens[startIdx]!.low)
    ) {
      continue;
    }
    const APPOSITIVE_INST_HEADS = new Set([
      "şirketi", "kulübü", "kütüphanesi", "müzesi", "partisi", "elçiliği", "komisyonu", "belediyesi",
      "hastanesi", "okulu", "mahkemesi",
    ]);
    // Do not capitalize generic appositive heads ("Sony Mobile şirketi", "Beta Gençlikspor kulübü",
    // "Tiegs for Two bölümünde", "Kurbin belediyesinde") unless anchored by a canonical Turkish institution modifier
    // ("Büyükşehir Belediyesi", "Şehir Hastanesi", "Devlet Hastanesi", "Ankara Üniversitesi ... Bölümü").
    if (APPOSITIVE_INST_HEADS.has(hSplit.head)) {
      const hasStrongTurkishInstMod =
        prev.low === "büyükşehir" ||
        prev.low === "şehir" ||
        prev.low === "devlet" ||
        prev.low === "genel" ||
        prev.low === "yüksek" ||
        (hSplit.head === "belediyesi" && known.nameEntry(prev.low) !== undefined && startIdx === i - 1 && ["istanbul", "ankara", "izmir", "bursa", "antalya", "adana", "konya", "kadıköy", "beşiktaş", "çankaya", "üsküdar", "bakırköy", "karşıyaka", "bornova", "şişli", "beyoğlu", "fatih"].includes(prev.low));
      if (!hasStrongTurkishInstMod) continue;
    }
    if (hSplit.head === "bölümü") {
      // Only capitalize "Bölümü" when preceded by an already-capitalized university/faculty/department chain ("Ankara Üniversitesi ... Bölümü")
      let hasUnivAnchor = false;
      for (let j = startIdx; j < i; j++) {
        if (tokens[j]!.low === "üniversitesi" || tokens[j]!.low === "fakültesi" || tokens[j]!.low === "edebiyatı") {
          hasUnivAnchor = true;
          break;
        }
      }
      if (!hasUnivAnchor) continue;
    }
    // Two-word "<Nationality> kulübü/başkanlığı/kütüphanesi/bölümü/mahkemesi/müzesi/müdürlüğü" is generic ("Alman kulübü", "Amerikan başkanlığı").
    const NATIONALITY_GENERIC_MOD = new Set([
      "alman", "fransız", "ingiliz", "amerikan", "italyan", "ispanyol", "rus", "yunan", "japon",
      "çin", "türk", "osmanlı", "sovyet", "avrupa", "asya", "afrika", "arap", "ermeni", "yahudi",
      "kürt", "rum", "bulgar", "sırp", "macar", "hollanda", "belçika", "isveç", "norveç", "polonya",
    ]);
    const GENERIC_NAT_INST_HEADS = new Set([
      "kulübü", "başkanlığı", "idaresi", "müdürlüğü", "bölümü", "kütüphanesi", "müzesi",
      "mahkemesi", "komitesi", "konseyi", "partisi", "birliği", "federasyonu", "derneği",
      "vakfı", "şirketi", "tiyatrosu", "operası", "hastanesi", "okulu", "fakültesi",
    ]);
    if (
      startIdx === i - 1 &&
      NATIONALITY_GENERIC_MOD.has(tokens[startIdx]!.low) &&
      GENERIC_NAT_INST_HEADS.has(hSplit.head)
    ) {
      continue;
    }

    for (let j = startIdx; j < i; j++) {
      const cur = tokens[j]!;
      if (cur.locked) continue;
      if (cur.low === "ve" || cur.low === "ile") {
        setToken(cur, cur.low, true);
      } else {
        const ne = lookupName(cur.low, sentenceHasAsciiFixes);
        const acro = known.acronymFor(cur.low);
        setToken(cur, acro ?? ne?.name ?? capTr(cur.eff), true);
      }
    }
    // Institution head ALWAYS has NO apostrophe per TDK!
    setToken(tok, capTr(hSplit.head) + hSplit.suffix, true);
  }

  // 6b. Compositional Geographic / Landmark / State / Event Phrases
  //     ("Sapanca gölü", "Beyşehir gölü", "Sahra çölü", "Çanakkale boğazı", "Süveyş kanalı",
  //      "Cebelitarık boğazı", "Kaçkar dağları", "Maçka parkında", "Kocatepe camisinin", "Kore savaşı", "Mohaç savaşı")
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord || tok.locked) continue;
    const prev = tokens[i - 1]!;
    if (!prev.isWord || !adjSpace(prev, tok) || prev.low.includes("'") || prev.gapBefore.endsWith("-")) continue;
    // Never treat an ALL-CAPS TV/media acronym ("CBS kanalında", "TRT kanalında") as a geographic canal/place!
    if (isAllCaps(prev)) continue;

    const geoSplit = splitHeadWord(tok.low, GEO_HEADS);
    const stateSplit = !geoSplit ? splitHeadWord(tok.low, STATE_HEADS) : null;
    const eventSplit = !geoSplit && !stateSplit ? splitHeadWord(tok.low, EVENT_HEADS) : null;
    const headSplit = geoSplit ?? stateSplit ?? eventSplit;
    if (!headSplit) continue;
    // Skip already-capitalized words (core addApostrophes handles them; avoids rewriting clean Wikipedia forms).
    if (isCap(tok) && !headSplit.hadApostrophe) continue;
    // "boğazı/sokağı" after a person name or non-place word ("Ahmet boğazında") is anatomical/common, not geographic!
    if ((headSplit.head === "boğazı" || headSplit.head === "sokağı") && known.givenNameFor(prev.low) && !known.nameEntry(prev.low)) {
      continue;
    }

    // Require previous word to be a proper name, capitalized mid-sentence name, or known place/nationality
    const prevName = lookupName(prev.low, sentenceHasAsciiFixes);
    const strictKnownHead =
      headSplit.head === "kanalı" ||
      headSplit.head === "sokağı" ||
      headSplit.head === "savaşı" ||
      headSplit.head === "dağları" ||
      headSplit.head === "mahallesi";
    const prevIsAnchor = strictKnownHead
      ? prevName !== undefined || prev.locked
      : prevName !== undefined ||
        prev.locked ||
        (isCap(prev) && !prev.atStart && !NON_INST_PREFIX.has(prev.low)) ||
        (prev.atStart && capShare(prev.low) >= 0.5 && !NON_INST_PREFIX.has(prev.low));
    if (!prevIsAnchor) continue;
    // Do NOT treat common non-proper words before "kalesi"/"savaşı"/"devri" as proper places,
    // and do NOT treat generic ethnic/religious quarters ("Yahudi mahallesinin", "Rum mahallesi") as named administrative mahalles.
    if (NON_INST_PREFIX.has(prev.low)) continue;
    if (
      headSplit.head === "mahallesi" &&
      (prev.low === "yahudi" || prev.low === "ermeni" || prev.low === "rum" || prev.low === "türk" || prev.low === "yunan" || prev.low === "arap" || prev.low === "kürt" || prev.low === "çin" || prev.low === "italyan" || prev.low === "fransız" || prev.low === "alman")
    ) {
      continue;
    }

    if (!prev.locked) {
      setToken(prev, prevName?.name ?? capTr(prev.eff), true);
    }
    setToken(tok, formatProper(capTr(headSplit.head), headSplit.suffix, true), true);
  }

  // 6c. Direction word BEFORE a proper place ("batı anadolu" -> "Batı Anadolu", "doğu karadeniz" -> "Doğu Karadeniz")
  for (let i = 0; i < tokens.length - 1; i++) {
    const dir = tokens[i]!;
    const place = tokens[i + 1]!;
    if (!dir.isWord || !place.isWord || dir.locked || !adjSpace(dir, place)) continue;
    if (!DIRECTIONS.has(dir.low)) continue;
    const pLow = place.low.split("'")[0]!;
    const pEntry = known.nameEntry(pLow);
    if (!pEntry || pEntry.noApos) continue;
    // Only capitalize direction before geographic/place names (exclude person names like "orta ahmet")
    if (known.givenNameFor(pLow) && !pLow.endsWith("ya") && pLow !== "anadolu" && pLow !== "asya" && pLow !== "avrupa" && pLow !== "afrika" && pLow !== "amerika" && pLow !== "karadeniz" && pLow !== "akdeniz" && pLow !== "trakya" && pLow !== "ege" && pLow !== "marmara" && pLow !== "kore" && pLow !== "almanya" && pLow !== "berlin" && pLow !== "şeria" && pLow !== "sahra") {
      continue;
    }
    setToken(dir, capTr(dir.eff), true);
  }

  // ===========================================================================
  // STEP 7: Titles, Ranks, Honorifics, Kinship, Media Titles & Person Chains
  // ===========================================================================
  // 7a. Abbreviated title chains before a person name ("prof. dr. halil inalcık'ın", "op. dr. sinan güler'in",
  //     "av. melike sönmez", "dr. şebnem koç'tan", "Dekan doç. dr. barış sezer", "av. ece çınar")
  for (let i = 0; i < tokens.length - 1; i++) {
    const t0 = tokens[i]!;
    if (!t0.isWord || !PRE_TITLES_ABBR.has(t0.low)) continue;
    // Collect consecutive abbreviated titles ("Prof. Dr.", "Op. Dr.", "Doç. Dr.", "Yrd. Doç. Dr.")
    let endTitle = i;
    while (
      endTitle + 1 < tokens.length &&
      adjDotSpace(tokens[endTitle]!, tokens[endTitle + 1]!) &&
      PRE_TITLES_ABBR.has(tokens[endTitle + 1]!.low)
    ) {
      endTitle++;
    }
    const nameIdx = endTitle + 1;
    if (nameIdx >= tokens.length || !adjDotSpace(tokens[endTitle]!, tokens[nameIdx]!)) continue;
    const firstTok = tokens[nameIdx]!;
    const g = resolveGivenName(firstTok) ?? resolveSurname(firstTok, false);
    const firstIsPerson = g !== null || (isCap(firstTok) && !firstTok.atStart);
    if (!firstIsPerson) continue;

    // Capitalize any full rank or "Sayın" immediately preceding the abbreviated title chain ("Dekan doç. dr. barış sezer", "Sayın prof. dr.")
    if (i > 0 && adjSpace(tokens[i - 1]!, t0) && (PRE_TITLES_FULL.has(tokens[i - 1]!.low) || tokens[i - 1]!.low === "sayın")) {
      setToken(tokens[i - 1]!, capTr(tokens[i - 1]!.eff), true);
    }
    for (let k = i; k <= endTitle; k++) {
      setToken(tokens[k]!, capTr(tokens[k]!.eff), true);
    }
    if (g && !firstTok.locked) {
      setToken(firstTok, formatProper(g.display, g.suffix, true), true);
    }
    // Also capitalize following surname ("Melike Sönmez", "Halil İnalcık'ın", "Sinan Güler'in", "Şebnem Koç'tan", "Barış Sezer", "Ece Çınar")
    const surIdx = nameIdx + 1;
    if (surIdx < tokens.length && adjSpace(firstTok, tokens[surIdx]!) && (!g || !g.suffix)) {
      const surTok = tokens[surIdx]!;
      const sur = resolveSurname(surTok, true);
      if (sur && !surTok.locked) {
        setToken(surTok, formatProper(sur.display, sur.suffix, true), true);
      } else if (!surTok.locked && surTok.isWord && !isCap(surTok) && surTok.low.includes("'")) {
        const ap = surTok.low.indexOf("'");
        setToken(surTok, capTr(surTok.eff.slice(0, ap)) + surTok.eff.slice(ap), true);
      }
    }
    i = endTitle;
  }

  // 7b. Pre-nominal full titles / ranks ("bayan elif tan", "cumhurbaşkanı ismet inönü'nün", "albay nurettin şahin'in",
  //     "Kaymakam sena tunç'a", "Hâkim nermin oral", "Kaptan rüştü alkan", "Başkomiser nazlı ekinci", "mimar sinanın", "Bay Kaya")
  for (let i = 0; i < tokens.length - 1; i++) {
    const titleTok = tokens[i]!;
    if (!titleTok.isWord || !PRE_TITLES_FULL.has(titleTok.low)) continue;
    const nextTok = tokens[i + 1]!;
    if (!nextTok.isWord || !adjSpace(titleTok, nextTok)) continue;
    const g = resolveGivenName(nextTok) ?? ((titleTok.low === "bay" || titleTok.low === "bayan" || titleTok.low === "doktor" || titleTok.low === "avukat" || titleTok.low === "profesör" || titleTok.low === "albay" || titleTok.low === "komiser" || titleTok.low === "kaptan") ? resolveSurname(nextTok, false) : null);
    if (!g) continue;
    const surTok = i + 2 < tokens.length && adjSpace(nextTok, tokens[i + 2]!) ? tokens[i + 2] : undefined;
    const sur = !g.suffix && surTok ? resolveSurname(surTok, true) : null;
    const strongFirst =
      known.nameEntry(lowerTr(g.display)) !== undefined ||
      sur !== null ||
      titleTok.low === "bay" ||
      titleTok.low === "bayan" ||
      titleTok.low === "mimar" ||
      titleTok.low === "gazi" ||
      titleTok.low === "albay" ||
      titleTok.low === "kaymakam" ||
      titleTok.low === "hâkim" ||
      titleTok.low === "hakim" ||
      titleTok.low === "savcı" ||
      titleTok.low === "başsavcı" ||
      titleTok.low === "kaptan" ||
      titleTok.low === "başkomiser" ||
      titleTok.low === "komiser" ||
      titleTok.low === "büyükelçi" ||
      titleTok.low === "başhekim" ||
      titleTok.low === "cumhurbaşkanı";
    if (!strongFirst) continue;

    // Also capitalize a two-word rank prefix ("belediye başkanı ...", "dışişleri bakanı ...", "genel müdür ...")
    if (
      i > 0 &&
      adjSpace(tokens[i - 1]!, titleTok) &&
      (tokens[i - 1]!.low === "belediye" ||
        tokens[i - 1]!.low === "genel" ||
        tokens[i - 1]!.low === "bölüm" ||
        tokens[i - 1]!.low === "okul" ||
        tokens[i - 1]!.low === "meclis" ||
        tokens[i - 1]!.low === "cumhuriyet" ||
        tokens[i - 1]!.low === "dışişleri" ||
        tokens[i - 1]!.low === "içişleri" ||
        tokens[i - 1]!.low === "sağlık" ||
        tokens[i - 1]!.low === "adalet" ||
        tokens[i - 1]!.low === "maliye" ||
        tokens[i - 1]!.low === "savunma")
    ) {
      setToken(tokens[i - 1]!, capTr(tokens[i - 1]!.eff), true);
    }
    setToken(titleTok, capTr(titleTok.eff), true);
    if (!nextTok.locked) setToken(nextTok, formatProper(g.display, g.suffix, true), true);
    if (sur && surTok && !surTok.locked) {
      setToken(surTok, formatProper(sur.display, sur.suffix, true), true);
    }
  }

  // 7c. Vocative "Sayın + <OfficialTitle>" (1–3 words: "Sayın Başkan", "Sayın Genel Müdür", "Sayın Belediye Başkanı")
  for (let i = 0; i < tokens.length - 1; i++) {
    const sayin = tokens[i]!;
    const role = tokens[i + 1]!;
    if (!sayin.isWord || !role.isWord || sayin.low !== "sayın" || !adjSpace(sayin, role)) continue;
    if (SAYIN_TITLES.has(role.low)) {
      if (!sayin.locked && sayin.atStart) setToken(sayin, "Sayın", true);
      setToken(role, capTr(role.eff), true);
      for (let k = i + 2; k <= Math.min(i + 3, tokens.length - 1); k++) {
        if (!adjSpace(tokens[k - 1]!, tokens[k]!)) break;
        const w = tokens[k]!.low;
        if (SAYIN_TITLES.has(w) || SAYIN_COMPOUND_TAIL.has(w)) {
          setToken(tokens[k]!, capTr(tokens[k]!.eff), true);
        } else {
          break;
        }
      }
    } else if (
      SAYIN_COMPOUND_FIRST.has(role.low) &&
      i + 2 < tokens.length &&
      adjSpace(role, tokens[i + 2]!) &&
      (SAYIN_TITLES.has(tokens[i + 2]!.low) || SAYIN_COMPOUND_TAIL.has(tokens[i + 2]!.low))
    ) {
      if (!sayin.locked && sayin.atStart) setToken(sayin, "Sayın", true);
      setToken(role, capTr(role.eff), true);
      setToken(tokens[i + 2]!, capTr(tokens[i + 2]!.eff), true);
      if (i + 3 < tokens.length && adjSpace(tokens[i + 2]!, tokens[i + 3]!) && SAYIN_COMPOUND_TAIL.has(tokens[i + 3]!.low)) {
        setToken(tokens[i + 3]!, capTr(tokens[i + 3]!.eff), true);
      }
    }
  }

  // 7d. Post-nominal honorifics ("Ayşe hanım", "Mahmut efendiye", "kerem bey", "orhan beyde",
  //     "Kâzım karabekir paşanın", "hakan beye", "Saadet hanımın", "cihan beyin", "gönül hanımda", "kaya bey", "muhsin bey")
  for (let i = 1; i < tokens.length; i++) {
    const honTok = tokens[i]!;
    if (!honTok.isWord || honTok.locked) continue;
    const hSplit = splitHonorific(honTok.low);
    if (!hSplit) continue;
    const prev = tokens[i - 1]!;
    if (!prev.isWord || !adjSpace(prev, honTok)) continue;

    // Guard bare "-ı/-i" suffix ("Sancak Beyi Berham Bey", "Osmanlı beyi", "Türk hanımı"):
    // only treat as accusative ("Ayşe Hanım'ı", "Kerem Bey'i") when preceded by a real person's given name and NOT followed by a given name!
    if ((hSplit.suffix === "ı" || hSplit.suffix === "i") && !hSplit.hadApostrophe) {
      if (!known.givenNameFor(prev.low)) continue;
      const afterHon = i + 1 < tokens.length && adjSpace(honTok, tokens[i + 1]!) ? tokens[i + 1] : undefined;
      if (afterHon && (known.givenNameFor(afterHon.low) || isCap(afterHon))) continue;
    }

    // Check if previous word is a person name (never a sentence-start occupation like "Memur bey", "Doktor bey", "Hemşire hanım")
    const prevDisp =
      known.givenNameFor(prev.low) ??
      known.surnameFor(prev.low) ??
      known.ambigNameFor(prev.low) ??
      (known.nameEntry(prev.low) && !known.nameEntry(prev.low)!.noApos ? known.nameFor(prev.low) : undefined) ??
      (isCap(prev) && !prev.atStart && !NON_INST_PREFIX.has(prev.low) && !PRE_TITLES_FULL.has(prev.low) ? prev.eff : undefined);
    if (!prevDisp || NON_INST_PREFIX.has(prev.low) || PRE_TITLES_FULL.has(prev.low)) continue;
    // Guard against "sayın bey", "genç bey", "yaşlı hanım", "güzel hanım", "küçük bey"
    if (prev.low === "sayın" || prev.low === "genç" || prev.low === "yaşlı" || prev.low === "güzel" || prev.low === "küçük" || prev.low === "büyük" || prev.low === "sevgili" || prev.low === "değerli" || prev.low === "kibar" || prev.low === "efendi") {
      continue;
    }

    if (!prev.locked) setToken(prev, prevDisp, true);
    // Also capitalize a preceding given name if `prev` was a surname ("Kâzım karabekir paşanın")
    if (i >= 2 && adjSpace(tokens[i - 2]!, prev) && !tokens[i - 2]!.locked) {
      const p2 = tokens[i - 2]!;
      const p2Disp = known.givenNameFor(p2.low) ?? known.nameFor(p2.low);
      if (p2Disp && !NON_INST_PREFIX.has(p2.low) && (isCap(p2) || known.surnameFor(prev.low) !== undefined)) {
        setToken(p2, p2Disp, true);
      }
    }
    setToken(honTok, formatProper(hSplit.displayHead, hSplit.suffix, true), true);
  }

  // 7e. Kinship cue ("tülay ablama", "zehra halamın", "rıza enişteme", "hatice ninemin")
  //     Kinship word stays LOWERCASE per TDK; preceding person name gets capitalized!
  for (let i = 1; i < tokens.length; i++) {
    const kin = tokens[i]!;
    if (!kin.isWord || !isKinshipWord(kin.low)) continue;
    const prev = tokens[i - 1]!;
    if (!prev.isWord || prev.locked || !adjSpace(prev, kin)) continue;
    const disp = known.givenNameFor(prev.low) ?? known.nameFor(prev.low);
    if (disp && !NON_INST_PREFIX.has(prev.low) && !COMMON_GIVEN_ADJECTIVES.has(prev.low) && prev.low !== "küçük" && prev.low !== "büyük" && prev.low !== "sevgili" && prev.low !== "canım") {
      setToken(prev, disp, true);
    }
  }

  // 7f. Nominative relationship/occupation descriptor before person name ("arkadaşım melek", "komşumuz baharın",
  //     "kardeşim ateş", "arkadaşım umut", "genç yazar defne arslan", "adı elif demirtaş")
  for (let i = 0; i < tokens.length - 1; i++) {
    const rel = tokens[i]!;
    if (!rel.isWord || !PERSON_REL_BEFORE.has(rel.low)) continue;
    const nameTok = tokens[i + 1]!;
    if (!nameTok.isWord || !adjSpace(rel, nameTok)) continue;
    const g = resolveGivenName(nameTok);
    if (!g) continue;
    const surTok = !g.suffix && i + 2 < tokens.length && adjSpace(nameTok, tokens[i + 2]!) ? tokens[i + 2] : undefined;
    const sur = surTok ? resolveSurname(surTok, true) : null;
    // Avoid false alarms like "kızım mutlu oldu", "oğlum zeki bir çocuk", "yazar metin boyunca" unless followed by a surname
    // OR the ambiguous name is a genuine personal name frame (not an adjective followed by a predicate/noun)
    const bareLow = lowerTr(g.display);
    if (
      !g.suffix &&
      !sur &&
      COMMON_GIVEN_ADJECTIVES.has(bareLow) &&
      !["melek", "ateş", "umut", "bahar", "deniz", "can", "barış", "gül", "ırmak", "özlem", "sevgi", "defne", "doruk", "pınar", "gönül", "aslı", "cihan", "saadet", "çiçek", "yağmur", "toprak", "bulut", "güneş", "yıldız", "kader", "nur", "ipek", "evren", "kaya"].includes(bareLow)
    ) {
      continue;
    }
    if (!nameTok.locked) setToken(nameTok, formatProper(g.display, g.suffix, true), true);
    if (sur && surTok && !surTok.locked) {
      setToken(surTok, formatProper(sur.display, sur.suffix, true), true);
    }
  }

  // 7g. Media / Publication titles ("varlık dergisine") & Author's classic novel ("Tanpınar'ın huzurunu okumak")
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord) continue;
    const prev = tokens[i - 1]!;
    if (prev.isWord && !prev.locked && adjSpace(prev, tok) && isMediaTypeWord(tok.low)) {
      if (SINGLE_WORD_PUBLICATIONS.has(prev.low)) {
        setToken(prev, capTr(prev.low), true);
      }
    }
    // "<Author>'ın <SingleWordWork>[suffix]" + reading/book context
    if (prev.isWord && adjSpace(prev, tok) && isCap(prev) && /'(?:ın|in|un|ün|nın|nin|nun|nün)$/.test(prev.low)) {
      for (const work of SINGLE_WORD_WORKS) {
        if (!tok.low.startsWith(work) || tok.low.length <= work.length) continue;
        const suf = tok.low.slice(work.length);
        if (!PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) || !isPhonologicallyValidProperSuffix(work, suf)) continue;
        // Require a reading/literary cue in the rest of the sentence
        const hasReadingCtx = tokens.some((t, idx) => idx !== i && t.isWord && READING_CTX_RE.test(t.low));
        if (hasReadingCtx) {
          setToken(tok, `${capTr(work)}'${suf}`, true);
          break;
        }
      }
    }
  }

  // 7h. [FirstName] + [Surname] & [PersonName] ile/ve [PersonName]
  //     ("hüseyin çelik", "hatice şahin", "cengiz ateş", "hasan tekin", "erkin bulut", "Elif kayanın",
  //      "barış Manço'nun", "yaşar kemalin", "barış mançonun", "yunus emrenin", "ece ile ali", "nur ile yavuz",
  //      "aylin ile doruk", "atakan ile ece şen")
  for (let i = 0; i < tokens.length - 1; i++) {
    const t1 = tokens[i]!;
    const t2 = tokens[i + 1]!;
    if (!t1.isWord || !t2.isWord || !adjSpace(t1, t2)) continue;

    // Case 1: t1 is a strong/capitalized/unconditional Turkish first name, t2 is a surname (bare or suffixed)
    const t1Uncond = known.nameEntry(t1.low);
    const t1Given = known.givenNameFor(t1.low);
    const t1StrongFirst =
      (t1Uncond !== undefined && !t1Uncond.noApos && t1Given !== undefined) ||
      (t1Given !== undefined && isCap(t1) && !t1.atStart) ||
      (t1.locked && t1Given !== undefined);

    if (t1StrongFirst && !t2.locked) {
      const sur = resolveSurname(t2, true);
      if (sur) {
        const nextTok = i + 2 < tokens.length && adjSpace(t2, tokens[i + 2]!) ? tokens[i + 2] : undefined;
        // Guard common-word surnames against noun-noun compounds ("çelik tencere", "güneş gözlüğü") and object verbs ("ateş yaktı", "çiçek topladı")
        let blocked = false;
        if (sur.isCommon) {
          if (nextTok && COMMON_OBJECT_AFTER_SURNAME_VERBS.has(nextTok.low)) blocked = true;
          if (!sur.suffix && nextTok && lexPair(t2.low, nextTok.low) >= 25 && !NON_INST_PREFIX.has(nextTok.low)) blocked = true;
          // Also block if t2 is an ambiguous word and the sentence starts with a common noun (e.g. "Bahar geldi", not a first name!)
          if (t1.atStart && !t1Uncond) blocked = true;
        }
        if (!blocked) {
          if (!t1.locked) setToken(t1, t1Uncond?.name ?? t1Given!, true);
          setToken(t2, formatProper(sur.display, sur.suffix, true), true);
          i++;
          continue;
        }
      }
    }

    // Case 2: t1 is an ambiguous/known first name AND t2 is an UNAMBIGUOUS or already-capitalized surname
    // ("barış Manço'nun", "barış mançonun", "erkin bulut", "yaşar kemalin", "yunus emrenin")
    // NEVER match `known.nameEntry(t2)` here (that matches cities/countries like "arda Meksika'da"!).
    if (!t1.locked && t1Given && t1.low.length >= 3 && !NON_INST_PREFIX.has(t1.low)) {
      const surUnambig = resolveSurname(t2, false);
      const t2Base = t2.low.split("'")[0]!;
      const t2AlreadyCapSur =
        isCap(t2) &&
        !t2.atStart &&
        known.surnameFor(t2Base) !== undefined;
      if (surUnambig || t2AlreadyCapSur) {
        setToken(t1, t1Given, true);
        if (surUnambig && !t2.locked) {
          setToken(t2, formatProper(surUnambig.display, surUnambig.suffix, true), true);
        }
      } else if (
        // Pair of Turkish first name + surname where first name has high capShare (>=0.55, e.g. "erkin", "yaşar", "yunus")
        capShare(t1.low) >= 0.55 &&
        !t2.locked
      ) {
        const surAny = resolveSurname(t2, true);
        if (surAny) {
          const nextTok = i + 2 < tokens.length && adjSpace(t2, tokens[i + 2]!) ? tokens[i + 2] : undefined;
          const nextBlocks =
            surAny.isCommon &&
            nextTok !== undefined &&
            (COMMON_OBJECT_AFTER_SURNAME_VERBS.has(nextTok.low) ||
              (!surAny.suffix && lexPair(t2.low, nextTok.low) >= 25 && !NON_INST_PREFIX.has(nextTok.low)));
          if (!nextBlocks) {
            setToken(t1, t1Given, true);
            setToken(t2, formatProper(surAny.display, surAny.suffix, true), true);
          }
        }
      }
    }

    // Case 3: Coordination "[PersonName] (ile|ve) [PersonName]" ("ece ile ali", "nur ile yavuz", "aylin ile doruk", "atakan ile ece şen")
    if (i + 2 < tokens.length && (t2.low === "ile" || t2.low === "ve") && adjSpace(t2, tokens[i + 2]!)) {
      const t3 = tokens[i + 2]!;
      const t1IsPerson =
        (known.givenNameFor(t1.low) !== undefined && (known.nameEntry(t1.low) !== undefined || isCap(t1) || t1.locked)) ||
        (t1.atStart && known.givenNameFor(t1.low) !== undefined && capShare(t1.low) >= 0.55);
      const t3IsPerson =
        known.givenNameFor(t3.low) !== undefined && (known.nameEntry(t3.low) !== undefined || isCap(t3) || t3.locked);
      const t1GivenDisp = known.givenNameFor(t1.low);
      const t3GivenDisp = known.givenNameFor(t3.low);
      if (t1IsPerson && t3GivenDisp && !t3.locked) {
        const nextTok = i + 3 < tokens.length && adjSpace(t3, tokens[i + 3]!) ? tokens[i + 3] : undefined;
        // Guard against "Ahmet ile barış yaptık" / "Ayşe ile umut doluyuz"
        const idiomBlock =
          known.ambigNameFor(t3.low) !== undefined &&
          nextTok !== undefined &&
          (COMMON_OBJECT_AFTER_SURNAME_VERBS.has(nextTok.low) || lexPair(t3.low, nextTok.low) >= 40);
        if (!idiomBlock) {
          if (!t1.locked && t1GivenDisp) setToken(t1, t1GivenDisp, true);
          setToken(t3, t3GivenDisp, true);
          // Optional surname after coordinated person ("atakan ile ece şen")
          if (nextTok && !nextTok.locked) {
            const sur = resolveSurname(nextTok, true);
            if (sur) {
              const afterSur = i + 4 < tokens.length && adjSpace(nextTok, tokens[i + 4]!) ? tokens[i + 4] : undefined;
              const surBlocked =
                sur.isCommon &&
                afterSur !== undefined &&
                (COMMON_OBJECT_AFTER_SURNAME_VERBS.has(afterSur.low) || lexPair(nextTok.low, afterSur.low) >= 25);
              if (!surBlocked) setToken(nextTok, formatProper(sur.display, sur.suffix, true), true);
            }
          }
        }
      } else if (t3IsPerson && t1GivenDisp && !t1.locked && !NON_INST_PREFIX.has(t1.low)) {
        setToken(t1, t1GivenDisp, true);
      }
    }
  }

  // ===========================================================================
  // STEP 8: Single-word Proper Names, Acronyms, Languages, Non-Softening Ambiguous Inflections
  // ===========================================================================
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.isWord || tok.locked) continue;
    if (isAllCaps(tok) || isMixedInnerCap(tok)) continue;
    // Skip words that still contain apostrophe (already handled in Step 4)
    if (tok.low.includes("'")) continue;

    const low = tok.low;
    const prevTok = i > 0 ? tokens[i - 1] : undefined;
    const nextTok = i + 1 < tokens.length ? tokens[i + 1] : undefined;

    // 8a. Special contextual rules for "alman" and "alevi" (high-frequency proper nouns with 1 rare homograph each)
    if (low === "alman") {
      const verbalNext = nextTok !== undefined && ALMAN_VERBAL_NEXT.has(nextTok.low);
      const accPrev = prevTok !== undefined && /(?:ini|ını|unu|ünü|yi|yı|yu|yü)$/.test(prevTok.low);
      if (!verbalNext && !accPrev) {
        setToken(tok, "Alman", true);
        continue;
      }
    }
    if (low === "alevi") {
      const hasSectCtx = tokens.some((t, idx) => idx !== i && Math.abs(idx - i) <= 4 && ALEVI_SECT_CTX.has(t.low));
      if (hasSectCtx) {
        setToken(tok, "Alevi", true);
        continue;
      }
    }

    // 8b. Acronyms (bare 3+ letters, or suffixed 2+ letters: "tbmmde" -> "TBMM'de", "İtüye" -> "İTÜ'ye", "abye" -> "AB'ye", "natonun" -> "NATO'nun")
    const bareAcro = low.length >= 3 ? known.acronymFor(low) : undefined;
    if (bareAcro && !isCommonWordCollision(low, low)) {
      setToken(tok, bareAcro, true);
      continue;
    }
    // Suffixed acronym (works for lowercase AND sentence-case like "İtüye", "Abye", "Tbmmde", "Natonun"!)
    if (low.length >= 4) {
      let matchedAcro = false;
      for (let cut = Math.min(low.length - 1, 8); cut >= 2; cut--) {
        const base = low.slice(0, cut);
        const suf = low.slice(cut);
        const acro = known.acronymFor(base) ?? (base.length >= 3 && !isMorphWord(base) ? known.asciiAcronymFor(base) : undefined);
        if (!acro) continue;
        if (isCommonWordCollision(low, base)) continue;
        if (isPhonologicallyValidProperSuffix(base, suf, { acronym: true })) {
          setToken(tok, `${acro}'${suf}`, true);
          matchedAcro = true;
          break;
        }
      }
      if (matchedAcro) continue;
    }

    // 8c. Bare unconditional proper name ("ahmet" -> "Ahmet", "istanbul" -> "İstanbul", "türkçe" -> "Türkçe", "macka" -> "Maçka")
    if (!isCap(tok)) {
      const bareName = lookupName(low, sentenceHasAsciiFixes);
      if (bareName) {
        setToken(tok, bareName.name, true);
        continue;
      }
    }

    // 8d. Suffixed unconditional proper name (works BOTH lowercase mid-sentence AND sentence-start like "Özgeyi", "Boludan", "Türkiyemizin"!)
    //     Skip mid-sentence already-capitalized words (core `addApostrophes` already handles those!).
    if (!isCap(tok) || tok.atStart) {
      let matchedName = false;
      const allowAscii = sentenceHasAsciiFixes || !textHasTurkishMarks;
      for (let cut = low.length - 1; cut >= 3; cut--) {
        const base = low.slice(0, cut);
        const suf = low.slice(cut);
        // Also check "alman" + plural/derivational ("almanlar", "almanların", "alman'sınız")
        const entry =
          base === "alman"
            ? { name: "Alman", count: 40000, noApos: false }
            : lookupName(base, allowAscii);
        if (!entry) continue;
        const baseLow = lowerTr(entry.name);

        // Guard against common-word collisions ("belli", "hatayı", "türkü", "hindi", "ıraklık"),
        // while allowing strongly proper-name-dominated forms ("taksimde" vs rare "taksi+m+de").
        const strongProperApos = lexCount(`${baseLow}'${suf}`) >= 25 && lexCount(`${baseLow}'${suf}`) >= lexCount(low) * 5;
        if (
          !strongProperApos &&
          isCommonWordCollision(low, baseLow) &&
          !LANGUAGE_NAMES.has(baseLow) &&
          !NO_APOS_RELIGION_OR_DERIVED.has(baseLow)
        ) {
          continue;
        }

        // Case 1: Language / noApos proper noun ("türkçeyi", "yunancanın", "almancanın", "gürcücesini", "türkmencenin", "korecesini", "moğolcadaki", "türkçedekilere", "hinduizmde")
        if (entry.noApos || LANGUAGE_NAMES.has(baseLow) || NO_APOS_RELIGION_OR_DERIVED.has(baseLow)) {
          if (NO_APOS_PROPER_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(baseLow, suf)) {
            setToken(tok, entry.name + suf, true);
            matchedName = true;
            break;
          }
          continue;
        }

        // Case 2: Derivational or plural suffix on proper noun -> NO apostrophe ("lazların", "selçuklular", "hunlar", "ispanyolların", "rumların", "avrupalılar", "japonlar", "türklerin")
        // Protect lowercase common Turkish derivations whose stem collides with a place ("ıraklık" = "parallax", not "Iraklık"!).
        if (NON_APOSTROPHE_SUFFIX_RE.test(suf)) {
          if (lexCount(low) >= 3 && capShare(low) < 0.35) continue;
          const firstV = [...suf].find((c) => "aeıioöuü".includes(c));
          const okStart =
            (suf.startsWith("l") || /^[cçs]/.test(suf)) &&
            (!firstV || isPhonologicallyValidProperSuffix(baseLow, suf.slice(0, 3)) || true);
          if (okStart && (isMorphWord(baseLow + suf) || lexCount(baseLow + suf) >= 2 || /^l[ae]r(?:[ıiuü]n(?:d[ae]n?)?|d[ae]n?|[aeıiuü]|l[ae]|$)/.test(suf))) {
            setToken(tok, entry.name + suf, true);
            matchedName = true;
            break;
          }
          continue;
        }

        // Case 3: Inflectional suffix on bare proper noun -> WITH apostrophe ("istanbula" -> "İstanbul'a", "fatmadan" -> "Fatma'dan", "türkiyemizin" -> "Türkiye'mizin", "ahmetinki" -> "Ahmet'inki", "burakin" -> "Burak'ın", "palandokende" -> "Palandöken'de")
        if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(baseLow, suf)) {
          setToken(tok, `${entry.name}'${suf}`, true);
          matchedName = true;
          break;
        }
        if (allowAscii) {
          const harm = harmonizeAsciiSuffix(baseLow, suf);
          if (harm) {
            setToken(tok, `${entry.name}'${harm}`, true);
            matchedName = true;
            break;
          }
        }
      }
      if (matchedName) continue;
    }

    // 8e. Non-softening / morphologically-impossible inflections of AMBIGUOUS names!
    //     E.g. "umutun" -> "Umut'un" (common word is "umudun"), "umuta" -> "Umut'a" ("umuda"),
    //     "emrenin" -> "Emre'nin" (dative "emre" can't take -nin), "aslıyı" -> "Aslı'yı" (common is "aslını"),
    //     "tokata" -> "Tokat'a" ("tokada"), "çiçeke" -> "Çiçek'e" ("çiçeğe"), "ufukun" -> "Ufuk'un" ("ufkun")!
    if ((!isCap(tok) || tok.atStart) && low.length >= 4) {
      let matchedNonSoft = false;
      for (let cut = low.length - 1; cut >= 3; cut--) {
        const base = low.slice(0, cut);
        const suf = low.slice(cut);
        const ambDisp = known.ambigNameFor(base);
        if (!ambDisp) continue;
        const baseLow = lowerTr(ambDisp);
        // Must either fail morphology completely ("umutun", "emrenin", "tokata") OR be completely dominated by the proper-name apostrophe form ("aslıyı" vs Zemberek's bogus "as+lı+yı")
        const nonCommonForm =
          !isMorphWord(low) ||
          (lexCount(low) === 0 && lexCount(`${baseLow}'${suf}`) >= 5);
        if (!nonCommonForm) continue;
        if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(baseLow, suf)) {
          setToken(tok, `${ambDisp}'${suf}`, true);
          matchedNonSoft = true;
          break;
        }
        if (sentenceHasAsciiFixes) {
          const harm = harmonizeAsciiSuffix(baseLow, suf);
          if (harm) {
            setToken(tok, `${ambDisp}'${harm}`, true);
            matchedNonSoft = true;
            break;
          }
        }
      }
      if (matchedNonSoft) continue;
    }

    // 8f. High-precision human-only frames + optional contextual disambiguator for AMBIGUOUS names
    if (!isCap(tok) || tok.atStart) {
      // Bare ambiguous name or suffixed ambiguous name
      let ambBase: string | undefined;
      let ambDisp: string | undefined;
      let ambSuf = "";
      if (known.ambigNameFor(low)) {
        ambBase = low;
        ambDisp = known.ambigNameFor(low)!;
      } else {
        for (let cut = low.length - 1; cut >= 3; cut--) {
          const base = low.slice(0, cut);
          const suf = low.slice(cut);
          const disp = known.ambigNameFor(base);
          if (!disp) continue;
          if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suf) && isPhonologicallyValidProperSuffix(base, suf)) {
            ambBase = base;
            ambDisp = disp;
            ambSuf = suf;
            break;
          }
        }
      }
      if (ambBase && ambDisp) {
        // High-precision human-possessor frame: "<AmbigGiven>'ın annesi/babası/evi/ofisi/masası..."
        if (
          known.givenNameFor(ambBase) !== undefined &&
          /^(?:n?[ıiuü]n)$/.test(ambSuf) &&
          nextTok !== undefined &&
          adjSpace(tok, nextTok) &&
          HUMAN_POSSESSED_NEXT.has(nextTok.low) &&
          // Guard against "toprağın evi"? No, "toprak" softens to "toprağın", so "toprakın" already won in 8e!
          // Guard against "baharın yeni", "kaderin yeni"
          nextTok.low !== "yeni"
        ) {
          setToken(tok, `${ambDisp}'${ambSuf}`, true);
          continue;
        }
        // High-precision human-communication dative frame: "<AmbigGiven>'a/e mesaj at / haber ver / söyle / gönder"
        if (
          known.givenNameFor(ambBase) !== undefined &&
          /^y?[ae]$/.test(ambSuf) &&
          nextTok !== undefined &&
          (nextTok.low === "mesaj" ||
            nextTok.low === "söyle" ||
            nextTok.low === "söyledim" ||
            nextTok.low === "söyleyin" ||
            nextTok.low === "gönderdim" ||
            nextTok.low === "gönder" ||
            nextTok.low === "ilettim" ||
            nextTok.low === "sürpriz" ||
            (nextTok.low === "de" && i + 2 < tokens.length && (tokens[i + 2]!.low === "gönderdim" || tokens[i + 2]!.low === "söyle" || tokens[i + 2]!.low === "yazdım")))
        ) {
          setToken(tok, `${ambDisp}'${ambSuf}`, true);
          continue;
        }
        // High-precision human-companion instrumental frame: "<AmbigGiven>'la/le telefonda / buluş / aynı odada / aynı otobüste / aynı sınıfta / birlikte hazırla"
        if (
          known.givenNameFor(ambBase) !== undefined &&
          /^y?l[ae]$/.test(ambSuf) &&
          nextTok !== undefined &&
          (nextTok.low === "telefonda" ||
            nextTok.low.startsWith("buluş") ||
            (nextTok.low === "aynı" && i + 2 < tokens.length && /^(?:oda|sınıf|otobüs|okul|ev|apartman|masa|takım|grup)/.test(tokens[i + 2]!.low)) ||
            (nextTok.low === "birlikte" && i + 2 < tokens.length && /^(?:hazırl|çalış|git|gid|gel|otur|kal|yap|konuş|yürü)/.test(tokens[i + 2]!.low)))
        ) {
          setToken(tok, `${ambDisp}'${ambSuf}`, true);
          continue;
        }
        // Optional contextual disambiguator (core linear classifier or neural context model)
        if (resources.disambiguateAmbig) {
          const decided = resources.disambiguateAmbig(tokens, i, ambBase, ambDisp, ambSuf, false);
          if (decided) {
            setToken(tok, decided, true);
            continue;
          }
        }
      }
    }
  }

  // ===========================================================================
  // STEP 9: Sentence-Start Capitalization
  // ===========================================================================
  applySentenceStartCapitals(text, result, spaced);
  result.sort((a, b) => a.start - b.start);
  return result;
}

/** Minimal proper-name & title fallback when `applySentenceRules` is called without `resources` (unit tests). */
function applyMinimalRules<T extends AnyCorrection>(
  text: string,
  result: Array<T | SentenceCorrection>,
  spaced: ReadonlySet<number>,
  isWord: (lower: string) => boolean,
  nameFor: (lower: string, common?: boolean) => string | undefined,
  stemsOf: (lower: string) => readonly string[] | null,
): void {
  const covering = (start: number, end: number) => result.findIndex((fix) => fix.start < end && fix.end > start);

  for (const match of text.matchAll(/\p{L}+(?:['’]\p{L}+)?/gu)) {
    const start = match.index;
    const word = match[0];
    const end = start + word.length;
    if (!LOWER.test(word) || /\p{Lu}/u.test(word)) continue;
    if (WORD_CHAR.test(text[start - 1] ?? "") || precededByAddress(text, start)) continue;
    if (continuesAsAddress(text, end) && !spaced.has(end)) continue;
    if (/[\p{N}_]/u.test(text[end] ?? "")) continue;
    if (covering(start, end) !== -1) continue;
    const apostrophe = word.search(/['’]/);
    let replacement: string | undefined;
    if (apostrophe > 0) {
      const name = nameFor(word.slice(0, apostrophe));
      if (name) replacement = name + word.slice(apostrophe);
    } else {
      replacement = nameFor(word);
      const previous = /(\p{L}+)[^\p{L}]*$/u.exec(text.slice(Math.max(0, start - 40), start))?.[1];
      const foreignBefore = previous !== undefined && !/^\p{Lu}/u.test(previous) && !isWord(lowerTr(previous));
      if (!replacement && word.length >= 5 && !foreignBefore) {
        for (let cut = word.length - 1; cut >= 3; cut--) {
          const rest = word.slice(cut);
          if (!FALLBACK_NAME_SUFFIXES.has(rest)) continue;
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

  const TITLES = new Set(["dr", "prof", "doç", "doc", "av", "op", "uzm", "yrd", "öğr", "ogr", "gör", "gor", "sn", "mr", "mrs", "ms"]);
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
}

/** Capitalizes lowercase sentence-initial words (merging into existing single-word fixes at that offset). */
function applySentenceStartCapitals<T extends AnyCorrection>(
  text: string,
  result: Array<T | SentenceCorrection>,
  spaced: ReadonlySet<number>,
): void {
  const covering = (start: number, end: number) => result.findIndex((fix) => fix.start < end && fix.end > start);
  const starts: number[] = [];
  const lead = /^[\s"'“‘«(\[]*/u.exec(text);
  starts.push(lead ? lead[0].length : 0);
  for (const match of text.matchAll(/([.!?…]+)(["'”’»)\]]*)(\s+)(["'“‘«(\[]*)/gu)) {
    const punctStart = match.index;
    const punctEnd = punctStart + match[1]!.length;
    if (!endsSentence(text, punctStart, punctEnd)) continue;
    if (match[2]) continue;
    starts.push(match.index + match[0].length);
  }
  for (const start of starts) {
    if (!LOWER.test(text[start] ?? "")) continue;
    const end = wordEnd(text, start);
    const word = text.slice(start, end);
    if (word.length === 0 || /\p{N}/u.test(word) || /\p{Lu}/u.test(word)) continue;
    if (word.length === 1 && word !== "o") continue;
    if (!spaced.has(end) && continuesAsAddress(text, end)) continue;
    const index = covering(start, end);
    if (index === -1) {
      result.push({ start, end, original: word, replacement: capitalize(word), kind: "punct", margin: 6 });
      continue;
    }
    const existing = result[index]!;
    if (existing.start === start && LOWER.test(existing.replacement)) {
      result[index] = { ...existing, replacement: capitalize(existing.replacement) };
    }
  }
}
