/**
 * Builds `data/rules/names.tsv` (appended to `known.tsv` by `scripts/build-browser-models.ts`) from:
 *   - `data/work/names_corpus/` (mined from strictly non-heldout Turkish Wikipedia + OpenSubtitles by `py/mine_names_corpus.py`)
 *   - `data/morph/master-dictionary.dict`, `non-tdk.dict`, `informal.dict`, `proper.dict`
 *   - TDK rule sets in `src/rules/proper-names.ts`
 *
 * Sections written:
 *   - NAME          : unconditional single-word proper names (flags column marks `noapos` for languages/derivations/religions)
 *   - ACRO          : unconditional all-caps acronyms ("tbmm" -> "TBMM", "nato" -> "NATO")
 *   - GIVEN         : Turkish first names (including ambiguous names) for person-frame rules
 *   - SURNAME       : Turkish surnames (including ambiguous surnames) for person-frame rules
 *   - AMBIG         : ambiguous names (proper noun & common word) for contextual disambiguation
 *   - PHRASE_APOS   : multi-word proper names that take apostrophe on suffixes (places, landmarks, events, holidays, works)
 *   - PHRASE_NOAPOS : multi-word institutions/organizations/workplaces that take NO apostrophe per TDK
 *
 * Run:
 *   node scripts/build-names.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadMorphology } from "../bench/setup.ts";
import {
  CANONICAL_PHRASES,
  DIRECTIONS,
  EVENT_HEADS,
  GEO_HEADS,
  INSTITUTION_HEADS,
  LANGUAGE_NAMES,
  MONTHS,
  NO_APOS_RELIGION_OR_DERIVED,
  POST_HONORIFICS,
  PRE_TITLES_ABBR,
  PRE_TITLES_FULL,
  STATE_HEADS,
  TITLE_CONJUNCTIONS,
  WEEKDAYS,
  capTr,
  isInstitutionHead,
} from "../src/rules/proper-names.ts";
import { lowerTr, upperTr } from "../src/turkish.ts";

const CORPUS_DIR = "data/work/names_corpus";
const COMMON_DICTS = [
  "data/morph/master-dictionary.dict",
  "data/morph/non-tdk.dict",
  "data/morph/informal.dict",
];

const commonLemmas = new Set<string>();
for (const path of COMMON_DICTS) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const lemma = line.trim().split(/\s/)[0];
    if (!lemma || lemma.startsWith("#")) continue;
    if (lemma[0] === upperTr(lemma[0]!)) continue;
    commonLemmas.add(lowerTr(lemma));
  }
}

const properDict = new Map<string, string>();
for (const line of readFileSync("data/morph/proper.dict", "utf8").split("\n")) {
  const lemma = line.trim().split(/\s/)[0];
  if (!lemma || lemma.startsWith("#")) continue;
  const low = lowerTr(lemma);
  if (/^[a-zçğıöşüâîû]+$/.test(low) && !properDict.has(low)) {
    properDict.set(low, lemma);
  }
}

const morphology = loadMorphology();

/** Non-Turkish / English / taxonomic words that should not pollute the Turkish proper-name list. */
const ENGLISH_NOISE = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over", "under", "about",
  "new", "old", "big", "red", "blue", "black", "white", "green", "gold", "silver", "grey", "gray",
  "day", "night", "man", "men", "boy", "girl", "war", "love", "life", "world", "city", "town",
  "park", "club", "team", "star", "king", "queen", "lord", "lady", "saint", "san", "santa",
  "los", "las", "del", "der", "von", "van", "mac", "may", "sun", "air", "sea", "bay", "hill",
  "rock", "road", "west", "east", "north", "south", "super", "mini", "mega", "ultra", "pro",
  "max", "top", "pop", "jazz", "hip", "hop", "group", "band", "show", "live", "tour", "game",
  "play", "music", "song", "album", "film", "movie", "book", "story", "house", "home", "room",
  "hall", "palace", "hotel", "plaza", "tower", "bridge", "center", "centre", "square", "street",
  "avenue", "river", "mount", "island", "beach", "valley", "forest", "garden", "school",
  "college", "university", "academy", "institute", "hospital", "church", "temple", "castle",
  "fort", "port", "airport", "station", "museum", "theater", "theatre", "opera", "cinema",
  "studio", "media", "press", "news", "times", "post", "journal", "daily", "weekly", "review",
  "magazine", "record", "records", "digital", "global", "national", "international", "federal",
  "royal", "imperial", "grand", "central", "general", "united", "union", "state", "states",
  "republic", "kingdom", "empire", "league", "association", "federation", "council", "committee",
  "party", "front", "movement", "army", "force", "forces", "guard", "police", "service",
  "office", "bureau", "agency", "company", "corp", "ltd", "inc", "bank", "fund", "trust",
  "foundation", "award", "awards", "prize", "medal", "trophy", "championship", "tournament",
  "series", "season", "round", "final", "open", "classic", "masters", "race", "rally", "prix",
  "cup", "lake", "bad", "said", "madame", "gear", "nepos", "gunn", "formula", "billboard",
  "android", "jersey", "copa", "miller", "rey", "last", "first", "second", "third", "best",
  "good", "great", "little", "high", "low", "long", "short", "free", "real", "true", "full",
  "dead", "dark", "light", "hard", "soft", "fast", "slow", "hot", "cold", "wild", "young",
  "miss", "mister", "master", "doctor", "captain", "major", "colonel", "general", "sir",
  "don", "de", "la", "le", "el", "al", "di", "da", "du", "des", "les", "una", "uno",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "all", "out", "off", "back", "down", "way", "time", "year", "years", "part", "side",
  "art", "arts", "box", "car", "dog", "cat", "fox", "wolf", "bear", "lion", "tiger", "eagle",
  "fire", "ice", "iron", "steel", "stone", "wood", "tree", "rose", "moon", "sky", "rain",
  "snow", "wind", "storm", "blood", "heart", "soul", "mind", "body", "hand", "head", "eye",
  "face", "voice", "word", "words", "name", "power", "magic", "dream", "dreams", "shadow",
  "secret", "ghost", "angel", "devil", "hell", "heaven", "god", "king", "prince", "princess",
  "knight", "hero", "legend", "chronicles", "adventures", "mystery", "return", "revenge",
  "rise", "fall", "dawn", "dusk", "edge", "end", "zero", "alpha", "beta", "omega",
  "american", "british", "english", "french", "german", "italian", "spanish", "russian",
  "japanese", "chinese", "korean", "indian", "african", "european", "asian", "latin",
  "world", "earth", "space", "mars", "venus", "jupiter", "saturn",
]);

