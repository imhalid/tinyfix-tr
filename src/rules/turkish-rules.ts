import { lowerTr } from "../turkish.ts";

/** Words that are written apart from the word before them and follow its vowels. */
export const QUESTION =
  /^(m[iıuü])(y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae]|yd[iıuü]|yken)?$/;
export const ALSO = /^(d[ae])$/;

/**
 * Stems a locative can't attach to directly, so "-da/-de" after them must be the separate word "da/de".
 * Used as fallback when morphology is not loaded or when a stem is outside the morphology dictionary.
 */
export const NO_LOCATIVE_AFTER =
  /(s[ıiuü]|s[ıiuü]n[aeıiuü]|l[ae]r[ıi]n[aeıiuü]|l[ae]r[ae]|m[ae]y[ıi]|yl[ae]|s[ae]l[ae]r|[ıiuü]ğ[ıiuü]|[dt][ae]|n[ıiuü]n|yor|m[ıiuü]ş|[ae]c[ae]k|[dt][ıiuü]|[dt][ıiuü]r|[dt][ıiuü]k|s[ae]|m[ae]l[ıi])$/;

/**
 * Unambiguous non-noun-root endings for OOV stems outside the morphology dictionary (e.g. "subtropiklerdede").
 * Excludes bare "-da/-de/-sa/-se" so OOV compound nouns ("mikromaddede", "multisitede") are not over-split.
 */
export const STRONG_NO_LOCATIVE_AFTER =
  /(?:l[ae]rd[ae]|[ıiuü]nd[ae]|s[ıiuü]nd[ae]|s[ıiuü]n[aeıiuü]|l[ae]r[ıi]n[aeıiuü]|l[ae]r[ıi]|l[ae]r[ae]|m[ae]y[ıi]|yl[ae]|s[ae]l[ae]r|[ıiuü]ğ[ıiuü]|yor|m[ıiuü]ş|[ae]c[ae]k|m[ae]l[ıi])$/;

/** Finite verbs and the copula, which "ki" follows as a separate word ("diyor ki", "beceridir ki", "öyle ki"). */
export const FINITE =
  /(yor(?:um|sun|uz|sunuz|lar|du)?|m[ıiuü]ş(?:t[ıiuü]r)?|[ae]c[ae]k|[dt][ıiuü]|[dt][ıiuü]r|[dt][ıiuü]k|[dt][ıiuü]m|[dt][ıiuü]n|m[ae]l[ıi]|s[ae]|[ae]r(?:[ıi]m|l[ae]r)?|[ıiuü]r(?:[ıiuü]m|l[ae]r)?|öyle|böyle|şöyle)$/;

/** Never stand alone: splitting these off a word is never a fix ("kmdir", "kitaplar"). */
export const NEVER_ALONE = new Set([
  "dir", "dır", "dur", "dür", "tir", "tır", "tur", "tür",
  "ler", "lar", "dı", "di", "du", "dü", "ti", "tı", "tu", "tü",
  "in", "ın", "un", "ün", "e", "a", "i", "ı", "u", "ü", "le", "la",
]);

/** Short words that people often write apart from a word they belong with ("hiç bir", "bir çok", "her hangi"). */
export const JOIN_FIRST = new Set([
  "bir", "her", "hiç", "ya", "hep", "kimi", "öbür", "birbiri",
  "halbu", "oysa", "madem", "sanki", "meğer",
]);

/** Suffix-like words that belong on the word before when they're the locative or ablative ("ev de" for "evde"). */
export const JOIN_SECOND = new Set([
  "de", "da", "te", "ta", "den", "dan", "ten", "tan",
  "ki", "deki", "daki", "teki", "taki",
]);

/** Traditional SOMBAHÇEMİ forms written joined with "ki" (excluding ambiguous/contested forms like "illa ki"). */
export const SOMBAHCEMI_KI = new Set(["oysa", "halbu", "madem", "meğer"]);

/** Function words after which a separate "te/ta" is almost always a devoiced conjunction ("çok ta" -> "çok da") or adverb "ta". */
export const TE_TA_SKIP = new Set([
  "çok", "yok", "pek", "hiç", "hep", "artık", "ancak", "fakat",
  "hem", "daha", "bile", "yine", "gene", "ve", "ama", "çünkü", "da", "de",
]);