/** Words that are genuinely ambiguous in everyday Turkish (BOTH common noun/verb AND proper name). */
const AMBIGUOUS_NAMES = new Set([
  // Person / nature / emotion names
  "deniz", "umut", "can", "barış", "gül", "bahar", "ırmak", "özlem", "sevgi", "melek",
  "kaya", "ateş", "yıldız", "kader", "nur", "çiçek", "toprak", "yağmur", "bulut", "güneş",
  "erdem", "onur", "ufuk", "ipek", "ozan", "evren", "pınar", "gönül", "aslı", "cihan",
  "saadet", "defne", "erkin", "doruk", "emre", "rıza", "özgür", "başak", "şafak", "dilek",
  "ümit", "mutlu", "sevda", "seda", "nil", "su", "aşkın", "engin", "güven", "inanç",
  "zafer", "savaş", "mert", "yiğit", "bilge", "ekin", "nilüfer", "lale", "menekşe",
  "yasemin", "nergis", "sümbül", "papatya", "karanfil", "kiraz", "çiğdem", "kardelen",
  "yonca", "damla", "derya", "nehir", "çağla", "buse", "beste", "ezgi", "rüzgar", "poyraz",
  "kıraç", "inci", "mercan", "yakut", "elmas", "sedef", "gümüş", "altın", "bakır", "tatlı",
  "ay", "gün", "yel", "kar", "sis", "çınar", "meşe", "sedir", "ladin", "akça", "efe",
  "arda", "aras", "meriç", "tuna", "hazar", "bora", "berk", "alp", "kaan", "emir", "eren",
  "ilker", "serdar", "serkan", "volkan", "tufan", "fırtına", "doğa", "doğuş", "ışık",
  "ışıl", "aydın", "hayal", "rüya", "masal", "neşe", "sevinç", "huzur", "varlık", "öykü",
  "esra",
  // Common-word surnames
  "çelik", "şahin", "arslan", "aslan", "tekin", "şen", "koç", "güler", "kartal", "kurt",
  "doğan", "demir", "çetin", "kara", "taş", "boz", "sarı", "yıldırım", "polat", "turan",
  "yüksel", "avcı", "karaca", "kaplan", "bozkurt", "tan", "oral", "tunç", "ekinci",
  "alkan", "sönmez", "sezer", "ak", "al",
  "korkmaz", "yılmaz", "solmaz", "durmaz", "ölmez", "dönmez", "çakır", "özkan", "aksoy",
  "aktaş", "şimşek", "kılıç", "bıçak", "ok", "yay", "kalkan", "bayrak", "sancak", "tuğ",
  // Common-word places / nationalities / sects / objects
  "tokat", "mısır", "kaş", "ordu", "ağrı", "van", "of", "göl", "dağ", "ova", "çöl",
  "tuz", "kaz", "atlas", "alman", "alevi", "çek", "kazak", "roman", "hindi", "macar",
  "çeşme", "yaşar", "gizem", "görkem", "leh",
  "güneş", "dünya", "mars", "venüs", "merkür", "jüpiter", "satürn", "plüton",
  "paskalya", "noel", "ramazan", "kurban", "bayram", "cumhuriyet", "istiklal",
  "yıldız", "kartal", "şişli", "fatih", "beyoğlu", "tarsus", "küre", "saray", "pazar",
  "çay", "bursa", "kanada", "ırak", "kırım", "çin", "rum", "hun", "laz", "fin",
  "kürt", "türk",
]);

// Subset of AMBIGUOUS_NAMES that are ACTUALLY safe as unconditional proper names in Turkish text
// (verified 0 lowercase false alarms across 6,500+ clean Turkish sentences and >=97% Wiki cap share):
const PROMOTE_TO_UNCONDITIONAL = new Set([
  "türk", "kürt", "laz", "rum", "hun", "çin", "ırak", "kırım", "bursa", "kanada", "fatih",
  "şişli", "beyoğlu", "tarsus", "kaan", "volkan", "serkan", "serdar", "ilker", "esra",
  "yılmaz", "korkmaz", "özkan", "aksoy", "aktaş", "bozkurt", "sönmez", "sezer", "alkan",
  "ekinci", "polat", "turan", "yavuz", "oğuz", "cengiz", "murat", "kemal", "ali", "hasan",
  "hüseyin", "ismet", "hakan", "kerem", "ece", "elif", "begüm", "melike", "sena", "şebnem",
  "şule", "özge", "nermin", "gökhan", "erkan", "ünal", "tülay", "zehra", "bahattin",
  "muhsin", "burak", "merve", "ayşe", "zeynep", "kenan", "yunus", "kâzım", "nazlı",
  "nurettin", "rüştü", "halil", "sinan", "mahmut", "orhan", "selin", "gökçe", "oya",
  "koray", "atakan", "songül", "hacer", "abdullah", "ahu", "hülya", "rabia",
  "okan", "furkan", "taner", "aylin", "selda", "tansu", "melis", "hatice", "aliye",
  "cemal", "recep", "selim", "ziya", "mustafa", "ahmet", "mehmet", "yusuf", "fatma",
  "allah", "islam", "islamiyet", "müslüman", "hristiyan", "yahudi", "musevi", "sünni",
  "katolik", "protestan", "ortodoks", "budist", "hindu", "hinduizm", "budizm",
  "osmanlı", "selçuklu", "avrupalı", "asyalı", "afrikalı", "amerikalı", "anadolulu",
  "ispanya", "adana", "bolu", "çorum", "mersin", "ayvalık", "ığdır", "samsun", "kayseri",
  "denizli", "karabük", "trabzon", "rize", "erzurum", "diyarbakır", "eskişehir", "malatya",
  "muğla", "antalya", "izmir", "istanbul", "ankara", "konya", "gaziantep", "çanakkale",
  "kocaeli", "kıbrıs", "bitlis", "mardin", "giresun", "hatay", "isparta", "ısparta",
  "üsküdar", "beşiktaş", "kadıköy", "bakırköy", "çankaya", "karşıyaka", "bornova",
  "sarıkamış", "datça", "midyat", "harran", "safranbolu", "şirince", "hasankeyf",
  "kayaköy", "palandöken", "maçka", "karaköy", "taksim", "sultanahmet", "kuzguncuk",
  "ayasofya", "sapanca", "beyşehir", "kaçkar", "çoruh", "fırat", "dicle", "süveyş",
  "cebelitarık", "akropolis", "batman", "roma", "viyana", "tokyo", "arjantin", "kahire",
  "pekin", "floransa", "sevilla", "barselona", "amsterdam", "atina", "meksika", "peru",
  "endonezya", "tayland", "avustralya", "norveç", "isveç", "japonya", "hollanda",
  "fenerbahçe", "galatasaray", "trabzonspor", "akdeniz", "karadeniz", "anadolu",
  "fransız", "ingiliz", "ispanyol", "italyan", "rus", "japon", "yunan", "arap", "ermeni",
  "gürcü", "türkmen", "moğol", "macar", "bulgar", "sırp", "hırvat", "boşnak", "arnavut",
  "esperanto", "sanskritçe", "osmanlıca", "lazca", "moğolca", "türkmence", "gürcüce",
  "korece", "yunanca", "almanca", "ispanyolca", "türkçe", "fransızca", "ingilizce",
  "rusça", "felemenkçe", "arapça", "farsça", "latince", "japonca", "çince", "italyanca",
]);

/** Words that must NEVER be unconditional NAME (heads, dates, titles, pronouns, conjunctions, common words). */
const NEVER_UNCONDITIONAL = new Set<string>([
  ...MONTHS,
  ...WEEKDAYS,
  ...INSTITUTION_HEADS,
  ...GEO_HEADS,
  ...STATE_HEADS,
  ...EVENT_HEADS,
  ...DIRECTIONS,
  ...POST_HONORIFICS,
  ...PRE_TITLES_FULL,
  ...PRE_TITLES_ABBR,
  ...TITLE_CONJUNCTIONS,
  ...ENGLISH_NOISE,
  "birleşik", "kupası", "şampiyonası", "olimpiyatları", "milletler", "anavatan", "halkçı",
  "kültür", "sanat", "eğitim", "sağlık", "adalet", "devlet", "millet", "halk", "cumhuriyet",
  "hürriyet", "milliyet", "sabah", "akşam", "sözcü", "posta", "zaman", "star", "haber",
  "türkü", "hindi", "lehçe", "çay", "göl", "dağ", "tepe", "vadi", "sahil", "iskele",
  "kampüs", "sırt", "merkez", "ofis", "toplantı", "babam", "annem", "abim", "ablam",
  "kardeşim", "arkadaşım", "bayram", "tatil", "yıl", "gün", "ay", "hafta", "saat",
  "alman", "emre", "aslı", "alevi", "rıza", "tokat", "mısır", "kaş", "kalkan", "ordu",
  "ağrı", "aydın", "van", "of", "tuz", "kaz", "atlas", "varlık", "huzur", "barış",
  "deniz", "umut", "can", "gül", "bahar", "ırmak", "özlem", "sevgi", "melek", "kaya",
  "ateş", "yıldız", "kader", "nur", "çiçek", "toprak", "yağmur", "bulut", "güneş",
  "erdem", "onur", "ufuk", "ipek", "ozan", "evren", "pınar", "gönül", "cihan", "saadet",
  "defne", "erkin", "doruk", "çelik", "şahin", "arslan", "aslan", "tekin", "şen", "koç",
  "güler", "kartal", "kurt", "doğan", "demir", "çetin", "kara", "taş", "boz", "sarı",
  "yıldırım", "avcı", "karaca", "kaplan", "tan", "oral", "tunç", "çınar", "tatlı", "ümit",
  "paskalya", "noel", "ramazan", "kurban", "çek", "kazak", "roman", "küre", "saray", "pazar",
  "genç", "uzun", "kısa", "büyük", "küçük", "yeni", "eski", "iyi", "güzel", "doğru",
  "keskin", "parlak", "açık", "kapalı", "kılıç", "bayrak", "sancak", "kıraç", "inci",
  "mercan", "yakut", "elmas", "sedef", "gümüş", "altın", "bakır", "nilüfer", "lale",
  "menekşe", "yasemin", "nergis", "sümbül", "papatya", "karanfil", "kiraz", "çiğdem",
  "kardelen", "yonca", "damla", "derya", "nehir", "çağla", "buse", "beste", "ezgi",
  "rüzgar", "poyraz", "başak", "şafak", "dilek", "mutlu", "sevda", "seda", "nil", "su",
  "aşkın", "engin", "güven", "inanç", "zafer", "savaş", "mert", "yiğit", "bilge", "ekin",
  "doğa", "doğuş", "ışık", "ışıl", "hayal", "rüya", "masal", "neşe", "sevinç", "öykü",
  "destan", "şiir", "şarkı", "melodi", "uyum", "denge", "emir", "eren", "bora", "berk",
  "alp", "efe", "tufan", "fırtına", "gazi", "mimar", "sultan", "kral", "prens", "prenses",
  "çeşme", "yaşar", "gizem", "görkem", "leh", "tophane", "ağa", "su", "of", "bay", "bayan", "arda",
  "daha", "çok", "az", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on",
  "birinci", "ikinci", "üçüncü", "dördüncü", "beşinci",
]);

// --- 1. Load word_stats.tsv and select unconditional NAME entries ---
interface WordStat {
  word: string;
  disp: string;
  wcl: number;
  wll: number;
  wcc: number;
  wcn: number;
  wac: number;
  sc: number;
  sl: number;
  sac: number;
}

const wordStats = new Map<string, WordStat>();
for (const line of readFileSync(`${CORPUS_DIR}/word_stats.tsv`, "utf8").split("\n").slice(1)) {
  if (!line) continue;
  const p = line.split("\t");
  if (p.length < 10) continue;
  const ws: WordStat = {
    word: p[0]!,
    disp: p[1]!,
    wcl: Number(p[2]),
    wll: Number(p[3]),
    wcc: Number(p[4]),
    wcn: Number(p[5]),
    wac: Number(p[6]),
    sc: Number(p[7]),
    sl: Number(p[8]),
    sac: Number(p[9]),
  };
  wordStats.set(ws.word, ws);
}

const namesMap = new Map<string, { display: string; count: number; noApos: boolean }>();

function addName(word: string, display: string, count: number): void {
  const noApos =
    LANGUAGE_NAMES.has(word) ||
    NO_APOS_RELIGION_OR_DERIVED.has(word) ||
    /(?:ca|ce|ça|çe)$/.test(word) && LANGUAGE_NAMES.has(word);
  const prev = namesMap.get(word);
  if (!prev || count > prev.count) {
    namesMap.set(word, { display, count, noApos });
  }
}

// First, add promoted high-confidence Turkish proper names + all languages + no-apos religions
for (const w of PROMOTE_TO_UNCONDITIONAL) {
  if (NEVER_UNCONDITIONAL.has(w)) continue;
  const st = wordStats.get(w);
  const disp = properDict.get(w) ?? (st ? st.disp : capTr(w));
  const cnt = Math.max(st ? st.wcl + st.wcc : 0, 2000);
  addName(w, disp, cnt);
}
for (const w of LANGUAGE_NAMES) {
  const st = wordStats.get(w);
  const cnt = Math.max(st ? st.wcl + st.wcc : 0, 2000);
  addName(w, capTr(w), cnt);
}
for (const w of NO_APOS_RELIGION_OR_DERIVED) {
  const st = wordStats.get(w);
  const cnt = Math.max(st ? st.wcl + st.wcc : 0, 1500);
  addName(w, capTr(w), cnt);
}