/**
 * Suffixes accepted by the generic (unseen-form) apostrophe rule after a clear proper name:
 * genitive, locative, ablative, -deki/-daki, instrumental, copula, dative/accusative.
 */
export const NAME_SUFFIX = /^(?:n?[ıiuü]n|[dt][ae]|[dt][ae]n|[dt][ae]ki|y?l[ae]|[dt][ıiuü]r|y?[aeıiuü]|yd[ıiuü]|ym[ıiuü]ş)$/;

/** Suffixes accepted after an all-caps acronym ("HEXIM'den", "KDA'ların", "TLS'nin"). Always 2+ letters to avoid English "-s". */
const ACRONYM_SUFFIX =
  /^(?:l[ae]r(?:[ıiuü]n|[dt][ae]n?|[dt][ae]ki|l[ae]|[aeıiuü])?|n?[ıiuü]n|[dt][ae]n?|[dt][ae]ki|y?l[ae]|y[aeıiuü]|[dt][ıiuü]r)$/;

const ACRONYM_WORD = /^([A-ZÇĞİÖŞÜa-zçğıöşü]*[A-ZÇĞİÖŞÜ]{2,})([a-zçğıöşü]{2,})$/;

/** Turkish honorific titles that take an apostrophe when following a proper name ("Aclan Bey'in", "Ayşe Hanım'a"). */
export const HONORIFIC_TITLES = new Set(["bey", "hanım", "paşa", "efendi", "ağa"]);

/**
 * Closed list of TDK geographic, place, landmark, and state head words (mostly P3sg forms) that take an apostrophe
 * when preceded by a capitalized proper name ("Marmara Denizi'nin", "Türkiye Cumhuriyeti'nin", "Kadıköy Mahallesi'nde",
 * "Büyük Okyanus'ta", "Osmanlı Devleti'nin").
 * Institution and organization head words ("Üniversitesi", "Partisi", "Bakanlığı", "Kurumu", ...) are deliberately excluded.
 */
export const PLACE_APOSTROPHE_HEADS = new Set([
  // Water bodies & coastal geography
  "denizi", "okyanusu", "okyanus", "gölü", "nehri", "ırmağı", "çayı", "deresi",
  "boğazı", "körfezi", "kanalı", "şelalesi", "adası", "yarımadası", "takımadası",
  // Landforms
  "dağı", "ovası", "yaylası", "platosu", "vadisi", "kanyonu", "çölü", "ormanı",
  "mağarası", "havzası", "kıtası",
  // Urban & administrative places
  "mahallesi", "caddesi", "sokağı", "bulvarı", "meydanı",
  "eyaleti", "oblastı", "bölgesi",
  // Historical landmarks
  "sarayı", "kalesi", "köprüsü", "kulesi",
  // States & polities
  "cumhuriyeti", "devleti", "imparatorluğu", "krallığı", "prensliği",
]);

/** Suffixes after a P3sg vowel-final place/state head word (pronominal buffer "n", "y", or copula). */
export const PLACE_P3SG_SUFFIX = /^(?:n[ıiuü]n|nd[ae]n?|nd[ae]ki|n[aeıiuü]|yl[ae]|[dt][ıiuü]r|yd[ıiuü]|ym[ıiuü]ş)$/;

/** True when `stem` is a TDK geographic/place/state head word (plus the explicit TDK exception "Avrupa Birliği"). */
export function isPlaceApostropheHead(stem: string, prevWord?: string): boolean {
  return PLACE_APOSTROPHE_HEADS.has(stem) || (stem === "birliği" && prevWord === "avrupa");
}