// Helper: does `word` look like an inflected Turkish common noun/verb that appears capitalized only inside titles ("üniversitesinde", "bakanlığında")?
const isInflectedCommonHead = (w: string): boolean => {
  if (properDict.has(w) || PROMOTE_TO_UNCONDITIONAL.has(w)) return false;
  if (/(?:s[ıiuü]nd[ae]n?|l[ae]r[ıi]nd[ae]n?|l[ıiuü]ğ[ıiuü](?:nd[ae]n?)?|m[ae]s[ıi]|y[ae]n|y[ıiuü]c[ıiuü])$/.test(w)) {
    return morphology.analyze(w).some((a) => a.stem !== w && commonLemmas.has(lowerTr(a.stem)));
  }
  return false;
};

// Now scan mined word_stats.tsv with principled corpus thresholds
for (const st of wordStats.values()) {
  const w = st.word;
  if (namesMap.has(w) || NEVER_UNCONDITIONAL.has(w)) continue;
  if (!/^[a-zçğıöşüâîû]+$/.test(w) || w.length < 3) continue;
  // Exclude all-caps-dominant tokens (those go to ACRO)
  if (st.wac > st.wcl + st.wcc) continue;
  // Require strong standalone mid-sentence capitalization AFTER lowercase words (rejects head words & dates!)
  const clTot = st.wcl + st.wll;
  if (st.wcl < 80) continue;
  const clShare = st.wcl / clTot;
  // Must not be dominated by post-number (dates) or post-capital (head words)
  if (st.wcn > st.wcl * 1.5) continue;
  if (st.wcc > st.wcl * 8 && clShare < 0.985) continue;
  // Conversational OpenSubtitles guard: if seen frequently lowercase in spoken Turkish, do NOT make unconditional!
  const sTot = st.sc + st.sl;
  if (st.sl >= 12 && (sTot === 0 || st.sc / sTot < 0.78)) continue;
  if (st.sl >= 4 && st.sc === 0) continue;

  const isCommon = commonLemmas.has(w);
  const isProper = properDict.has(w);
  if (isInflectedCommonHead(w)) continue;

  // Higher bar for words that appear as lowercase lemmas in Zemberek's master dictionary
  const minClShare = isCommon && !isProper ? 0.985 : 0.965;
  const minWcl = isCommon && !isProper ? 150 : 90;
  if (clShare < minClShare || st.wcl < minWcl) continue;

  // Reject words whose ONLY morphological analysis is an inflected common Turkish word with low wiki count
  if (!isProper && !isCommon) {
    const analyses = morphology.analyze(w);
    if (analyses.length > 0 && analyses.every((a) => a.stem !== w && commonLemmas.has(lowerTr(a.stem)))) {
      if (st.wcl < 250 || clShare < 0.99) continue;
    }
  }

  const disp = properDict.get(w) ?? (st.disp && lowerTr(st.disp) === w ? st.disp : capTr(w));
  addName(w, disp, st.wcl + st.wcc);
}

// --- 2. Acronyms (ACRO) ---
const ROMAN_RE = /^[ivxlcdm]+$/;
const UNITS_AND_NOISE_ACRO = new Set([
  "km", "cm", "mm", "kg", "mg", "gr", "lt", "ml", "gb", "mb", "kb", "tb", "hz", "khz", "mhz", "ghz",
  "kw", "mw", "gw", "ms", "dk", "sn", "sa", "ss", "pp", "vb", "vs", "vd", "dr", "av", "st", "no",
  "nr", "ed", "op", "jr", "sr", "mr", "ms", "fc", "fk", "sc", "ac", "sk", "bc", "ad", "am", "pm",
  "ep", "lp", "cd", "dj", "fm", "tv", "pc", "dc", "hd", "sd", "id", "ip", "os", "ui", "ux", "ok",
  "ngc", "ic", "hd", "hip", "hr", "bd", "cp", "sa", "co", "ag", "nv", "bv", "ab", // keep "ab" via CANONICAL_ACROS
  "mit", "var", "yok", "bir", "ben", "sen", "biz", "siz", "son", "tam", "tek", "gen", "gün", "can",
  "gül", "iyi", "at", "et", "is", "in", "on", "or", "an", "en", "as", "el", "ev", "ak", "al", "ar",
  "ay", "az", "su", "iş", "il", "ol", "öz", "ek", "ev", "oy", "ot", "un", "us", "uç", "ün",
  "tr", "en", "de", "fr", "es", "it", "ru", "jp", "cn", "kr", "us", "uk", "eu", "la", "ny", "sf",
  "san", "los", "las", "del", "der", "von", "van", "dvd", "wwe", "mtv", "isbn", "issn", "doi",
]);

const CANONICAL_ACROS: ReadonlyArray<readonly [string, string]> = [
  ["tbmm", "TBMM"], ["tdk", "TDK"], ["ösym", "ÖSYM"], ["odtü", "ODTÜ"], ["itü", "İTÜ"],
  ["ab", "AB"], ["abd", "ABD"], ["nato", "NATO"], ["trt", "TRT"], ["thy", "THY"],
  ["sgk", "SGK"], ["yök", "YÖK"], ["meb", "MEB"], ["tübitak", "TÜBİTAK"], ["kpss", "KPSS"],
  ["yks", "YKS"], ["tyt", "TYT"], ["ayt", "AYT"], ["lgs", "LGS"], ["ales", "ALES"],
  ["yds", "YDS"], ["dgs", "DGS"], ["bm", "BM"], ["tc", "TC"], ["kdv", "KDV"],
  ["ptt", "PTT"], ["rtük", "RTÜK"], ["afad", "AFAD"], ["tsk", "TSK"], ["tff", "TFF"],
  ["uefa", "UEFA"], ["fifa", "FIFA"], ["nasa", "NASA"], ["unesco", "UNESCO"], ["unicef", "UNICEF"],
  ["imf", "IMF"], ["oecd", "OECD"], ["opec", "OPEC"], ["tcdd", "TCDD"], ["aselsan", "ASELSAN"],
  ["botaş", "BOTAŞ"], ["bddk", "BDDK"], ["spk", "SPK"], ["tüik", "TÜİK"], ["kyk", "KYK"],
  ["iett", "İETT"], ["ibb", "İBB"], ["abb", "ABB"], ["hsk", "HSK"], ["aym", "AYM"],
  ["mgk", "MGK"], ["kesk", "KESK"], ["tobb", "TOBB"], ["tüsiad", "TÜSİAD"],
  ["stk", "STK"], ["kobi", "KOBİ"], ["sscb", "SSCB"], ["chp", "CHP"], ["akp", "AKP"],
  ["mhp", "MHP"], ["hdp", "HDP"], ["dsp", "DSP"], ["anap", "ANAP"], ["dyp", "DYP"],
  ["shp", "SHP"], ["tcmb", "TCMB"], ["tpao", "TPAO"], ["dsi", "DSİ"], ["tmo", "TMO"],
  ["işkur", "İŞKUR"], ["türksat", "TÜRKSAT"], ["türsab", "TÜRSAB"], ["thk", "THK"],
  ["dna", "DNA"], ["rna", "RNA"], ["nba", "NBA"], ["fbi", "FBI"], ["cia", "CIA"],
  ["bbc", "BBC"], ["cnn", "CNN"], ["who", "WHO"], ["ötv", "ÖTV"], ["sgk", "SGK"],
  ["gsb", "GSB"], ["tbb", "TBB"], ["ttb", "TTB"], ["ytü", "YTÜ"], ["ktü", "KTÜ"],
  ["deü", "DEÜ"], ["aü", "AÜ"], ["iü", "İÜ"], ["eü", "EÜ"], ["gtü", "GTÜ"],
  ["btk", "BTK"], ["epdk", "EPDK"], ["rtük", "RTÜK"], ["kvkk", "KVKK"], ["tüvtürk", "TÜVTÜRK"],
];