/** Validates a suffix attached with an apostrophe to a TDK place/geographic/state head word. */
export function isValidPlaceApostrophe(stem: string, suffix: string): boolean {
  const vowelFinal = /[aeıioöuüâîû]$/.test(stem);
  if (vowelFinal) {
    if (!PLACE_P3SG_SUFFIX.test(suffix)) return false;
  } else {
    if (!NAME_SUFFIX.test(suffix)) return false;
    if (/^(?:n[ıiuü]n|y)/.test(suffix)) return false;
    if (suffix.startsWith("d") && isVoicelessFinal(stem)) return false;
    if (suffix.startsWith("t") && !isVoicelessFinal(stem)) return false;
  }
  const firstVowel = [...suffix].find((ch) => "aeıioöuü".includes(ch));
  if (firstVowel && !followsHarmony(stem, firstVowel)) return false;
  return true;
}

/**
 * TDK compound verbs that must be written joined across all conjugations (due to vowel drop, consonant doubling,
 * or lexicalization): maps the separate first word to { auxStem, prefix, strictZeroPair? }.
 * E.g. "vaz" + "geçtim" -> "vazgeçtim", "kayıp" + "ediyorum" -> "kaybediyorum", "his" + "ettik" -> "hissettik".
 */
export interface CompoundVerbJoinRule {
  readonly auxStem: string;
  readonly prefix: string;
  readonly strictZeroPair?: boolean;
}

export const COMPOUND_VERB_JOINS: ReadonlyMap<string, readonly CompoundVerbJoinRule[]> = new Map([
  ["vaz", [{ auxStem: "geç", prefix: "vaz" }]],
  ["baş", [{ auxStem: "vur", prefix: "baş", strictZeroPair: true }]],
  ["var", [{ auxStem: "say", prefix: "var", strictZeroPair: true }]],
  ["ön", [{ auxStem: "gör", prefix: "ön", strictZeroPair: true }]],
  ["alı", [{ auxStem: "koy", prefix: "alı" }]],
  ["devir", [{ auxStem: "al", prefix: "devr" }, { auxStem: "et", prefix: "devr" }]],
  ["af", [{ auxStem: "et", prefix: "aff" }]],
  ["his", [{ auxStem: "et", prefix: "hiss" }]],
  ["red", [{ auxStem: "et", prefix: "redd" }]],
  ["ret", [{ auxStem: "et", prefix: "redd" }]],
  ["hal", [{ auxStem: "et", prefix: "hall" }]],
  ["zan", [{ auxStem: "et", prefix: "zann" }]],
  ["kayıp", [{ auxStem: "et", prefix: "kayb" }, { auxStem: "ol", prefix: "kayb" }]],
  ["kayıt", [{ auxStem: "et", prefix: "kayd" }, { auxStem: "ol", prefix: "kayd" }]],
  ["seyir", [{ auxStem: "et", prefix: "seyr" }]],
  ["emir", [{ auxStem: "et", prefix: "emr" }]],
  ["hapis", [{ auxStem: "et", prefix: "haps" }]],
  ["nakil", [{ auxStem: "et", prefix: "nakl" }]],
  ["keşif", [{ auxStem: "et", prefix: "keşf" }]],
  ["sabır", [{ auxStem: "et", prefix: "sabr" }]],
  ["şükür", [{ auxStem: "et", prefix: "şükr" }]],
  ["bahis", [{ auxStem: "et", prefix: "bahs" }]],
  ["fetih", [{ auxStem: "et", prefix: "feth" }]],
  ["mahv", [{ auxStem: "et", prefix: "mahv" }, { auxStem: "ol", prefix: "mahv" }]],
  ["vaat", [{ auxStem: "et", prefix: "vad" }]],
  ["def", [{ auxStem: "et", prefix: "def" }]],
  ["men", [{ auxStem: "et", prefix: "men" }]],
]);

/** Stems whose compound with "etmek" undergoes sound change and must be joined, not split ("hisettiniz" -> "hissettiniz"). */
export const JOINED_ETMEK_STEMS = new Set([
  "af", "his", "red", "ret", "hal", "zan", "kayıp", "kayıt", "seyir", "emir",
  "hapis", "nakil", "keşif", "devir", "sabır", "şükür", "bahis", "fetih", "mahv", "vaat", "def", "men", "kat",
]);

/** Three-letter noun stems that productively form separate-written compound verbs with "etmek" per TDK. */
export const SEPARATE_ETMEK_SHORT = new Set(["hak", "arz", "yok", "söz", "not", "göç", "alt"]);