const acrosMap = new Map<string, { upper: string; count: number }>();
for (const [low, up] of CANONICAL_ACROS) {
  acrosMap.set(low, { upper: up, count: 5000 });
}
for (const line of readFileSync(`${CORPUS_DIR}/acronyms.tsv`, "utf8").split("\n").slice(1)) {
  if (!line) continue;
  const [word, upper, wacS, wtotS, sacS, stotS] = line.split("\t");
  if (!word || !upper) continue;
  const wac = Number(wacS);
  const wtot = Number(wtotS);
  const sac = Number(sacS);
  const stot = Number(stotS);
  if (acrosMap.has(word) || word.length < 3 || word.length > 8) continue;
  if (ROMAN_RE.test(word) || UNITS_AND_NOISE_ACRO.has(word)) continue;
  if (commonLemmas.has(word) || morphology.isWord(word)) continue;
  if (!/^[a-zçğıöşü]+$/.test(word)) continue;
  if (wac < 120 || wac / Math.max(wtot, 1) < 0.94) continue;
  if (stot >= 5 && sac / stot < 0.8) continue;
  acrosMap.set(word, { upper, count: wac });
}

// --- 3. Clean Turkish Given Names (GIVEN) and Surnames (SURNAME) ---
const NON_PERSON_TOKENS = new Set<string>([
  ...INSTITUTION_HEADS, ...GEO_HEADS, ...STATE_HEADS, ...EVENT_HEADS,
  ...POST_HONORIFICS, ...PRE_TITLES_FULL, ...PRE_TITLES_ABBR, ...DIRECTIONS,
  ...TITLE_CONJUNCTIONS, ...ENGLISH_NOISE, ...MONTHS, ...WEEKDAYS,
  "birleşik", "kupası", "şampiyonası", "olimpiyatları", "milletler", "ödülü", "yayınları",
  "galerisi", "istasyonu", "başkanı", "bakanı", "devletleri", "han", "üyeliği", "başbakanı",
  "kralı", "üyesi", "yardımcısı", "sanat", "devlet", "halk", "cumhuriyet", "millî", "milli",
  "türk", "türkiye", "osmanlı", "istanbul", "ankara", "izmir", "anadolu", "avrupa", "asya",
  "amerika", "afrika", "dünya", "ulusal", "genel", "büyük", "küçük", "yeni", "eski", "kara",
  "beyaz", "kızıl", "yeşil", "mavi", "sarı", "orta", "iç", "dış", "üst", "alt",
  "alman", "fransız", "ingiliz", "ispanyol", "italyan", "rus", "japon", "yunan", "arap",
  "ermeni", "gürcü", "yahudi", "müslüman", "hristiyan", "islam", "allah",
  "bölümü", "merkezi", "madalyası", "krallık", "imparatorluk", "cumhuriyet", "federasyon",
  "partisi", "cemiyeti", "derneği", "vakfı", "kurumu", "kurulu", "meclisi", "bakanlığı",
]);

const givenMap = new Map<string, { display: string; count: number }>();
const surnameMap = new Map<string, { display: string; count: number }>();