/** Common stems allowed to split before bare 2-letter imperative "et" ("farket" -> "fark et", "meraket" -> "merak et"). */
export const SEPARATE_ETMEK_BARE_IMPERATIVE = new Set([
  "fark", "terk", "hak", "park", "devam", "dikkat", "merak", "kabul", "iptal", "kontrol", "takip", "yardım", "rica", "teşekkür",
]);

/** Standalone month and weekday names take no apostrophe at sentence start ("Ekimde havalar soğur"). */
export const TIME_NAMES_NO_START_APOSTROPHE = new Set([
  "ocak", "şubat", "mart", "nisan", "mayıs", "haziran",
  "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık",
  "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi", "pazar",
]);

/** Musical note words/modifiers that guard standalone "mi" from being rewritten to "mı". */
export const MUSIC_NOTES = new Set(["do", "re", "mi", "fa", "sol", "la", "si"]);
export const MUSIC_AFTER = new Set([
  "majör", "minör", "major", "minor", "bemol", "diyez",
  "notası", "notasi", "anahtarı", "anahtari",
]);

const BACK = new Set(["a", "ı", "o", "u", "â", "û"]);
const FRONT = new Set(["e", "i", "ö", "ü", "î"]);
const ROUND = new Set(["o", "u", "ö", "ü", "û"]);

export function lastVowel(word: string): string | undefined {
  for (let index = word.length - 1; index >= 0; index--) {
    const char = word[index]!;
    if (BACK.has(char) || FRONT.has(char)) return char;
  }
  return undefined;
}

/** True when a two-way (e/a) or four-way (i/ı/u/ü) vowel follows the stem's last vowel. */
export function followsHarmony(stem: string, vowel: string): boolean {
  const last = lastVowel(stem);
  if (!last) return true;
  const back = BACK.has(last);
  if (vowel === "a" || vowel === "e") return back === (vowel === "a");
  const round = ROUND.has(last);
  const want = back ? (round ? "u" : "ı") : round ? "ü" : "i";
  return vowel === want;
}

/** "misiniz", "mıydı" and "müsün" keep one high vowel throughout; "misın" doesn't exist. */
export function sameHighVowels(particle: string): boolean {
  const high = [...particle].filter((char) => "ıiuü".includes(char));
  return high.every((char) => char === high[0]);
}

/** True when a lowercase word ends in a Turkish voiceless consonant (f, s, t, k, ç, ş, h, p). */
export function isVoicelessFinal(word: string): boolean {
  return /[fstkçşhp]$/.test(word);
}

/**
 * Stems that do not take an apostrophe by TDK rules in generic/boosted inference:
 * - possessive-ending institution/place stems ("Cumhuriyetinde", "Bakanlığından"),
 * - plural stems and inflected plurals ("Türklerin", "Müslümanlara", "Japonların", "Yunanlardan"),
 * - long derivational language/manner stems in -ca/-ce/-ça/-çe and their inflections ("Hırvatçadan", "Türkçeden").
 */
export function hasBlockedApostropheStem(stem: string, skipBareCa = false, allowPlaceHead = false): boolean {
  if (!allowPlaceHead && /[^aeıioöuü](s?[ıiuü])$/.test(stem)) return true;
  if (/l[ae]r$/.test(stem)) return true;
  if (/[aıouâû][^aeıioöuü]*lar(?:ın(?:dan?|a|ı)?|ıyla|dan?|a|la)$/.test(stem)) return true;
  if (/[eiöüî][^aeıioöuü]*ler(?:in(?:den?|e|i)?|iyle|den?|e|le)$/.test(stem)) return true;
  if (!skipBareCa && stem.length >= 6 && /[cç][ae]$/.test(stem)) return true;
  if (stem.length >= 8 && /[cç][ae](?:d[ae]n?|n[ıi]n|y[aeıi]|yl[ae])$/.test(stem)) return true;
  return false;
}

/**
 * Phonological and TDK checks for attaching an unseen suffix to a proper name with an apostrophe.
 * Prevents impossible Turkish splits like "Ankara'in", "Mark'ya", "Zeynep'den", or "Müslümanlar'a".
 */
export function isValidGenericApostrophe(stem: string, suffix: string, skipBareCa = false): boolean {
  if (!NAME_SUFFIX.test(suffix)) return false;
  if (hasBlockedApostropheStem(stem, skipBareCa)) return false;
  // Buffer "n" (genitive -nın/-nin/-nun/-nün) and buffer "y" (-ya/-ye/-yı/-yle/-ydı/-ymış) follow a vowel or "y".
  if (/^(?:n[ıiuü]n|y)/.test(suffix) && !/[aeıioöuüâîûy]$/.test(stem)) return false;
  // Vowel-initial suffixes follow a consonant (or a silent final "-e" in foreign names like "Google'ın", "Blake'i").
  if (/^[aeıiuü]/.test(suffix) && /[aıioöuüâîû]$/.test(stem)) return false;
  // Locative/ablative/copula voicing harmony: voiceless final takes "t-", voiced/vowel final takes "d-".
  if (suffix.startsWith("d") && isVoicelessFinal(stem)) return false;
  if (suffix.startsWith("t") && !/[fstkçşhpcx]$/.test(stem)) return false;
  return true;
}

/** Matches an all-caps acronym or mixed-case tech/brand name ending in 2+ uppercase letters glued to a Turkish suffix ("HEXIMden", "MacOSdaki"). */
export function matchAcronymApostrophe(typed: string): { prefix: string; suffix: string; withMark: string } | null {
  const match = ACRONYM_WORD.exec(typed);
  if (!match) return null;
  const prefix = match[1]!;
  const suffix = match[2]!;
  if (prefix.length < 3 || !ACRONYM_SUFFIX.test(suffix)) return null;
  return { prefix, suffix, withMark: `${lowerTr(prefix)}'${suffix}` };
}

/**
 * Guards stem-suffixation of multi-word particle rules in KnownMisspellings ("kimmi -> kim mi", "yada -> ya da"):
 * - Rules ending in "de", "da", "ki" must never absorb trailing letters ("yadacı" is not "ya dacı").
 * - Rules ending in "mi/mı/mu/mü" may only absorb suffixes that keep the last word a valid harmonized question particle
 *   ("varmısın" -> "var mısın" is valid; "kimmiş" -> "kim miş" and "varmış" -> "var mış" are blocked).
 */
export function isValidKnownParticleSuffix(baseRight: string, suffix: string): boolean {
  const space = baseRight.lastIndexOf(" ");
  if (space === -1) return true;
  const baseLast = baseRight.slice(space + 1);
  if (baseLast === "de" || baseLast === "da" || baseLast === "ki") return false;
  if (/^m[iıuü]$/.test(baseLast)) {
    const combined = baseLast + suffix;
    return QUESTION.test(combined) && sameHighVowels(combined);
  }
  return true;
}

/**
 * True when every vowel altered inside an apostrophe suffix ("i" -> "ı", "u" -> "ü", "o" -> "ö")
 * harmonizes with the preceding vowel (starting from the resulting stem's last vowel).
 * Blocks disharmonious changes like "Mortimer'i" -> "Mortimer'ı" while keeping "Ravenna'nin" -> "Ravenna'nın".
 */
export function isHarmoniousApostropheMarkChange(
  formStem: string,
  wordSuffix: string,
  formSuffix: string,
  isInverseStem = false,
): boolean {
  if (wordSuffix === formSuffix || wordSuffix.length !== formSuffix.length) return true;
  for (let i = 0; i < formSuffix.length; i++) {
    const before = wordSuffix[i];
    const after = formSuffix[i];
    if (before === undefined || after === undefined || before === after) continue;
    if (!BACK.has(after) && !FRONT.has(after)) continue;
    const suffixVowel = lastVowel(formSuffix.slice(0, i));
    let prev: string | undefined;
    let inverse = false;
    if (suffixVowel) {
      prev = suffixVowel;
    } else if (/[^aeıioöuüâîû]y$/.test(formStem)) {
      // Final syllabic "-y" in foreign names ("Mary", "Tony", "Lucy", "Murphy") is pronounced as front "/i/".
      prev = "i";
    } else {
      prev = lastVowel(formStem);
      inverse = isInverseStem;
    }
    if (!prev) continue;
    const back = !inverse && BACK.has(prev);
    if (after === "o" || after === "ö") {
      if (back !== (after === "o")) return false;
      continue;
    }
    const round = ROUND.has(prev);
    const want = back ? (round ? "u" : "ı") : round ? "ü" : "i";
    if (after !== want) return false;
  }
  return true;
}