// Seed with all Turkish person names from AMBIGUOUS_NAMES & PROMOTE_TO_UNCONDITIONAL that are personal names/surnames
const SEED_GIVEN = [
  // Common Turkish male & female given names (curated to ensure full coverage for title/honorific/kinship/surname frames)
  "abdullah", "abdurrahman", "adem", "adil", "adnan", "ahmet", "akif", "akın", "alaaddin", "ali",
  "alparslan", "alper", "alperen", "alp", "altan", "altay", "arda", "aras", "arif", "armağan",
  "arslan", "asım", "aslan", "atakan", "ateş", "atıf", "atilla", "aydın", "ayhan", "aykut",
  "aytaç", "aytekin", "aziz", "bahadır", "bahattin", "baki", "barbaros", "barış", "basri",
  "battal", "bayram", "bedirhan", "bedri", "behçet", "bekir", "berk", "berkant", "berkay",
  "berke", "bilal", "bilgehan", "birol", "bora", "bulut", "burak", "burhan", "bülent", "bünyamin",
  "cafer", "cahit", "can", "caner", "celal", "celil", "cem", "cemal", "cemil", "cengiz",
  "cevat", "cevdet", "ceyhun", "cihan", "cihangir", "coşkun", "cuma", "cumhur", "cüneyt",
  "çağatay", "çağdaş", "çağlar", "çağrı", "çetin", "davut", "demir", "deniz", "derviş", "devrim",
  "doğan", "doğukan", "doruk", "dursun", "edip", "efe", "egemen", "ekrem", "emin", "emir",
  "emirhan", "emrah", "emre", "ender", "enes", "engin", "enis", "enver", "eray", "ercan",
  "ercüment", "erdal", "erdem", "erdinç", "erdoğan", "eren", "ergin", "ergün", "erhan", "erkan",
  "erkin", "erkut", "erman", "erol", "ersan", "ersin", "ertan", "ertekin", "ertuğrul", "esat",
  "eşref", "ethem", "evren", "eyüp", "fahrettin", "fahri", "faik", "faruk", "fatih", "fehmi",
  "ferdi", "ferhat", "feridun", "ferit", "fethi", "fevzi", "feyyaz", "feyzi", "fırat", "fikret",
  "fikri", "fuat", "furkan", "galip", "gani", "giray", "gökalp", "gökay", "gökberk", "gökhan",
  "göksel", "göktuğ", "görkem", "güngör", "gürkan", "gürsel", "güven", "hakkı", "haldun", "halil",
  "halim", "halis", "halit", "haluk", "hamdi", "hamit", "hamza", "harun", "hasan", "haşim",
  "hayati", "haydar", "hayrettin", "hayri", "hidayet", "hikmet", "hilmi", "hulusi", "hurşit",
  "hüsamettin", "hüseyin", "hüsnü", "ibrahim", "idris", "ihsan", "ilhami", "ilhan", "ilkay",
  "ilker", "ilyas", "imdat", "inanç", "irfan", "isa", "ishak", "iskender", "ismail", "ismet",
  "izzet", "kaan", "kadir", "kadri", "kağan", "kahraman", "kamil", "kâmil", "kaplan", "kartal",
  "kasım", "kaya", "kayahan", "kayhan", "kazım", "kâzım", "kemal", "kenan", "kerem", "kerim",
  "kıvanç", "koray", "korhan", "korkut", "köksal", "kubilay", "kudret", "kurt", "kurtuluş",
  "kutay", "kürşat", "kürşad", "levent", "lokman", "lütfi", "macit", "mahir", "mahmut", "mansur",
  "mazhar", "mecit", "mehmet", "melih", "memduh", "menderes", "mert", "mesut", "mete", "metehan",
  "metin", "mevlüt", "mithat", "muammer", "muhammet", "muhammed", "muharrem", "muhittin",
  "muhsin", "murat", "musa", "mustafa", "mutlu", "muzaffer", "mücahit", "müfit", "müjdat",
  "mümin", "münir", "mürsel", "müslüm", "naci", "nadir", "nafiz", "nail", "naim", "namık",
  "nasuh", "nazım", "nâzım", "nazif", "nazmi", "nebi", "necati", "necdet", "necip", "necmettin",
  "necmi", "nedim", "neşet", "nevzat", "nezih", "nihat", "niyazi", "nizamettin", "nuh", "numan",
  "nurettin", "nuri", "nurullah", "nusret", "oğuz", "oğuzhan", "okan", "okay", "oktay", "olcay",
  "onur", "orçun", "orhan", "orkun", "osman", "ozan", "ömer", "önder", "özcan", "özer", "özgür",
  "özhan", "özkan", "polat", "poyraz", "rafet", "ragıp", "rahim", "rahmi", "ramazan", "ramiz",
  "rasim", "raşit", "rauf", "recai", "recep", "refik", "reha", "remzi", "resul", "reşat", "reşit",
  "rıdvan", "rıfat", "rıfkı", "rıza", "ruşen", "rüstem", "rüştü", "sabri", "sadettin", "sadık",
  "sadi", "sadri", "sadullah", "safa", "saffet", "sait", "salih", "salim", "samet", "sami",
  "sancar", "savaş", "saygın", "sebahattin", "seçkin", "sedat", "sefa", "selahattin", "selami",
  "selçuk", "selim", "semih", "sercan", "serdar", "serhat", "serkan", "sermet", "sertan", "servet",
  "seyfi", "seyfettin", "seyit", "sezai", "sezgin", "sıdkı", "sırrı", "sıtkı", "sinan", "suat",
  "suphi", "süleyman", "süreyya", "şaban", "şadi", "şafak", "şahin", "şakir", "şamil", "şefik",
  "şemsettin", "şener", "şenol", "şerafettin", "şeref", "şerif", "şevket", "şevki", "şinasi",
  "şükrü", "taha", "tahir", "tahsin", "talat", "talha", "talip", "tamer", "taner", "tanju",
  "tansu", "tarık", "taşkın", "tayfun", "taylan", "tayyar", "tayyip", "tekin", "temel", "tevfik",
  "timur", "tolga", "tolgahan", "toprak", "tufan", "tugay", "tuğrul", "tuna", "tunahan", "tuncay",
  "tuncer", "turan", "turgay", "turgut", "turhan", "türker", "ufuk", "uğur", "ulvi", "umut",
  "utku", "uygar", "ümit", "ünal", "ünsal", "vahap", "vahit", "varol", "vedat", "vehbi", "veli",
  "veysel", "veysi", "volkan", "yahya", "yakup", "yalçın", "yaman", "yasin", "yaşar", "yavuz",
  "yekta", "yener", "yıldıray", "yıldırım", "yılmaz", "yiğit", "yunus", "yusuf", "yücel", "yüksel",
  "zafer", "zekai", "zekeriya", "zeki", "zihni", "ziya", "zühtü", "zülfikar",
  // Female given names
  "açelya", "adalet", "afife", "ahu", "ajda", "alara", "alev", "aleyna", "aliye", "almıla", "arzu", "aslı",
  "aslıhan", "asude", "asuman", "asya", "aybike", "aybüke", "ayça", "aydan", "ayfer", "aygül",
  "ayhan", "ayla", "aylin", "aynur", "aysel", "aysu", "aysun", "ayşe", "ayşegül", "ayşen",
  "ayşenur", "ayten", "azize", "azra", "bahar", "banu", "başak", "bedia", "begüm", "behiye",
  "belgin", "belkıs", "bengü", "beren", "berfin", "beril", "berna", "berrak", "beste", "betül",
  "beyhan", "beyza", "bihter", "bilge", "binnaz", "birgül", "birsen", "buket", "burcu", "burçin",
  "buse", "büşra", "canan", "cansu", "cemile", "cemre", "ceren", "ceyda", "ceylan", "çağla",
  "çiçek", "çiğdem", "damla", "defne", "demet", "deniz", "derya", "didem", "dilara", "dilber",
  "dilek", "doğa", "duygu", "ebru", "ece", "ecem", "eda", "ekin", "ela", "elçin", "elif", "elmas",
  "emel", "emine", "esma", "esra", "eylem", "eylül", "ezgi", "fadime", "fahriye", "fatma",
  "fatoş", "feray", "ferda", "feride", "feriha", "feyza", "fidan", "figen", "fikriye", "filiz",
  "funda", "füsun", "gamze", "gaye", "gizem", "gonca", "gökçe", "gökçen", "gönül", "gözde",
  "gül", "gülay", "gülbahar", "gülcan", "gülden", "gülen", "güler", "gülfem", "gülhan", "gülistan",
  "gülizar", "gülpembe", "gülşen", "gülten", "günay", "güneş", "güngör", "habibe", "hacer",
  "hafize", "hale", "halide", "halime", "hamide", "handan", "hande", "hanife", "hasibe", "hatice",
  "havva", "hayal", "hayriye", "hazal", "hazan", "helin", "hilal", "huriye", "hülya", "hümeyra",
  "ırmak", "ışık", "ışıl", "ışın", "ilayda", "ilgaz", "ilgim", "ilknur", "imge", "inci", "ipek",
  "irem", "jale", "kader", "kadriye", "kamile", "kardelen", "kevser", "kıymet", "kiraz", "kübra",
  "lale", "lamia", "latife", "leman", "lerzan", "leyla", "lütfüye", "macide", "makbule", "mediha",
  "mehtap", "melahat", "melda", "melek", "meliha", "melike", "melis", "melisa", "meltem",
  "menekşe", "meral", "mercan", "meriç", "merve", "meryem", "mihriban", "mine", "miray", "mualla",
  "muazzez", "mukaddes", "münevver", "münire", "müge", "müjgan", "müşerref", "naciye", "nadide",
  "nadire", "nagehan", "naile", "naime", "nalan", "nazan", "nazife", "nazlı", "nazmiye", "nebahat",
  "necla", "nedret", "nehir", "neriman", "nermin", "nesibe", "neslihan", "nesrin", "neşe",
  "neval", "nevin", "nevra", "nigar", "nihal", "nihan", "nil", "nilay", "nilgün", "nilüfer",
  "nimet", "nisa", "nisan", "nuran", "nuray", "nurcan", "nurdane", "nurgül", "nurhan", "nuriye",
  "nursel", "nursen", "nurten", "nur", "oya", "öykü", "özden", "özge", "özgül", "özlem", "öznur",
  "pakize", "papatya", "pelin", "pembe", "perihan", "pervin", "pınar", "rabia", "rahime", "rahşan",
  "raziye", "rebia", "remziye", "reyhan", "rezzan", "rukiye", "rüya", "saadet", "sabahat",
  "sabiha", "sabriye", "sadiye", "safiye", "sahra", "sakine", "saliha", "saniye", "sebahat",
  "seçil", "seda", "sedef", "seher", "selcan", "selda", "selen", "selin", "selma", "selvi",
  "sema", "semiha", "semra", "sena", "senem", "serap", "seren", "serpil", "serra", "sevcan",
  "sevda", "sevgi", "sevil", "sevilay", "sevim", "sevinç", "seyhan", "sezen", "sezin", "sıla",
  "sibel", "simge", "sinem", "songül", "sude", "sultan", "suna", "suzan", "süheyla",
  "sümbül", "şadiye", "şafak", "şahika", "şaziye", "şebnem", "şefika", "şehnaz", "şehriban",
  "şenay", "şengül", "şennur", "şerife", "şevval", "şeyda", "şeyma", "şirin", "şule", "şükran",
  "şükriye", "tansu", "tuba", "tuğba", "tuğçe", "tulay", "tülay", "tülin", "türkan", "ufuk",
  "ulviye", "umay", "ülkü", "ülker", "ümran", "ümmühan", "ünzile", "vahide", "vecihe", "vesile",
  "vildan", "yağmur", "yaprak", "yasemin", "yelda", "yeliz", "yeşim", "yeter", "yıldız", "yonca",
  "yurdagül", "zahide", "zehra", "zekiye", "zeliha", "zerrin", "zeynep", "zübeyde", "zuhal",
  "zühal", "züleyha", "zülfiye", "zümra", "zümrüt",
];
for (const g of SEED_GIVEN) givenMap.set(g, { display: capTr(g), count: 500 });

// Curated Turkish surnames (top ~120 genuine Turkish surnames; avoids leaking common adjectives/verbs like "yeni", "oldu", "olsun").
const SEED_SURNAMES = [
  "yılmaz", "kaya", "demir", "çelik", "şahin", "yıldız", "yıldırım", "öztürk", "aydın", "özdemir",
  "arslan", "doğan", "kılıç", "aslan", "çetin", "kara", "koç", "kurt", "özkan", "şimşek",
  "polat", "korkmaz", "çakır", "erdoğan", "bulut", "güneş", "ateş", "tekin", "şen", "güler",
  "aksoy", "keskin", "ünal", "turan", "yüksel", "avcı", "karaca", "kaplan", "bozkurt", "taş",
  "aktaş", "toprak", "ışık", "boz", "sarı", "tan", "oral", "tunç", "çınar", "ekinci",
  "alkan", "sönmez", "sezer", "demirtaş", "karabekir", "inalcık", "inönü", "manço", "yücel",
  "atatürk", "kemal", "emre", "pamuk", "tanpınar", "hikmet", "sabancı", "soylu",
  "akın", "albayrak", "altun", "arık", "atay", "bağcı", "balcı", "başar", "bayram", "bilgin",
  "ceylan", "coşkun", "çağlar", "çalışkan", "çiftçi", "çoban", "dalgıç", "demirel", "duman",
  "durmaz", "dursun", "ergin", "erkan", "erol", "ersoy", "ertürk", "gökçe", "gökmen", "gültekin",
  "gümüş", "günay", "gündoğdu", "gündüz", "güngör", "gürbüz", "gürsoy", "ilhan", "kahraman",
  "kalaycı", "karahan", "karakaş", "karakoç", "karakuş", "karaman", "karataş", "kartal",
  "kayahan", "kaymak", "keleş", "kızılkaya", "koçak", "koçyiğit", "oktay", "özbek", "özcan",
  "özçelik", "özen", "özer", "özgür", "özmen", "pala", "peker", "salman", "sancak", "sanlı",
  "sarıca", "sarıkaya", "seçkin", "soydan", "söylemez", "sözer", "sümer", "şengül", "şentürk",
  "tamer", "taner", "tanrıverdi", "tarhan", "taşcı", "taşçı", "taşdemir", "taşkın", "taylan",
  "toker", "tokmak", "topçu", "torun", "tosun", "tuncay", "tuncer", "turgut", "türkmen",
  "türkoğlu", "tütüncü", "uğurlu", "uludağ", "ulusoy", "ural", "uygur", "uysal", "ülker",
  "ünlü", "üstün", "varol", "vural", "yalçın", "yaman", "yapıcı", "yaşar", "yavuz", "yazıcı",
  "yetkin", "yiğit", "yörük", "yurtsever", "zengin",
];
for (const s of SEED_SURNAMES) surnameMap.set(s, { display: capTr(s), count: 500 });

// Add mined Turkish first names and surnames from Wikipedia ONLY when they are NOT common Turkish words!
// (Prevents movie/book titles like "Kutlu Olsun (2015)", "Zor Oldu (2012)", "İki Saat" from leaking common words!)
const isPureProperPersonToken = (lw: string): boolean => {
  if (NON_PERSON_TOKENS.has(lw) || !/^[a-zçğıöşüâîû]+$/.test(lw)) return false;
  if (commonLemmas.has(lw) || morphology.isWord(lw)) return false;
  const st = wordStats.get(lw);
  if (!st || st.wcl + st.wcc < 40) return false;
  if (st.wll > st.wcl * 0.1 || st.sl >= 5) return false;
  return true;
};