/**
 * Detects a doubled-locative typo around the plural suffix ("bölgedelerde" for "bölgelerde",
 * "alandalarda" for "alanlarda"): returns the collapsed locative plural form when the pattern matches.
 */
export function collapsedDoubledLocative(first: string, second: string): string | null {
  if (second === "de" && /[dt]eler$/.test(first) && first.length >= 7) {
    return `${first.slice(0, -5)}lerde`;
  }
  if (second === "da" && /[dt]alar$/.test(first) && first.length >= 7) {
    return `${first.slice(0, -5)}larda`;
  }
  return null;
}

const VALID_APOSTROPHE_BACK_SUFFIX =
  /^(?:(?:lar)?(?:s?ı)?(?:n?ın|n?[dt]an?|n?[dt]aki|n?a|n?ı|y?la)|y[aı])$/;

/**
 * Restores unambiguous internal back-vowel disharmony inside an apostrophe suffix typed without Turkish marks:
 * e.g. "ukrayna'sinda" -> "ukrayna'sında", "ankara'sindaki" -> "ankara'sındaki", "kda'larin" -> "kda'ların".
 * Never alters a trailing "-ki" and never guesses harmony from an unseen foreign stem.
 */
export function fixDisharmoniousApostropheSuffix(word: string): string | null {
  const quote = word.indexOf("'");
  if (quote < 2 || quote !== word.lastIndexOf("'")) return null;
  const stem = word.slice(0, quote);
  const suffix = word.slice(quote + 1);
  const keepKi = suffix.endsWith("ki");
  const core = keepKi ? suffix.slice(0, -2) : suffix;
  if (!core.includes("a") || !core.includes("i")) return null;
  const fixedSuffix = core.replaceAll("i", "ı") + (keepKi ? "ki" : "");
  if (fixedSuffix === suffix || !VALID_APOSTROPHE_BACK_SUFFIX.test(fixedSuffix)) return null;
  if (!isHarmoniousApostropheMarkChange(stem, suffix, fixedSuffix)) return null;
  return `${stem}'${fixedSuffix}`;
}

/**
 * Restores missing Turkish marks ("i" -> "ı", "u" -> "ü") on a standalone question particle ("mi", "mu", "misin", ...)
 * in an ASCII-typed sentence using the preceding word's vowel harmony (respecting inverse-harmony loanwords like "saat", "alkol").
 */
export function harmonizeQuestionParticle(word: string, prevWord: string, isInverseHarmony: boolean): string | null {
  const match = QUESTION.exec(word);
  if (!match || !sameHighVowels(word)) return null;
  const last = lastVowel(prevWord);
  if (!last) return null;
  const round = ROUND.has(last);
  const front = isInverseHarmony || FRONT.has(last);
  const want = front ? (round ? "ü" : "i") : round ? "u" : "ı";
  const current = match[1]![1]!;
  if (current === want) return null;
  // Only restore missing marks (ASCII -> Turkish); never strip marks or guess across unrelated vowels.
  if (!((current === "i" && want === "ı") || (current === "u" && want === "ü"))) return null;
  const target = word.replaceAll(current, want);
  return QUESTION.test(target) && sameHighVowels(target) ? target : null;
}

/**
 * "ol-" used as a helper verb after a participle ("yardım ediyor oluyorduk", "gelmiş olacak", "gidecek olursa"):
 * here it is never "öl-", however common "ölüyorduk" is on its own.
 */
export function isAuxiliaryOl(prevWord: string, word: string, replacement: string): boolean {
  return /^ol/.test(word) && /^öl/.test(replacement) && /(?:[ıiuü]?yor|m[ıiuü]ş|[ae]c[ae]k)$/.test(prevWord);
}