for (const line of readFileSync(`${CORPUS_DIR}/first_names.tsv`, "utf8").split("\n")) {
  if (!line) continue;
  const [lw, disp, cntS] = line.split("\t");
  const cnt = Number(cntS);
  if (!lw || !disp || cnt < 25 || lw.length < 3) continue;
  if (!isPureProperPersonToken(lw)) continue;
  if (!givenMap.has(lw) && givenMap.size < 2000) givenMap.set(lw, { display: disp, count: cnt });
}
for (const line of readFileSync(`${CORPUS_DIR}/surnames.tsv`, "utf8").split("\n")) {
  if (!line) continue;
  const [lw, disp, cntS] = line.split("\t");
  const cnt = Number(cntS);
  if (!lw || !disp || cnt < 20 || lw.length < 3) continue;
  if (!isPureProperPersonToken(lw)) continue;
  if (!surnameMap.has(lw) && surnameMap.size < 2500) surnameMap.set(lw, { display: disp, count: cnt });
}

// --- 4. Multi-word Proper Phrases (PHRASE_APOS / PHRASE_NOAPOS) ---
const phrases = new Map<string, { display: string; takesApos: boolean; count: number }>();

for (const [display, takesApos] of CANONICAL_PHRASES) {
  const low = lowerTr(display);
  phrases.set(low, { display, takesApos, count: 10000 });
}

const GENERIC_PHRASE_FIRST = new Set([
  "tıp", "hukuk", "devlet", "özel", "büyük", "yeni", "eski", "ilk", "son",
  "yönetim", "genel", "icra", "denetim", "danışma", "bilim", "seçim", "hakem", "yürütme",
  "iletişim", "spor", "futbol", "basketbol", "voleybol", "kültür", "alışveriş", "sağlık",
  "iş", "ticaret", "eğitim", "araştırma", "bölge", "il", "ilçe", "emniyet", "nüfus", "tapu",
  "halk", "şehir", "köy", "mahalle", "merkez", "yüksek", "askeri", "askerî", "sanat", "müzik",
  "fen", "edebiyat", "mühendislik", "iktisat", "işletme", "mimarlık", "eczacılık", "ilahiyat",
  "belediye", "büyükşehir", "valilik", "kaymakamlık",
]);

// Mine clean Turkish multi-word phrases from Wikipedia (institutions, places, states, events, wars)
for (const line of readFileSync(`${CORPUS_DIR}/phrases.tsv`, "utf8").split("\n").slice(1)) {
  if (!line) continue;
  const [low, disp, capS] = line.split("\t");
  const cnt = Number(capS);
  if (!low || !disp || cnt < 120) continue;
  if (phrases.has(low)) continue;
  const words = low.split(" ");
  if (words.length < 2 || words.length > 5) continue;
  // Must be Turkish letters only (no English noise words)
  if (words.some((w) => !/^[a-zçğıöşüâîû]+$/.test(w) || ENGLISH_NOISE.has(w))) continue;
  const last = words.at(-1)!;
  const prev = words.at(-2)!;
  // Exclude generic unanchored 2-word phrases ("yönetim kurulu", "tıp fakültesi", "spor kulübü", "iletişim bölümü", "genel müdürlüğü")
  if (words.length === 2 && GENERIC_PHRASE_FIRST.has(words[0]!)) {
    continue;
  }
  let takesApos: boolean | null = null;
  if (isInstitutionHead(last, prev)) {
    takesApos = false;
  } else if (GEO_HEADS.has(last) || STATE_HEADS.has(last) || EVENT_HEADS.has(last)) {
    // Avoid generic 2-word event/geo phrases unless high-frequency
    if (words.length === 2 && (words[0] === "iç" || words[0] === "dünya" || words[0] === "sivil" || words[0] === "soğuk")) {
      if (low !== "soğuk savaş") continue;
    }
    takesApos = true;
  } else if (
    words.length === 2 &&
    (DIRECTIONS.has(words[0]!) || words[0] === "yeni" || words[0] === "suudi" || words[0] === "bosna") &&
    (namesMap.has(last) || properDict.has(last))
  ) {
    takesApos = true;
  }
  if (takesApos === null) continue;
  // Fix any capitalized internal conjunctions in mined Wikipedia display forms
  const fixedDisp = disp
    .split(" ")
    .map((w, i) => (i > 0 && i < words.length - 1 && TITLE_CONJUNCTIONS.has(lowerTr(w)) ? lowerTr(w) : w))
    .join(" ");
  phrases.set(low, { display: fixedDisp, takesApos, count: cnt });
  if (phrases.size >= 2500) break;
}

// --- 5. Ambiguous Names (AMBIG) ---
const ambigMap = new Map<string, string>();
for (const w of AMBIGUOUS_NAMES) {
  if (namesMap.has(w)) continue;
  if (MONTHS.has(w) || WEEKDAYS.has(w)) continue;
  ambigMap.set(w, capTr(w));
}

// --- Write data/rules/names.tsv ---
const out: string[] = [
  "# lowercase\tdisplay\tflags\tcount\tsection   (py/mine_names_corpus.py + scripts/build-names.ts)",
];

for (const [w, info] of [...namesMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`${w}\t${info.display}\t${info.noApos ? "noapos" : "0"}\t${info.count}\tNAME`);
}
for (const [w, info] of [...acrosMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`${w}\t${info.upper}\t0\t${info.count}\tACRO`);
}
for (const [w, info] of [...givenMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`${w}\t${info.display}\t0\t${info.count}\tGIVEN`);
}
for (const [w, info] of [...surnameMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`${w}\t${info.display}\t0\t${info.count}\tSURNAME`);
}
for (const [w, disp] of [...ambigMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`${w}\t${disp}\t0\t0\tAMBIG`);
}
for (const [low, info] of [...phrases.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`${low}\t${info.display}\t0\t${info.count}\t${info.takesApos ? "PHRASE_APOS" : "PHRASE_NOAPOS"}`);
}

writeFileSync("data/rules/names.tsv", out.join("\n") + "\n");
console.log(
  `Wrote data/rules/names.tsv: NAME=${namesMap.size}, ACRO=${acrosMap.size}, GIVEN=${givenMap.size}, ` +
    `SURNAME=${surnameMap.size}, AMBIG=${ambigMap.size}, PHRASE=${phrases.size} (total ${out.length - 1} rows)`,
);
