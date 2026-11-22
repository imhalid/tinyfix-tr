import { followsHarmony, isVoicelessFinal, lastVowel } from "./turkish-rules.ts";
import { lowerTr, upperTr } from "../turkish.ts";

/** Months and weekdays: capitalized per TDK ONLY when tied to a specific calendar date ("17 Aralık'a", "12 Haziran 2027 Cumartesi"). */
export const MONTHS = new Set([
  "ocak", "şubat", "mart", "nisan", "mayıs", "haziran",
  "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık",
]);

export const WEEKDAYS = new Set([
  "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi", "pazar",
]);

/**
 * TDK institution, organization, board, assembly, and workplace head words (singular/P3sg).
 * Suffixes attached to these take NO apostrophe per TDK ("Türk Dil Kurumundan", "Ankara Üniversitesine",
 * "Bakanlar Kurulunun", "Mavi Köşe Bakkaliyesinden").
 * Exceptions: "Avrupa Birliği'ne" (TDK explicit exception) and "Rusya Federasyonu'na" (state name).
 */
export const INSTITUTION_HEADS = new Set([
  "kurumu", "kuruluşu", "kurulu", "bakanlığı", "müdürlüğü", "başkanlığı",
  "üniversitesi", "fakültesi", "enstitüsü", "yüksekokulu", "okulu", "ilkokulu",
  "ortaokulu", "lisesi", "koleji", "akademisi", "bölümü", "rektörlüğü", "dekanlığı",
  "meclisi", "belediyesi", "valiliği", "kaymakamlığı", "muhtarlığı", "mahkemesi",
  "savcılığı", "başsavcılığı", "barosu", "komisyonu", "komitesi", "heyeti", "konseyi", "senatosu",
  "oturumu", "birleşimi", "hastanesi", "polikliniği", "kliniği", "eczanesi",
  "kütüphanesi", "tiyatrosu", "tiyatroları", "operası", "balesi", "konservatuvarı", "müzesi",
  "bankası", "borsası", "ajansı", "vakfı", "derneği", "odası", "sendikası",
  "federasyonu", "konfederasyonu", "birliği", "partisi", "teşkilatı", "örgütü",
  "idaresi", "müsteşarlığı", "koordinatörlüğü", "temsilciliği", "konsolosluğu",
  "büyükelçiliği", "elçiliği", "komutanlığı", "emniyeti",
  "şirketi", "holdingi", "ortaklığı", "kooperatifi", "işletmesi", "fabrikası", "atölyesi", "matbaası",
  "yayınevi", "kitabevi", "basımevi", "öğretmenevi", "polisevi", "orduevi",
  "mağazası", "marketi", "bakkaliyesi", "pastanesi", "fırını", "lokantası",
  "restoranı", "kafesi", "oteli", "kulübü", "yolları", "havayolları", "demiryolları",
  "karayolları", "petrolleri", "enerjisi", "telekomu", "cemiyeti", "çiftliği",
]);

/** Officer/leader title heads immediately following a proper institution ("Türk Dil Kurumu Başkanı'na", "Ankara Üniversitesi Rektörü'ne"). */
export const OFFICER_TITLE_HEADS = new Set([
  "başkanı", "müdürü", "rektörü", "dekanı", "bakanı", "komutanı", "başsavcısı",
  "savcısı", "sekreteri", "sözcüsü", "temsilcisi", "müsteşarı", "valisi", "kaymakamı", "yardımcısı",
]);

/** Optional preceding modifiers for a 2-word officer title after an institution ("Genel Müdürü", "Genel Başkanı", "Genel Sekreteri", "Başkan Yardımcısı"). */
export const OFFICER_TITLE_MODS = new Set([
  "genel", "başkan", "belediye", "okul", "bölüm", "cumhuriyet", "meclis", "yüksek",
]);

/** Institution heads that need an explicit proper-name anchor before them to be capitalized (generic alone: "tıp fakültesi"). */
export const GENERIC_ALONE_INST_HEADS = new Set([
  "fakültesi", "bölümü", "okulu", "ilkokulu", "ortaokulu", "lisesi", "enstitüsü",
  "yüksekokulu", "hastanesi", "kliniği", "polikliniği", "eczanesi", "kütüphanesi",
  "müdürlüğü", "başkanlığı", "komisyonu", "komitesi", "mahkemesi", "odası",
  "derneği", "vakfı", "sendikası", "şirketi", "kooperatifi", "işletmesi",
  "fabrikası", "atölyesi", "mağazası", "marketi", "fırını", "lokantası",
  "restoranı", "kafesi", "oteli", "kulübü", "partisi", "birliği", "meclisi",
  "kurulu", "kurumu", "bankası", "ajansı", "belediyesi", "valiliği", "kaymakamlığı",
  "tiyatrosu", "operası", "müzesi", "merkezi", "ortaklığı", "pastanesi", "bakkaliyesi",
  "yolları", "petrolleri", "üniversitesi", "bakanlığı", "koleji", "akademisi",
]);

/** Generic modifier words that alone (without a proper-name anchor) form lowercase generic phrases like "tıp fakültesi", "devlet hastanesi", "ilçe belediyesi". */
export const GENERIC_INST_MODIFIERS = new Set([
  "tıp", "hukuk", "mühendislik", "fen", "edebiyat", "iktisat", "işletme", "eğitim",
  "mimarlık", "eczacılık", "ilahiyat", "iletişim", "ziraat", "veteriner", "turizm",
  "devlet", "özel", "şehir", "ilçe", "il", "bölge", "araştırma", "eğitim", "semt",
  "mahalle", "köy", "merkez", "genel", "yeni", "eski", "büyük", "küçük", "ilk", "son",
  "sağlık", "kültür", "spor", "sanat", "bilim", "çocuk", "kadın", "erkek", "kız",
  "askeri", "askerî", "belediye", "halk", "kamu", "anonim", "limited", "ticaret",
  "siyasal", "bilgiler", "idari", "iktisadi", "bilimler", "dil", "dili", "edebiyatı",
  "tarih", "matematik", "fizik", "kimya", "biyoloji", "psikoloji", "sosyoloji",
  "felsefe", "coğrafya", "bilgisayar", "elektrik", "elektronik", "makine", "inşaat",
  "endüstri", "gıda", "çevre", "orman", "maden", "jeoloji", "harita", "tekstil",
  "diş", "hekimliği", "hemşirelik", "güzel", "sanatlar", "sahne", "müzik",
  "ticari", "meslek", "teknik", "anadolu", "fen", "imam", "hatip", "sosyal",
  "güvenlik", "üst", "düzenleme", "denetleme", "bankacılık", "radyo", "televizyon",
  "hava", "demir", "kara", "su", "işleri", "petrolleri", "cumhuriyet", "millet",
  "bakanlar", "yüksek", "öğretim", "yükseköğretim", "millî", "milli", "içişleri",
  "dışişleri", "adalet", "maliye", "hazine", "sanayi", "teknoloji", "tarım",
  "şehircilik", "ulaştırma", "altyapı", "çalışma", "gençlik", "aile", "savunma",
  "enerji", "tabii", "kaynaklar", "meteoroloji", "emniyet", "diyanet", "büyükşehir",
  "köşe", "mavi", "çam", "sakura", "dokuz", "eylül", "on", "sekiz", "mart",
  "ondokuz", "mayıs", "yirmi", "sütçü", "namık", "orta", "doğu", "batı", "kuzey",
  "güney", "ziraat", "vakıf", "iş", "garanti", "yapı", "kredi",
]);

/** Words that CANNOT serve as an unanchored first word of a compositional institution name (prepositions, verbs, determiners, adjectives). */
export const NON_INST_PREFIX = new Set([
  "bir", "bu", "şu", "o", "her", "hiç", "bazı", "tüm", "bütün", "diğer", "başka",
  "aynı", "yeni", "eski", "iyi", "kötü", "güzel", "büyük", "küçük", "uzun", "kısa",
  "ilk", "son", "ikinci", "üçüncü", "geçen", "gelecek", "yarın", "bugün", "dün",
  "sabah", "akşam", "gece", "hafta", "ay", "yıl", "için", "göre", "kadar", "sonra",
  "önce", "karşı", "doğru", "boyunca", "hakkında", "üzerine", "ile", "ve", "veya",
  "ama", "fakat", "ancak", "çünkü", "de", "da", "ki", "mi", "mı", "mu", "mü",
  "çok", "az", "daha", "en", "pek", "hem", "ne", "ya", "ben", "sen", "biz", "siz",
  "onlar", "benim", "senin", "onun", "bizim", "sizin", "onların", "kendi",
  "köşedeki", "mahalledeki", "yakındaki", "karşıdaki", "yanındaki", "buradaki",
  "oradaki", "şuradaki", "bizimki", "yıllık", "devlet", "özel", "tıp", "hukuk",
  "mühendislik", "eğitim", "sağlık", "spor", "kültür", "semt", "il", "ilçe",
  "köy", "mahalle", "şehir", "bölge", "merkez", "genel",
]);

/** TDK geographic, urban, and landmark head words that take capitalization AND apostrophe after a proper name. */
export const GEO_HEADS = new Set([
  "dağı", "dağları", "sıradağları", "gölü", "gölleri", "denizi", "okyanusu", "okyanus",
  "nehri", "ırmağı", "deresi", "boğazı", "körfezi", "kanalı", "şelalesi",
  "yarımadası", "takımadası", "burnu",
  "ovası", "yaylası", "platosu", "kanyonu", "çölü", "ormanı", "mağarası",
  "havzası",
  "mahallesi", "caddesi", "sokağı", "bulvarı", "meydanı", "parkı", "şehitliği",
  "sarayı", "köşkü", "hisarı", "köprüsü", "kulesi", "camisi", "camii", "türbesi", "anıtı",
  "katedrali", "manastırı", "tapınağı", "külliyesi", "kervansarayı",
  "havalimanı", "garı", "stadyumu",
]);

/** State/polity head words (capitalize + apostrophe after a proper name). */
export const STATE_HEADS = new Set([
  "cumhuriyeti", "devleti", "imparatorluğu", "krallığı", "prensliği",
  "beyliği", "hanlığı", "sultanlığı", "kağanlığı",
]);

/** Historical event/war/treaty/era head words (capitalize + apostrophe after a proper place/nationality). */
export const EVENT_HEADS = new Set([
  "savaşı", "muharebesi", "antlaşması", "anlaşması",
  "ihtilali", "devrimi", "fermanı", "göçü", "devri",
]);

/** Direction modifiers capitalized BEFORE a proper place ("Batı Anadolu", "Doğu Karadeniz"), never after ("Anadolu'nun batısı"). */
export const DIRECTIONS = new Set([
  "doğu", "batı", "kuzey", "güney", "orta", "iç",
  "kuzeydoğu", "kuzeybatı", "güneydoğu", "güneybatı",
]);

/** Abbreviated titles placed before a person name ("Prof. Dr. Halil İnalcık", "Av. Melike Sönmez", "Op. Dr. Sinan Güler"). */
export const PRE_TITLES_ABBR = new Set([
  "prof", "doç", "doc", "yrd", "op", "uzm", "dr", "av",
  "öğr", "ogr", "gör", "gor", "müh", "muh", "mim", "ecz", "dt", "vet", "arb", "sn", "hz",
  "mr", "mrs", "ms",
]);

/** Unabbreviated titles & ranks capitalized before a person name ("Cumhurbaşkanı İsmet İnönü", "Albay Nurettin Şahin", "Bayan Elif Tan"). */
export const PRE_TITLES_FULL = new Set([
  "bay", "bayan", "cumhurbaşkanı", "başbakan", "bakan", "vali", "kaymakam",
  "başkan", "müdür", "dekan", "rektör", "profesör", "doçent", "doktor", "avukat",
  "hâkim", "hakim", "savcı", "başsavcı", "komiser", "başkomiser", "müfettiş", "kaptan",
  "albay", "yarbay", "binbaşı", "yüzbaşı", "üsteğmen", "teğmen", "asteğmen",
  "astsubay", "başçavuş", "çavuş", "general", "orgeneral", "korgeneral", "tümgeneral",
  "tuğgeneral", "mareşal", "amiral", "oramiral", "koramiral", "tümamiral", "tuğamiral",
  "komutan", "büyükelçi", "başkonsolos", "konsolos", "başhekim", "başöğretmen",
  "sultan", "padişah", "şehzade", "kral", "kraliçe", "prens", "prenses",
  "imparator", "çar", "mimar", "gazi", "hazreti", "şeyh", "imam", "hacı",
]);

/** Official titles capitalized directly after "Sayın" ("Sayın Başkan", "Sayın Müdür", "Sayın Büyükelçi"; NOT "Sayın hocam"). */
export const SAYIN_TITLES = new Set([
  "başkan", "başkanım", "müdür", "müdürüm", "dekan", "dekanım", "rektör", "rektörüm",
  "vali", "valim", "kaymakam", "bakan", "bakanım", "büyükelçi", "komutan", "komutanım",
  "cumhurbaşkanı", "başbakan", "milletvekili", "savcı", "başsavcı", "hâkim", "hakim",
  "avukat", "profesör", "doçent", "doktor", "yargıç", "elçi", "konsolos", "başkonsolos",
  "general", "amiral", "albay", "müsteşar", "başhekim",
  "üyeler", "konuklar", "misafirler", "veliler", "öğrenciler", "katılımcılar",
  "dinleyiciler", "izleyiciler", "seyirciler", "milletvekilleri", "öğretmenler",
  "meslektaşlar", "meslektaşlarım", "hanımlar", "beyler",
]);

/** First word of a 2-word official title after "Sayın" ("Sayın Genel Müdür", "Sayın Belediye Başkanı", "Sayın Cumhuriyet Başsavcısı"). */
export const SAYIN_COMPOUND_FIRST = new Set([
  "genel", "belediye", "okul", "bölüm", "cumhuriyet", "meclis", "kurul", "devlet", "millî", "milli",
]);

/** Second/third word continuing an official title after "Sayın" ("Müdür Yardımcısı", "Genel Sekreter", "Belediye Başkanı"). */
export const SAYIN_COMPOUND_TAIL = new Set([
  "başkanı", "müdürü", "savcısı", "başsavcısı", "sekreteri", "sekreter", "yardımcısı",
  "kurulu", "üyesi", "müdür", "başkan", "bakanı", "komutanı", "vekil", "vekili",
]);

/** Post-nominal honorific titles (capitalized AND take apostrophe after a person name: "Ayşe Hanım'a", "Orhan Bey'de"). */
export const POST_HONORIFICS = new Set(["bey", "hanım", "efendi", "paşa", "ağa", "beyefendi", "hanımefendi"]);

/** Post-nominal occupational/historical titles capitalized + apostrophe after a person name ("Ahmet Hoca'ya", "Mehmet Usta'nın", "Ali Çavuş'un", "Seyit Onbaşı'yı", "Temel Kaptan'a"). */
export const POST_TITLES_WITH_APOS = new Set([
  "hoca", "usta", "öğretmen", "çavuş", "onbaşı", "reis", "çelebi", "hatun", "kaptan",
]);

/** Kinship words after a person name: stay LOWERCASE per TDK ("Tülay ablama", "Zehra halamın"), while proving the previous word is a person name. */
export const KINSHIP_STEMS = new Set([
  "abla", "abi", "ağabey", "hala", "teyze", "amca", "dayı", "enişte", "yenge",
  "dede", "nine", "babaanne", "anneanne",
]);

/** Nominative person-relationship/occupation descriptors right before a person name ("arkadaşım Melek", "kardeşim Ateş", "komşumuz Bahar'ın", "yazar Defne Arslan"). */
export const PERSON_REL_BEFORE = new Set([
  "arkadaşım", "arkadaşımız", "komşum", "komşumuz", "kardeşim", "abim", "ablam", "ağabeyim",
  "kuzenim", "yeğenim", "oğlum", "kızım", "eşim", "sevgilim", "nişanlım", "dostum",
  "öğrencim", "öğrencimiz", "meslektaşım", "ortağım",
  "yazar", "şair", "ressam", "yönetmen", "oyuncu", "şarkıcı", "müzisyen",
  "futbolcu", "basketbolcu", "voleybolcu", "sporcu", "sanatçı", "gazeteci",
  "adı",
]);

/** Lowercase media/work type words following a capitalized work/publication title ("Varlık dergisine", "Muhsin Bey filmini"). */
export const MEDIA_TYPE_STEMS = new Set([
  "dergi", "gazete", "roman", "kitap", "film", "dizi", "oyun", "şiir",
  "öykü", "hikâye", "hikaye", "eser", "albüm", "şarkı", "tablo", "opera",
]);

/** Language names (always capitalized, NEVER take an apostrophe before suffixes: "Türkçeyi", "Almancaya", "Yunancanın"). */
export const LANGUAGE_NAMES = new Set([
  "türkçe", "almanca", "ingilizce", "fransızca", "ispanyolca", "italyanca", "portekizce",
  "rusça", "arapça", "farsça", "yunanca", "japonca", "çince", "korece", "moğolca",
  "türkmence", "gürcüce", "lazca", "osmanlıca", "latince", "sanskritçe", "felemenkçe",
  "hollandaca", "kürtçe", "ermenice", "azerice", "özbekçe", "kazakça", "kırgızca",
  "uygurca", "tatarca", "bulgarca", "sırpça", "hırvatça", "boşnakça", "arnavutça",
  "macarca", "çekçe", "slovakça", "slovence", "rumence", "isveççe", "norveççe", "danca",
  "fince", "izlandaca", "ukraynaca", "belarusça", "litvanca", "letonca", "estonca",
  "katalanca", "baskça", "galce", "irlandaca", "iskoçça", "ibranice", "hintçe", "urduca",
  "bengalce", "tayca", "vietnamca", "endonezce", "malayca", "svahilice", "amharca",
  "süryanice", "aramice", "kıptice", "akatça", "hititçe", "sümerce", "göktürkçe",
  "çağatayca", "kıpçakça", "oğuzca", "esperanto", "abazaca", "acemce", "çerkezce",
  "abhazca", "osetçe", "zazaca", "rumca", "pomakça", "gagavuzca", "yakutça", "çuvaşça",
  "tuvaca", "hakasça", "altayca", "başkurtça", "kumukça", "karaçayca", "nogayca",
  "karakalpakça", "peştuca", "tacikçe", "beluçça", "pencapça", "tamilce", "teluguca",
  "kannadaca", "malayalamca", "maratice", "güceratça", "nepalce", "sinhalaca", "birmanca",
  "khmerce", "laoca", "tagalogca", "endonezyaca", "maltaca", "afrikanca", "zuluca",
  "somalice", "hausaca", "yorubaca", "igboca",
]);

/** Religion/sect/ideology derived proper nouns with Turkish derivational suffixes (-lIk/-lI/-cI) that strictly take NO apostrophe per TDK ("Hristiyanlıkta", "Müslümanlık"). */
export const NO_APOS_RELIGION_OR_DERIVED = new Set([
  "hristiyanlık", "müslümanlık", "yahudilik", "musevilik", "türklük", "osmanlılık",
  "atatürkçülük", "zerdüştlük", "protestanlık", "katoliklik", "ortodoksluk",
  "alevilik", "sünnilik", "şiilik", "hanefilik", "şafiilik", "osmanlıcılık", "türkçülük",
  "avrupalı", "asyalı", "afrikalı", "amerikalı", "anadolulu",
  "istanbullu", "ankaralı", "izmirli", "bursalı", "adanalı", "antalyalı", "konyalı",
  "trabzonlu", "rizeli", "erzurumlu", "diyarbakırlı", "eskişehirli", "tokatlı",
  "galatasaraylı", "fenerbahçeli", "beşiktaşlı", "trabzonsporlu",
]);

/** Foreign/Arabic -izm/-iyet religion & movement names: capitalize without forcing apostrophe when joined ("hinduizmde" -> "Hinduizmde"),
 *  but NEVER strip an existing apostrophe ("İslamiyet'e", "Budizm'in", "Hinduizm'de" stay intact). */
export const OPTIONAL_APOS_ISM_IYET = new Set([
  "islamiyet", "hinduizm", "budizm", "taoizm", "şintoizm", "sihizm", "marksizm", "leninizm", "kemalizm",
]);

/** Proper names whose own root ends in -lar/-ler (places, ranges) and therefore DO keep an apostrophe. */
export const PLURAL_PLACE_KEEP_APOS = new Set([
  "bağcılar", "avcılar", "adalar", "toroslar", "alpler", "balkanlar", "andlar",
  "himalayalar", "pireneler", "karpatlar", "kırklar", "atalar", "kavaklar",
  "ışıklar", "çınarlar", "kayalar", "konaklar", "sarılar", "yaylalar", "pınarlar",
  "taşlar", "kızıllar", "bayırlar", "kuzular", "doğular", "çamlar", "güller",
]);

/** Proper names whose own root ends in -lı/-li/-lık/-ca/-ce and therefore DO keep an apostrophe. */
export const DERIV_LOOKING_KEEP_APOS = new Set([
  "denizli", "kocaeli", "tunceli", "kırklareli", "rumeli", "şişli", "aydınlı",
  "osmanlı", "selçuklu", "karamanlı", "mali", "şili", "bali", "kandilli", "tuzla",
  "ayvalık", "gemlik", "susurluk", "bilecik", "zonguldak", "karabük", "çankırı",
  "karaca", "çamlıca", "sütlüce", "büyükçekmece", "küçükçekmece", "kızılca", "yenice",
  "ali", "veli", "aslı", "nazlı", "ece", "tülay", "hüsnü", "şükrü", "binali", "hayali",
  "karaköy", "kadıköy", "bakırköy", "kayaköy", "urla", "muğla", "amasra",
]);

/** Stems with inverse front-vowel harmony ("Kemal'e", "Cemal'in", "Hilal'e", "İhtilali", "Resul'e"). */
const INVERSE_FRONT_STEMS = new Set([
  "kemal", "cemal", "hilal", "bilal", "nihal", "zuhal", "hayal", "celal", "delal",
  "istiklal", "ihtilal", "resul", "kabil", "hal", "hâl", "saat", "kalp", "harf",
  "alkol", "rol", "gol", "sembol", "kontrol", "petrol", "protokol", "bandrol", "kabul",
  "usul", "meşgul", "makul", "mahsul", "kefil", "sefil", "nesil", "fasıl", "asıl",
]);

/** Returns true when `stem` is an institution head in context (accounting for TDK exceptions "Avrupa Birliği", "Rusya Federasyonu", "Kutup Dairesi", "Elçilerin İşleri"). */
export function isInstitutionHead(lowerStem: string, prevLower?: string): boolean {
  if (!INSTITUTION_HEADS.has(lowerStem)) return false;
  if (lowerStem === "birliği" && prevLower === "avrupa") return false;
  if (lowerStem === "federasyonu" && prevLower === "rusya") return false;
  if (lowerStem === "dairesi" && prevLower === "kutup") return false;
  if (lowerStem === "işleri" && prevLower === "elçilerin") return false;
  return true;
}

/**
 * Joins `stem + suffix` when removing a wrong apostrophe, applying Turkish final consonant softening
 * (k->ğ, p->b, ç->c, t->d) before a vowel-initial suffix whenever appropriate ("Hristiyanlık'ın" -> "Hristiyanlığın",
 * "Atatürkçülük'ün" -> "Atatürkçülüğün", "kitap'ı" -> "kitabı", "ağaç'a" -> "ağaca").
 */
export function joinWithoutApostrophe(
  stem: string,
  suffix: string,
  isMorphWord: (lower: string) => boolean,
): string {
  if (!stem || !suffix || !/^[aeıioöuü]/.test(lowerTr(suffix))) {
    return stem + suffix;
  }
  const last = lowerTr(stem.slice(-1));
  const softMap: Record<string, string> = { k: "ğ", p: "b", ç: "c", t: "d" };
  const soft = softMap[last];
  if (!soft || stem.length < 4) return stem + suffix;
  const plainJoined = stem + suffix;
  const softJoined = stem.slice(0, -1) + soft + suffix;
  const lowPlain = lowerTr(plainJoined);
  const lowSoft = lowerTr(softJoined);
  // Always soften Turkish -lIk/-lik/-luk/-lük before vowel ("Hristiyanlığın", "Atatürkçülüğün", "Başbakanlığa")
  if (last === "k" && /l[ıiuü]k$/.test(lowerTr(stem))) {
    return softJoined;
  }
  if (isMorphWord(lowSoft) && !isMorphWord(lowPlain)) {
    return softJoined;
  }
  return plainJoined;
}

const NUMBER_UNIT_BLOCK = new Set([
  "cm", "mm", "km", "kg", "mg", "gr", "lt", "ml", "gb", "mb", "kb", "tb", "pb",
  "hz", "khz", "mhz", "ghz", "kw", "mw", "gw", "kwh", "ms", "dk", "sn", "sa",
  "tl", "usd", "eur", "px", "pt", "em", "rem", "vh", "vw", "bit", "fps", "rpm",
  "mp", "db", "mah", "cc", "st", "nd", "rd", "th", "am", "pm", "bc", "ad", "id",
  "d", "k", "g", "x", "m", "s", "h", "v", "w", "a", "b", "c", "e", "f", "l", "n", "p", "r", "t",
]);

/** Returns Turkish pronunciation final properties (last vowel, ends in vowel, voiceless final) for an integer string. */
function turkishNumberPhonology(numStr: string): { lastV: string; vowelFinal: boolean; voiceless: boolean } | null {
  const digits = numStr.replace(/^0+/, "") || "0";
  const last1 = digits.slice(-1);
  if (last1 === "1") return { lastV: "i", vowelFinal: false, voiceless: false }; // bir
  if (last1 === "2") return { lastV: "i", vowelFinal: true, voiceless: false }; // iki
  if (last1 === "3") return { lastV: "ü", vowelFinal: false, voiceless: true }; // üç
  if (last1 === "4") return { lastV: "ö", vowelFinal: false, voiceless: true }; // dört
  if (last1 === "5") return { lastV: "e", vowelFinal: false, voiceless: true }; // beş
  if (last1 === "6") return { lastV: "ı", vowelFinal: true, voiceless: false }; // altı
  if (last1 === "7") return { lastV: "i", vowelFinal: true, voiceless: false }; // yedi
  if (last1 === "8") return { lastV: "i", vowelFinal: false, voiceless: false }; // sekiz
  if (last1 === "9") return { lastV: "u", vowelFinal: false, voiceless: false }; // dokuz
  // Ends in 0
  if (digits === "0") return { lastV: "ı", vowelFinal: false, voiceless: false }; // sıfır
  if (digits.endsWith("000000000")) return { lastV: "a", vowelFinal: false, voiceless: false }; // milyar
  if (digits.endsWith("000000")) return { lastV: "o", vowelFinal: false, voiceless: false }; // milyon
  if (digits.endsWith("000")) return { lastV: "i", vowelFinal: false, voiceless: false }; // bin
  if (digits.endsWith("00")) return { lastV: "ü", vowelFinal: false, voiceless: false }; // yüz
  const tens = digits.slice(-2, -1);
  if (tens === "1") return { lastV: "o", vowelFinal: false, voiceless: false }; // on
  if (tens === "2") return { lastV: "i", vowelFinal: true, voiceless: false }; // yirmi
  if (tens === "3") return { lastV: "u", vowelFinal: false, voiceless: false }; // otuz
  if (tens === "4") return { lastV: "ı", vowelFinal: false, voiceless: true }; // kırk
  if (tens === "5") return { lastV: "i", vowelFinal: true, voiceless: false }; // elli
  if (tens === "6") return { lastV: "ı", vowelFinal: false, voiceless: true }; // altmış
  if (tens === "7") return { lastV: "i", vowelFinal: false, voiceless: true }; // yetmiş
  if (tens === "8") return { lastV: "e", vowelFinal: false, voiceless: false }; // seksen
  if (tens === "9") return { lastV: "a", vowelFinal: false, voiceless: false }; // doksan
  return null;
}

const NUMBER_INFLECTION_RE =
  /^(?:[dt][ae]n?|[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|l[ae]r(?:[dt][ae]n?|[dt][ae]ki|[aeıiuü]|[ıiuü]n)?|n?[ıiuü]n|y?[aeıiuü]|y?l[ae]|(?:[ıiuü]?nc[ıiuü])(?:s[ıiuü](?:n[aeıiuü]|nd[ae]n?)?|l[ae]r)?|[dt][ıiuü]r)$/;

/**
 * Validates and fixes Turkish inflectional/ordinal suffixes attached to a number ("1985te" -> "1985'te",
 * "2023de" -> "2023'te", "1985'de" -> "1985'te", "1990larda" -> "1990'larda", "2nci" -> "2'nci").
 * Returns the fixed suffix (to be placed after `'`) or null if untouched/invalid.
 */
export function fixNumberSuffix(numStr: string, rawSuffix: string, hadApostrophe: boolean): string | null {
  if (!rawSuffix || rawSuffix !== lowerTr(rawSuffix)) return null;
  if (!hadApostrophe && NUMBER_UNIT_BLOCK.has(rawSuffix)) return null;
  // Reject 1-letter glued suffixes on non-4-digit numbers ("3a", "2e", "5i" could be sections/codes)
  if (!hadApostrophe && rawSuffix.length === 1 && !/^(?:1[0-9]{3}|20[0-9]{2})$/.test(numStr)) return null;
  if (!NUMBER_INFLECTION_RE.test(rawSuffix)) return null;
  const ph = turkishNumberPhonology(numStr);
  if (!ph) return null;

  // Check vowel harmony of the first vowel of the suffix against the number's final vowel
  const firstV = [...rawSuffix].find((c) => "aeıioöuü".includes(c));
  if (firstV && !followsHarmony(ph.lastV, firstV)) return null;

  // Check buffer/initial consonant rules
  if (ph.vowelFinal) {
    if (/^[aeıiuü]/.test(rawSuffix)) return null;
    if (/^l[ae](?:$|[^r])/.test(rawSuffix)) return null;
  } else {
    if (/^(?:n(?!c)|y)/.test(rawSuffix)) return null;
    if (/^nc[ıiuü]/.test(rawSuffix)) return null; // consonant-final numbers take -ıncı/-inci/-uncu/-üncü
  }

  // Fix voicing assimilation on d/t-initial case/copula suffixes ("1985de" -> "1985'te", "1985'de" -> "1985'te", "2023de" -> "2023'te")
  let fixed = rawSuffix;
  if (fixed.startsWith("d") && ph.voiceless) {
    fixed = "t" + fixed.slice(1);
  } else if (fixed.startsWith("t") && !ph.voiceless) {
    fixed = "d" + fixed.slice(1);
  }
  if (hadApostrophe && fixed === rawSuffix) return null;
  return fixed;
}

/** Suffix starts with a TDK derivational or plural suffix (never preceded by an apostrophe on non-acronym proper nouns). */
export const NON_APOSTROPHE_SUFFIX_RE =
  /^(?:l[ae]r|l[ıiuü]k|l[ıiuü](?:k|l[ae]r|y?m[ıiuü]ş|y?d[ıiuü]|y?s[ae]|y?k[ae]n|y?[aeıiuü]|n[ıiuü]n|d[ae]n?|d[ae]ki|yl[ae]|d[ıiuü]r|$)|[cç][ae](?:l[ae]r|s[ıiuü]|d[ae]n?|d[ae]ki|n[ıiuü]n|y?[aeıiuü]|yl[ae]|d[ıiuü]r|$)|[cç][ıiuü](?:l[ıiuü]k|l[ae]r|s[ıiuü]|d[ae]n?|d[ae]ki|n[ıiuü]n|y?[aeıiuü]|yl[ae]|d[ıiuü]r|$)|s[ae]l|s[ıiuü]z)/;

/**
 * Valid Turkish inflectional suffixes that attach with an apostrophe to a bare proper noun.
 * Covers case, possessive (+ case; mandatory buffer 'n' after 3sg -sI/-I), -ki (+ plural/case), instrumental, and copula/predicative endings.
 */
export const PROPER_INFLECTIONAL_SUFFIX_RE =
  /^(?:(?:[ıiuü]m(?:[ıiuü]z)?|m[ıiuü]z|[ıiuü]n(?:[ıiuü]z)?|n[ıiuü]z)(?:[dt][ae]n?|[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|[aeıiuü]|[ıiuü]n|l[ae])?|s[ıiuü](?:n[dt][ae]n?|n[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|n[aeıiuü]|n[ıiuü]n|yl[ae])?|[ıiuü](?:n[dt][ae]n?|n[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|n[aeıiuü]|n[ıiuü]n|yl[ae])|[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?|n[aeıiuü]|n[dt][ae]n?|n[ıiuü]n)?|n?[ıiuü]nki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?|n[aeıiuü]|n[dt][ae]n?|n[ıiuü]n)?|n?[ıiuü]n|[dt][ae]n?|y?l[ae](?:yd[ıiuü][mk]?|ym[ıiuü]ş[ıiuü]?[mn]?|ys[ae][mk]?)?|y?[aeıiuü]|[dt][ıiuü]r|yd[ıiuü][mnk]?|ym[ıiuü]ş|ys[ae]|yken|s[ıiuü]n[ıiuü]z|s[ıiuü]n|y[ıiuü]m|y[ıiuü]z)$/;

/**
 * Valid Turkish inflectional suffix attached to a P3sg vowel-final head word (e.g. "Üniversitesi" + "nde",
 * "Bakanlığı" + "na", "Parkı" + "nda", "Camisi" + "nin", "Gazete" + "de", "Savaşı" + "nı").
 */
export const HEAD_SUFFIX_RE =
  /^(?:n[ıiuü]n|nd[ae]n?|nd[ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|n[aeıiuü]|yl[ae]|d[ae]n?|d[ae]ki|y[aeıiuü]|d[ıiuü]r|yd[ıiuü]|ym[ıiuü]ş|ys[ae])$/;

/** Suffixes after a no-apostrophe proper noun (languages, nationalities, religions, derivations, plurals). */
export const NO_APOS_PROPER_SUFFIX_RE =
  /^(?:(?:l[ae]r)?(?:(?:[ıiuü]m(?:[ıiuü]z)?|[ıiuü]n(?:[ıiuü]z)?|s?[ıiuü])(?:n?[dt][ae]n?|n?[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?)?|n?[aeıiuü]|n[ıiuü]n|y?l[ae])?|[dt][ae]ki(?:l[ae]r(?:[aeıiuü]|[dt][ae]n?|[ıiuü]n)?|n[aeıiuü]|n[dt][ae]n?|n[ıiuü]n)?|n?[ıiuü]nki(?:l[ae]r)?|n?[ıiuü]n|[dt][ae]n?|y?l[ae]|y?[aeıiuü]|[dt][ıiuü]r|y?d[ıiuü]|y?m[ıiuü]ş|y?s[ae]|y?ken)?)$/;

const VOWEL_RE = /[aeıioöuüâîû]/;
const VOWEL_FINAL_RE = /[aeıioöuüâîû]$/;

export function isInverseFrontStem(stem: string): boolean {
  if (INVERSE_FRONT_STEMS.has(stem)) return true;
  if (stem.endsWith("al") && INVERSE_FRONT_STEMS.has(stem.slice(-5))) return true;
  return false;
}

/**
 * Checks whether `suffix` phonologically attaches to `stem` (vowel harmony, buffer letters, voicing assimilation).
 * When `acronym` is true, letter-by-letter pronunciation rules apply so harmony is relaxed.
 */
export function isPhonologicallyValidProperSuffix(
  stem: string,
  suffix: string,
  options: { acronym?: boolean; p3sgHead?: boolean } = {},
): boolean {
  if (!suffix) return false;
  if (options.acronym) {
    return PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) || /^l[ae]r/.test(suffix);
  }
  const vowelFinal = VOWEL_FINAL_RE.test(stem);
  // Buffer letter rules
  if (options.p3sgHead && vowelFinal) {
    // P3sg heads ("Parkı", "Camisi", "Üniversitesi", "Bakanlığı", "Savaşı") take pronominal 'n' before case/genitive, 'y' before -la/-le.
    if (!/^(?:n[ıiuü]n|nd[ae]n?|nd[ae]ki|n[aeıiuü]|yl[ae]|d[ıiuü]r|yd[ıiuü]|ym[ıiuü]ş|ys[ae])/.test(suffix)) {
      return false;
    }
  } else {
    if (vowelFinal) {
      // Vowel-final bare stem: cannot take bare vowel-initial case (-a/-e/-ı/-i/-u/-ü/-ın/-in) except rare foreign silent-e
      if (/^[aeıiuü]/.test(suffix) && !stem.endsWith("e")) return false;
      // Cannot take bare -la/-le without buffer -y-? Wait: Turkish allows BOTH "Ayşe'yle" AND "Ayşe'le" rarely,
      // standard TDK is "Ayşe'yle" / "Ankara'yla", while "Bolu'dan", "Rize'nin", "Özge'yi", "Türkiye'mizin".
      if (/^l[ae](?:$|y)/.test(suffix)) return false;
      // Cannot take consonant-initial 1pl -ımız directly on vowel ("Türkiye'miz", not "Türkiye'imiz")
      if (/^[ıiuü]m/.test(suffix)) return false;
      // Cannot take voicing-assimilated t- after a vowel!
      if (suffix.startsWith("t")) return false;
    } else {
      // Consonant-final stem: cannot take buffer n- (genitive -nın, -nda, -na) or buffer y- (-ya, -yı, -yla) or -s- (-sı, -sini) or bare -mız/-miz
      if (/^(?:n|y|s[ıiuü]|m[ıiuü]z)/.test(suffix)) return false;
      // Voicing assimilation for d-/t- initial suffixes
      if (suffix.startsWith("d") && isVoicelessFinal(stem)) return false;
      if (suffix.startsWith("t") && !isVoicelessFinal(stem)) return false;
    }
  }

  // Vowel harmony check for the first vowel of the suffix
  const firstV = [...suffix].find((ch) => "aeıioöuü".includes(ch));
  if (firstV) {
    if (isInverseFrontStem(stem)) {
      // Inverse front harmony: e/i/ü allowed
      const lv = lastVowel(stem);
      const round = lv === "o" || lv === "u" || lv === "ö" || lv === "ü";
      if (firstV === "a" || firstV === "e") {
        if (firstV !== "e") return false;
      } else {
        const want = round ? "ü" : "i";
        if (firstV !== want && !followsHarmony(stem, firstV)) return false;
      }
    } else if (!followsHarmony(stem, firstV)) {
      // Allow silent-e foreign names ("Google'ın") only when stem ends in 'e' and isn't Turkish
      return false;
    }
  }

  // Internal vowel harmony inside the suffix (ignoring invariant -ki and -ken)
  let check = suffix;
  const kiIdx = check.indexOf("ki");
  if (kiIdx !== -1) check = check.slice(0, kiIdx);
  if (check.endsWith("ken")) check = check.slice(0, -3);
  let prev = isInverseFrontStem(stem) ? "e" : (lastVowel(stem) ?? "e");
  for (let i = 0; i < check.length; i++) {
    const ch = check[i]!;
    if ("aeıioöuü".includes(ch)) {
      if (i > 0 && !followsHarmony(prev, ch)) return false;
      prev = ch;
    }
  }
  return true;
}

/**
 * Restores ASCII-stripped Turkish vowels inside a suffix to harmonize with `stem` ("burak" + "in" -> "ın",
 * "kibris" + "ta" -> "ta", "oya" + "nin" -> "nın", "turkiye" + "mizin" -> "mizin").
 * Returns the harmonized suffix if valid, or null if the suffix cannot harmonize with `stem`.
 */
export function harmonizeAsciiSuffix(
  stem: string,
  rawSuffix: string,
  options: { p3sgHead?: boolean } = {},
): string | null {
  if (!rawSuffix) return null;
  const suffixRe = options.p3sgHead ? HEAD_SUFFIX_RE : PROPER_INFLECTIONAL_SUFFIX_RE;
  if (suffixRe.test(rawSuffix) && isPhonologicallyValidProperSuffix(stem, rawSuffix, options)) return rawSuffix;
  // Only toggle ASCII i->ı, u->ü, c->ç, s->ş when rawSuffix lacks Turkish marks (e.g. "in" -> "ın", "nin" -> "nın", "mis" -> "mış").
  const keepKi = rawSuffix.indexOf("ki");
  const head = keepKi !== -1 ? rawSuffix.slice(0, keepKi) : rawSuffix;
  const tail = keepKi !== -1 ? rawSuffix.slice(keepKi) : "";

  const lv = isInverseFrontStem(stem) ? "e" : lastVowel(stem);
  if (!lv) return null;
  const isBack = "aıouâû".includes(lv);
  let prevBack = isBack;
  let prevRound = "ouöüû".includes(lv);
  let out = "";
  for (let i = 0; i < head.length; i++) {
    let ch = head[i]!;
    if (ch === "i" && prevBack) {
      ch = prevRound ? "u" : "ı";
    } else if (ch === "u" && !prevBack) {
      ch = "ü";
    } else if (ch === "s" && i === head.length - 1 && i >= 2 && (out.endsWith("mı") || out.endsWith("mi") || out.endsWith("mu") || out.endsWith("mü"))) {
      ch = "ş";
    }
    out += ch;
    if ("aeıioöuü".includes(ch)) {
      prevBack = "aıou".includes(ch);
      prevRound = "ouöü".includes(ch);
    }
  }
  const cand = out + tail;
  if (cand !== rawSuffix && PROPER_INFLECTIONAL_SUFFIX_RE.test(cand) && isPhonologicallyValidProperSuffix(stem, cand, options)) {
    return cand;
  }
  return null;
}

/** Checks if `word` is an inflected kinship word ("ablama", "halamın", "enişteme", "ninemin", "teyzem", "amcam"). */
export function isKinshipWord(lower: string): boolean {
  for (const k of KINSHIP_STEMS) {
    if (lower === k) return true;
    if (lower.startsWith(k) && lower.length > k.length && lower.length <= k.length + 7) {
      const rest = lower.slice(k.length);
      if (/^(?:m(?:[aeıiuü]|d[ae]n?|[ıiuü]n|l[ae]|l[ae]r(?:[aeıiuü]|[ıiuü]n|d[ae]n?)?)?|n(?:[aeıiuü]|d[ae]n?|[ıiuü]n)?|s?[ıiuü](?:n[aeıiuü]|nd[ae]n?|n[ıiuü]n|yl[ae])?|y?[aeıiuü]|d[ae]n?|y?l[ae]|l[ae]r)?$/.test(rest)) {
        return true;
      }
    }
  }
  return false;
}

/** Checks if `word` is an inflected media/work type word ("dergisine", "filmini", "dizisini", "romanını", "kitabını", "gazetesinde"). */
export function isMediaTypeWord(lower: string): boolean {
  for (const m of MEDIA_TYPE_STEMS) {
    const softened = m.endsWith("p") ? m.slice(0, -1) + "b" : m;
    if (lower === m) return true;
    for (const base of m === softened ? [m] : [m, softened]) {
      if (lower.startsWith(base) && lower.length > base.length && lower.length <= base.length + 7) {
        const rest = lower.slice(base.length);
        if (/^(?:s?[ıiuü](?:n[aeıiuü]|nd[ae]n?|n[ıiuü]n|yl[ae])?|l[ae]r(?:[ıiuü]n?[aeıiuü]?|d[ae]n?)?|[dt][ae]n?|y?[aeıiuü]|n?[ıiuü]n|y?l[ae])$/.test(rest)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Capitalizes the first character of a Turkish word using Turkish casing (`i` -> `İ`, `ı` -> `I`). */
export function capTr(word: string): string {
  return word ? upperTr(word[0]!) + word.slice(1) : word;
}

/** Lowercases a word preserving ASCII/Turkish letters, and strips accents for ASCII fallback lookups. */
const ASCII_FOLD: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
export function foldTurkish(word: string): string {
  return lowerTr(word).replace(/[çğıöşüâîû]/g, (ch) => ASCII_FOLD[ch] ?? ch);
}

/** True when a word looks like a bare or suffixed honorific ("bey", "beye", "beyi", "beyin", "beyde", "hanım", "hanımı", "hanımın", "hanımda", "efendiye", "paşanın", "ağa'nın"). */
export function splitHonorific(lower: string): { head: string; displayHead: string; suffix: string; hadApostrophe: boolean } | null {
  const apos = lower.indexOf("'");
  if (apos > 0) {
    const stem = lower.slice(0, apos);
    const suffix = lower.slice(apos + 1);
    if (
      POST_HONORIFICS.has(stem) &&
      PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) &&
      !/^(?:[ıiuü]m|m[ıiuü]z|l[ae]r|s[ıiuü])/.test(suffix) &&
      isPhonologicallyValidProperSuffix(stem, suffix)
    ) {
      return { head: stem, displayHead: capTr(stem), suffix, hadApostrophe: true };
    }
    return null;
  }
  for (const h of POST_HONORIFICS) {
    if (lower === h) return { head: h, displayHead: capTr(h), suffix: "", hadApostrophe: false };
    if (lower.startsWith(h) && lower.length > h.length) {
      const suffix = lower.slice(h.length);
      // Exclude 1sg/1pl/3sg-s possessive & plural forms ("efendimiz", "efendisi", "paşası", "beyim", "beyler")
      // while ALLOWING accusative "-ı/-i/-yı/-yi" after a person name ("Ayşe Hanım'ı", "Kerem Bey'i", "Paşa'yı").
      if (
        PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) &&
        !/^(?:[ıiuü]m|m[ıiuü]z|l[ae]r|s[ıiuü])/.test(suffix) &&
        isPhonologicallyValidProperSuffix(h, suffix)
      ) {
        return { head: h, displayHead: capTr(h), suffix, hadApostrophe: false };
      }
    }
  }
  return null;
}

/** Splits a post-nominal title (`POST_TITLES_WITH_APOS`: "hoca", "usta", "çavuş", "onbaşı", "kaptan", "öğretmen", ...) + optional inflectional suffix. */
export function splitPostTitle(lower: string): { head: string; displayHead: string; suffix: string; hadApostrophe: boolean } | null {
  const apos = lower.indexOf("'");
  if (apos > 0) {
    const stem = lower.slice(0, apos);
    const suffix = lower.slice(apos + 1);
    if (
      POST_TITLES_WITH_APOS.has(stem) &&
      PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) &&
      !/^(?:[ıiuü]m|m[ıiuü]z|l[ae]r|s[ıiuü])/.test(suffix) &&
      isPhonologicallyValidProperSuffix(stem, suffix)
    ) {
      return { head: stem, displayHead: capTr(stem), suffix, hadApostrophe: true };
    }
    return null;
  }
  for (const h of POST_TITLES_WITH_APOS) {
    if (lower === h) return { head: h, displayHead: capTr(h), suffix: "", hadApostrophe: false };
    if (lower.startsWith(h) && lower.length > h.length) {
      const suffix = lower.slice(h.length);
      if (
        PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) &&
        !/^(?:[ıiuü]m|m[ıiuü]z|l[ae]r|s[ıiuü])/.test(suffix) &&
        isPhonologicallyValidProperSuffix(h, suffix)
      ) {
        return { head: h, displayHead: capTr(h), suffix, hadApostrophe: false };
      }
    }
  }
  return null;
}

/** Splits an institution/geo/state/event head word + optional inflectional suffix ("üniversitesinde" -> head="üniversitesi", suffix="nde"). */
export function splitHeadWord(
  lower: string,
  headSet: ReadonlySet<string>,
): { head: string; suffix: string; hadApostrophe: boolean } | null {
  const apos = lower.indexOf("'");
  if (apos > 0) {
    const stem = lower.slice(0, apos);
    const suffix = lower.slice(apos + 1);
    if (headSet.has(stem) && (HEAD_SUFFIX_RE.test(suffix) || PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix))) {
      return { head: stem, suffix, hadApostrophe: true };
    }
    return null;
  }
  if (headSet.has(lower)) return { head: lower, suffix: "", hadApostrophe: false };
  for (let cut = lower.length - 1; cut >= 3; cut--) {
    const stem = lower.slice(0, cut);
    if (!headSet.has(stem)) continue;
    const suffix = lower.slice(cut);
    const vowelFinal = VOWEL_FINAL_RE.test(stem);
    const ok = vowelFinal
      ? HEAD_SUFFIX_RE.test(suffix) && isPhonologicallyValidProperSuffix(stem, suffix, { p3sgHead: true })
      : PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) && isPhonologicallyValidProperSuffix(stem, suffix);
    if (ok) return { head: stem, suffix, hadApostrophe: false };
  }
  return null;
}

/** Splits a month or weekday name + optional inflectional suffix ("aralıka" -> "aralık" + "a", "pazartesinin" -> "pazartesi" + "nin"). */
export function splitCalendarWord(
  lower: string,
  set: ReadonlySet<string>,
): { stem: string; suffix: string; hadApostrophe: boolean } | null {
  const apos = lower.indexOf("'");
  if (apos > 0) {
    const stem = lower.slice(0, apos);
    const suffix = lower.slice(apos + 1);
    if (set.has(stem) && PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix)) {
      return { stem, suffix, hadApostrophe: true };
    }
    return null;
  }
  if (set.has(lower)) return { stem: lower, suffix: "", hadApostrophe: false };
  for (const stem of set) {
    if (!lower.startsWith(stem) || lower.length <= stem.length) continue;
    const suffix = lower.slice(stem.length);
    if (PROPER_INFLECTIONAL_SUFFIX_RE.test(suffix) && isPhonologicallyValidProperSuffix(stem, suffix)) {
      return { stem, suffix, hadApostrophe: false };
    }
  }
  return null;
}

/** Returns true when `word` is an internal lowercase conjunction inside a multi-word proper name ("ve", "ile", "ya", "veya", "de", "da"). */
export const TITLE_CONJUNCTIONS = new Set(["ve", "ile", "ya", "veya", "yahut", "da", "de", "ki", "mi", "mı", "mu", "mü"]);

/** Optional contextual gate for multi-word canonical phrases that overlap with ordinary Turkish phrases. */
export type PhraseContext = "era" | "day" | "work";

/** Canonical multi-word Turkish holidays, special days, historical events/eras, and landmark/work phrases. */
export const CANONICAL_PHRASES: ReadonlyArray<readonly [display: string, apos: boolean, context?: PhraseContext]> = [
  // Holidays & special days (WITH apostrophe on suffixes)
  ["Cumhuriyet Bayramı", true],
  ["Zafer Bayramı", true],
  ["Ramazan Bayramı", true],
  ["Kurban Bayramı", true],
  ["Şeker Bayramı", true],
  ["Gençlik ve Spor Bayramı", true],
  ["Ulusal Egemenlik ve Çocuk Bayramı", true],
  ["Atatürk'ü Anma, Gençlik ve Spor Bayramı", true],
  ["Atatürk'ü Anma Gençlik ve Spor Bayramı", true],
  ["Demokrasi ve Millî Birlik Günü", true],
  ["Emek ve Dayanışma Günü", true],
  ["İşçi Bayramı", true],
  ["Kabotaj Bayramı", true],
  ["Denizcilik ve Kabotaj Bayramı", true],
  ["Öğretmenler Günü", true, "day"],
  ["Anneler Günü", true, "day"],
  ["Babalar Günü", true, "day"],
  ["Gaziler Günü", true],
  ["Şehitler Günü", true],
  ["Kadınlar Günü", true, "day"],
  ["Dünya Kadınlar Günü", true],
  ["Dünya Tiyatro Günü", true],
  ["Dünya Çevre Günü", true],
  ["Dünya Sağlık Günü", true],
  ["Dünya Barış Günü", true],
  ["Dünya Çocuk Günü", true],
  ["Dünya Kitap Günü", true],
  ["Dünya Su Günü", true],
  ["İnsan Hakları Günü", true],
  ["Sevgililer Günü", true, "day"],
  ["Şükran Günü", true],
  ["Cadılar Bayramı", true],
  ["Aşure Günü", true],
  ["Tıp Bayramı", true],
  ["Nevruz Bayramı", true],
  ["Kadir Gecesi", true],
  ["Miraç Kandili", true],
  ["Regaip Kandili", true],
  ["Berat Kandili", true],
  ["Mevlit Kandili", true],
  // Historical events, wars, revolutions, eras, treaties (WITH apostrophe)
  ["Kurtuluş Savaşı", true],
  ["Millî Mücadele", true],
  ["Millî Mücadele Dönemi", true],
  ["Cumhuriyet Dönemi", true],
  ["Büyük Taarruz", true],
  ["Birinci Dünya Savaşı", true],
  ["İkinci Dünya Savaşı", true],
  ["I. Dünya Savaşı", true],
  ["II. Dünya Savaşı", true],
  ["Birinci İnönü Savaşı", true],
  ["İkinci İnönü Savaşı", true],
  ["I. İnönü Savaşı", true],
  ["II. İnönü Savaşı", true],
  ["Başkomutanlık Meydan Muharebesi", true],
  ["Dumlupınar Meydan Muharebesi", true],
  ["Çanakkale Savaşı", true],
  ["Çanakkale Zaferi", true],
  ["Kore Savaşı", true],
  ["Kırım Savaşı", true],
  ["Mohaç Savaşı", true],
  ["Malazgirt Savaşı", true],
  ["Malazgirt Meydan Muharebesi", true],
  ["Sakarya Meydan Muharebesi", true],
  ["Preveze Deniz Savaşı", true],
  ["İnebahtı Deniz Savaşı", true],
  ["Balkan Savaşları", true],
  ["Trablusgarp Savaşı", true],
  ["Soğuk Savaş", true],
  ["Yüz Yıl Savaşları", true],
  ["Otuz Yıl Savaşları", true],
  ["Yedi Yıl Savaşları", true],
  ["Haçlı Seferleri", true],
  ["Sanayi Devrimi", true],
  ["Fransız İhtilali", true],
  ["Fransız Devrimi", true],
  ["Ekim Devrimi", true],
  ["Harf İnkılabı", true],
  ["Harf Devrimi", true],
  ["Kavimler Göçü", true],
  ["Fetret Devri", true],
  ["Lale Devri", true],
  ["Tanzimat Dönemi", true],
  ["Tanzimat Fermanı", true],
  ["Islahat Fermanı", true],
  ["Meşrutiyet Dönemi", true],
  ["Birinci Meşrutiyet", true],
  ["İkinci Meşrutiyet", true],
  ["Eski Çağ", true, "era"],
  ["İlk Çağ", true, "era"],
  ["Orta Çağ", true],
  ["Yeni Çağ", true, "era"],
  ["Yakın Çağ", true, "era"],
  ["Aydınlanma Çağı", true],
  ["Taş Devri", true],
  ["Cilalı Taş Devri", true],
  ["Yontma Taş Devri", true],
  ["Bakır Çağı", true],
  ["Tunç Çağı", true],
  ["Demir Çağı", true],
  ["Maden Çağı", true],
  ["Lozan Antlaşması", true],
  ["Lozan Barış Antlaşması", true],
  ["Mondros Ateşkes Antlaşması", true],
  ["Sevr Antlaşması", true],
  ["Mudanya Ateşkes Antlaşması", true],
  ["Karlofça Antlaşması", true],
  ["Küçük Kaynarca Antlaşması", true],
  ["Montrö Boğazlar Sözleşmesi", true],
  ["Amasya Genelgesi", true],
  ["Erzurum Kongresi", true],
  ["Sivas Kongresi", true],
  ["Büyük Buhran", true],
  ["Coğrafi Keşifler", true],
  // Established directional regions & territories (WITH apostrophe)
  ["Batı Anadolu", true],
  ["Doğu Anadolu", true],
  ["İç Anadolu", true],
  ["Güneydoğu Anadolu", true],
  ["Doğu Karadeniz", true],
  ["Batı Karadeniz", true],
  ["Batı Trakya", true],
  ["Doğu Trakya", true],
  ["Kuzey Kıbrıs", true],
  ["Güney Kıbrıs", true],
  ["Orta Doğu", true],
  ["Kuzey İrlanda", true],
  ["Batı Şeria", true],
  ["Batı Sahra", true],
  // Geographic, monument & landmark phrases (WITH apostrophe)
  ["Kaz Dağları", true],
  ["Toros Dağları", true],
  ["Kaçkar Dağları", true],
  ["Ağrı Dağı", true],
  ["Erciyes Dağı", true],
  ["Nemrut Dağı", true],
  ["Tuz Gölü", true],
  ["Van Gölü", true],
  ["Beyşehir Gölü", true],
  ["Eğirdir Gölü", true],
  ["İznik Gölü", true],
  ["Sapanca Gölü", true],
  ["Abant Gölü", true],
  ["Salda Gölü", true],
  ["Manyas Gölü", true],
  ["Atlas Okyanusu", true],
  ["Büyük Okyanus", true],
  ["Hint Okyanusu", true],
  ["Kızıl Deniz", true],
  ["Ölü Deniz", true],
  ["Marmara Bölgesi", true],
  ["Ege Bölgesi", true],
  ["Akdeniz Bölgesi", true],
  ["Karadeniz Bölgesi", true],
  ["İç Anadolu Bölgesi", true],
  ["Doğu Anadolu Bölgesi", true],
  ["Güneydoğu Anadolu Bölgesi", true],
  ["Göller Bölgesi", true],
  ["Topkapı Sarayı", true],
  ["Dolmabahçe Sarayı", true],
  ["Çırağan Sarayı", true],
  ["Beylerbeyi Sarayı", true],
  ["İshak Paşa Sarayı", true],
  ["Çankaya Köşkü", true],
  ["Rumeli Hisarı", true],
  ["Anadolu Hisarı", true],
  ["Galata Kulesi", true],
  ["Kız Kulesi", true],
  ["Boğaziçi Köprüsü", true],
  ["Fatih Sultan Mehmet Köprüsü", true],
  ["Yavuz Sultan Selim Köprüsü", true],
  ["Osmangazi Köprüsü", true],
  ["Mısır Çarşısı", true],
  ["Sümela Manastırı", true],
  ["Haydarpaşa Garı", true],
  ["Sirkeci Garı", true],
  ["Ankara Garı", true],
  ["Sabiha Gökçen Havalimanı", true],
  ["İstanbul Havalimanı", true],
  ["Esenboğa Havalimanı", true],
  ["Atatürk Havalimanı", true],
  ["Kıbrıs Şehitleri Caddesi", true],
  ["Gazi Mustafa Kemal Bulvarı", true],
  ["İstiklal Caddesi", true],
  ["Bağdat Caddesi", true],
  ["Taksim Meydanı", true],
  ["Kızılay Meydanı", true],
  ["Maçka Parkı", true],
  ["Gülhane Parkı", true],
  ["Yıldız Parkı", true],
  ["Gençlik Parkı", true],
  ["Kocatepe Camisi", true],
  ["Sultanahmet Camisi", true],
  ["Süleymaniye Camisi", true],
  ["Selimiye Camisi", true],
  ["Dara Antik Kenti", true],
  ["Efes Antik Kenti", true],
  ["Rio de Janeiro", true],
  ["Avrupa Birliği", true],
  ["Resmî Gazete", true],
  // Iconic literary works & films (WITH apostrophe; everyday-word titles require literary/media context!)
  ["Sinekli Bakkal", true, "work"],
  ["İnce Memed", true, "work"],
  ["Benim Adım Kırmızı", true, "work"],
  ["Küçük Prens", true, "work"],
  ["Selvi Boylum Al Yazmalım", true, "work"],
  ["Beyaz Kale", true, "work"],
  ["Kürk Mantolu Madonna", true, "work"],
  ["Saatleri Ayarlama Enstitüsü", true, "work"],
  ["Hanımın Çiftliği", true, "work"],
  ["Kurtlar Vadisi", true, "work"],
  ["Ölü Ozanlar Derneği", true, "work"],
  ["Aşk-ı Memnu", true],
  ["Suç ve Ceza", true, "work"],
  ["Savaş ve Barış", true, "work"],
  ["Karamazov Kardeşler", true],
  ["Kuyucaklı Yusuf", true],
  ["Mai ve Siyah", true, "work"],
  ["Araba Sevdası", true, "work"],
  ["Dokuzuncu Hariciye Koğuşu", true],
  ["Kara Kitap", true, "work"],
  ["Masumiyet Müzesi", true, "work"],
  ["Aylak Adam", true, "work"],
  ["Anayurt Oteli", true, "work"],
  ["Puslu Kıtalar Atlası", true, "work"],
  ["Kırmızı Saçlı Kadın", true, "work"],
  ["Leyla ile Mecnun", true, "work"],
  ["Hababam Sınıfı", true],
  ["Muhsin Bey", true],
  ["Devlet Ana", true, "work"],
  ["Yılanların Öcü", true, "work"],
  ["Üç İstanbul", true],
  ["Ağrı Dağı Efsanesi", true],
  ["Yaprak Dökümü", true, "work"],
  ["Yeşil Gece", true, "work"],
  ["Kiralık Konak", true, "work"],
  ["Sodom ve Gomore", true],
  ["Ateşten Gömlek", true, "work"],
  ["Vurun Kahpeye", true, "work"],
  ["Handan", true, "work"],
  ["Acımak", true, "work"],
  ["Dudaktan Kalbe", true, "work"],
  ["Fatih-Harbiye", true],
  ["Matmazel Noraliya'nın Koltuğu", true],
  ["Ayaşlı ve Kiracıları", true],
  ["Aganta Burina Burinata", true],
  ["İçimizdeki Şeytan", true, "work"],
  ["Esir Şehrin İnsanları", true, "work"],
  ["Yorgun Savaşçı", true, "work"],
  ["Hakkâri'de Bir Mevsim", true],
  ["Fikrimin İnce Gülü", true, "work"],
  ["Bir Düğün Gecesi", true, "work"],
  ["Korkuyu Beklerken", true, "work"],
  ["Lüzumsuz Adam", true, "work"],
  ["Sırça Köşk", true, "work"],
  ["Dede Korkut Hikâyeleri", true],
  ["Kutadgu Bilig", true],
  ["İstiklal Marşı", true],
  ["Keşanlı Ali Destanı", true],
  ["Susuz Yaz", true, "work"],
  ["Kış Uykusu", true, "work"],
  ["Bir Zamanlar Anadolu'da", true],
  ["Ahlat Ağacı", true, "work"],
  ["Babam ve Oğlum", true, "work"],
  ["Tosun Paşa", true],
  ["Süt Kardeşler", true, "work"],
  ["Kapıcılar Kralı", true, "work"],
  ["Çöpçüler Kralı", true, "work"],
  ["Neşeli Günler", true, "work"],
  ["Mona Lisa", true],
  ["Kaplumbağa Terbiyecisi", true, "work"],
  ["Yıldızlı Gece", true, "work"],
  ["Son Akşam Yemeği", true, "work"],
  ["Felatun Bey ile Rakım Efendi", true],
  ["Taaşşuk-ı Talat ve Fitnat", true],
  ["Kuyruklu Yıldız Altında Bir İzdivaç", true],
  ["Vatan yahut Silistre", true],
  ["Bereketli Topraklar Üzerinde", true, "work"],
  ["Orta Direk", true, "work"],
  ["Yer Demir Gök Bakır", true, "work"],
  ["Ölmez Otu", true, "work"],
  ["Yılanı Öldürseler", true, "work"],
  ["Tehlikeli Oyunlar", true, "work"],
  ["Sevgili Arsız Ölüm", true, "work"],
  ["Cevdet Bey ve Oğulları", true],
  ["Sessiz Ev", true, "work"],
  ["Yeni Hayat", true, "work"],
  ["Kafamda Bir Tuhaflık", true, "work"],
  ["Veba Geceleri", true, "work"],
  ["Memleket Hikâyeleri", true, "work"],
  ["Gurbet Hikâyeleri", true, "work"],
  ["Son Kuşlar", true, "work"],
  ["Memleketimden İnsan Manzaraları", true, "work"],
  ["Bülbülü Öldürmek", true, "work"],
  ["Hayvan Çiftliği", true, "work"],
  ["Yüzüklerin Efendisi", true],
  ["Küçük Kadınlar", true, "work"],
  ["Don Kişot", true],
  ["İlahi Komedya", true],
  ["Genç Werther'in Acıları", true],
  ["Romeo ve Juliet", true],
  ["Venedik Taciri", true],
  ["Kral Lear", true],
  ["Bir Yaz Gecesi Rüyası", true, "work"],
  ["Yeraltından Notlar", true, "work"],
  ["İnsan Ne ile Yaşar", true, "work"],
  ["Vişne Bahçesi", true, "work"],
  ["Üç Kız Kardeş", true, "work"],
  ["Notre Dame'ın Kamburu", true],
  ["Üç Silahşorlar", true],
  ["Goriot Baba", true],
  ["Parma Manastırı", true],
  ["Madame Bovary", true],
  ["Aşk ve Gurur", true, "work"],
  ["Jane Eyre", true],
  ["Oliver Twist", true],
  ["David Copperfield", true],
  ["Moby Dick", true],
  ["Yaşlı Adam ve Deniz", true, "work"],
  ["Çanlar Kimin İçin Çalıyor", true, "work"],
  ["Muhteşem Gatsby", true],
  ["Çavdar Tarlasında Çocuklar", true, "work"],
  ["Vahşetin Çağrısı", true, "work"],
  ["Kırmızı Pazartesi", true, "work"],
  ["Bilinmeyen Bir Kadının Mektubu", true, "work"],
  ["Gılgamış Destanı", true],
  ["Gazap Üzümleri", true, "work"],
  ["Fareler ve İnsanlar", true, "work"],
  ["Şeker Portakalı", true, "work"],
  ["Gurur ve Önyargı", true, "work"],
  ["Uğultulu Tepeler", true, "work"],
  ["Monte Kristo Kontu", true],
  ["Vadideki Zambak", true, "work"],
  ["Kırmızı ve Siyah", true, "work"],
  ["İki Şehrin Hikâyesi", true, "work"],
  ["Beyaz Diş", true, "work"],
  ["Anna Karenina", true],
  ["Babalar ve Oğullar", true, "work"],
  ["Ölü Canlar", true, "work"],
  ["Büyük Umutlar", true, "work"],
  ["Cesur Yeni Dünya", true, "work"],
  ["Yüzyıllık Yalnızlık", true, "work"],
  // Iconic multi-word institutions (NO apostrophe!)
  ["Türk Dil Kurumu", false],
  ["Türk Tarih Kurumu", false],
  ["Türkiye Büyük Millet Meclisi", false],
  ["Türkiye Cumhuriyet Merkez Bankası", false],
  ["Türkiye Petrolleri Anonim Ortaklığı", false],
  ["Türkiye İstatistik Kurumu", false],
  ["Türkiye Bilimsel ve Teknolojik Araştırma Kurumu", false],
  ["Türkiye Radyo Televizyon Kurumu", false],
  ["Türk Standardları Enstitüsü", false],
  ["Türk Hava Yolları", false],
  ["Türk Silahlı Kuvvetleri", false],
  ["Genelkurmay Başkanlığı", false],
  ["Türk Kızılayı", false],
  ["Yeşilay Cemiyeti", false],
  ["Anadolu Ajansı", false],
  ["Ziraat Bankası", false],
  ["Halk Bankası", false],
  ["Vakıf Bank", false],
  ["Türkiye İş Bankası", false],
  ["İş Bankası", false],
  ["Garanti Bankası", false],
  ["Yapı Kredi Bankası", false],
  ["Bakanlar Kurulu", false],
  ["Yüksek Seçim Kurulu", false],
  ["Millî Güvenlik Kurulu", false],
  ["Hakimler ve Savcılar Kurulu", false],
  ["Anayasa Mahkemesi", false],
  ["Atatürk Orman Çiftliği", false],
  ["Atatürk Kültür Merkezi", false],
  ["Devlet Tiyatroları", false],
  ["Devlet Opera ve Balesi", false],
  ["Devlet Malzeme Ofisi", false],
  ["Devlet Hava Meydanları İşletmesi", false],
  ["Kredi ve Yurtlar Kurumu", false],
  ["Türkiye İş Kurumu", false],
  ["Toplu Konut İdaresi", false],
  ["Gelir İdaresi Başkanlığı", false],
  ["Tapu ve Kadastro Genel Müdürlüğü", false],
  ["Vakıflar Genel Müdürlüğü", false],
  ["Türkiye Futbol Federasyonu", false],
  ["Türkiye Basketbol Federasyonu", false],
  ["Türkiye Voleybol Federasyonu", false],
  ["Türk Tabipleri Birliği", false],
  ["Türkiye Barolar Birliği", false],
  ["İstanbul Ticaret Odası", false],
  ["Ankara Ticaret Odası", false],
  ["İstanbul Sanayi Odası", false],
  ["Kişisel Verileri Koruma Kurumu", false],
  ["Bilgi Teknolojileri ve İletişim Kurumu", false],
  ["Enerji Piyasası Düzenleme Kurumu", false],
  ["Cumhuriyet Halk Partisi", false],
  ["Adalet ve Kalkınma Partisi", false],
  ["Milliyetçi Hareket Partisi", false],
  ["Millî Kütüphane", false],
  ["Beyazıt Devlet Kütüphanesi", false],
  ["Anadolu Medeniyetleri Müzesi", false],
  ["İstanbul Arkeoloji Müzeleri", false],
  ["Topkapı Sarayı Müzesi", false],
  ["Pera Müzesi", false],
  ["Rahmi Koç Müzesi", false],
  ["Mevlana Müzesi", false],
  ["Zeugma Mozaik Müzesi", false],
  ["Mavi Köşe Bakkaliyesi", false],
  ["Karadeniz Teknik Üniversitesi", false],
  ["Çukurova Üniversitesi", false],
  ["Akdeniz Üniversitesi", false],
  ["Anadolu Üniversitesi", false],
  ["Atatürk Üniversitesi", false],
  ["Selçuk Üniversitesi", false],
  ["Erciyes Üniversitesi", false],
  ["Ondokuz Mayıs Üniversitesi", false],
  ["Çanakkale Onsekiz Mart Üniversitesi", false],
  ["Süleyman Demirel Üniversitesi", false],
  ["Mersin Üniversitesi", false],
  ["Kocaeli Üniversitesi", false],
  ["Sakarya Üniversitesi", false],
  ["Trakya Üniversitesi", false],
  ["Pamukkale Üniversitesi", false],
  ["Fırat Üniversitesi", false],
  ["İnönü Üniversitesi", false],
  ["Dicle Üniversitesi", false],
  ["Gaziantep Üniversitesi", false],
  ["Bilkent Üniversitesi", false],
  ["Koç Üniversitesi", false],
  ["Sabancı Üniversitesi", false],
  ["Özyeğin Üniversitesi", false],
  ["Bahçeşehir Üniversitesi", false],
  ["Bilgi Üniversitesi", false],
  ["Yeditepe Üniversitesi", false],
  ["Başkent Üniversitesi", false],
  ["Galatasaray Üniversitesi", false],
  ["Kadir Has Üniversitesi", false],
  ["Mimar Sinan Güzel Sanatlar Üniversitesi", false],
  ["Gebze Teknik Üniversitesi", false],
  ["İzmir Yüksek Teknoloji Enstitüsü", false],
  ["İzmir Ekonomi Üniversitesi", false],
  ["Robert Kolej", false],
  ["Ankara Fen Lisesi", false],
  ["İzmir Fen Lisesi", false],
  ["İstanbul Atatürk Fen Lisesi", false],
  ["Kadıköy Anadolu Lisesi", false],
  ["Bornova Anadolu Lisesi", false],
  ["Cağaloğlu Anadolu Lisesi", false],
  ["Vefa Lisesi", false],
  ["Pertevniyal Lisesi", false],
  ["Haydarpaşa Lisesi", false],
  ["Darüşşafaka Lisesi", false],
  ["Darüşşafaka Cemiyeti", false],
  ["Dünya Sağlık Örgütü", false],
  ["Dünya Bankası", false],
  ["Dünya Ticaret Örgütü", false],
  ["Uluslararası Para Fonu", false],
  ["Uluslararası Af Örgütü", false],
  ["Avrupa Konseyi", false],
  ["Avrupa Parlamentosu", false],
  ["Avrupa İnsan Hakları Mahkemesi", false],
  ["Birleşmiş Milletler Güvenlik Konseyi", false],
  ["Sosyal Güvenlik Kurumu", false],
  ["Yükseköğretim Kurulu", false],
  ["Radyo ve Televizyon Üst Kurulu", false],
  ["Bankacılık Düzenleme ve Denetleme Kurumu", false],
  ["Sermaye Piyasası Kurulu", false],
  ["Rekabet Kurumu", false],
  ["Devlet Su İşleri", false],
  ["Meteoroloji Genel Müdürlüğü", false],
  ["Emniyet Genel Müdürlüğü", false],
  ["Orman Genel Müdürlüğü", false],
  ["Karayolları Genel Müdürlüğü", false],
  ["Devlet Demir Yolları", false],
  ["Diyanet İşleri Başkanlığı", false],
  ["Millî Eğitim Bakanlığı", false],
  ["İçişleri Bakanlığı", false],
  ["Dışişleri Bakanlığı", false],
  ["Sağlık Bakanlığı", false],
  ["Adalet Bakanlığı", false],
  ["Hazine ve Maliye Bakanlığı", false],
  ["Maliye Bakanlığı", false],
  ["Millî Savunma Bakanlığı", false],
  ["Kültür ve Turizm Bakanlığı", false],
  ["Ulaştırma ve Altyapı Bakanlığı", false],
  ["Çevre, Şehircilik ve İklim Değişikliği Bakanlığı", false],
  ["Tarım ve Orman Bakanlığı", false],
  ["Sanayi ve Teknoloji Bakanlığı", false],
  ["Ticaret Bakanlığı", false],
  ["Enerji ve Tabii Kaynaklar Bakanlığı", false],
  ["Gençlik ve Spor Bakanlığı", false],
  ["Çalışma ve Sosyal Güvenlik Bakanlığı", false],
  ["Aile ve Sosyal Hizmetler Bakanlığı", false],
  ["Orta Doğu Teknik Üniversitesi", false],
  ["İstanbul Teknik Üniversitesi", false],
  ["Yıldız Teknik Üniversitesi", false],
  ["Dokuz Eylül Üniversitesi", false],
  ["Boğaziçi Üniversitesi", false],
  ["Ankara Üniversitesi", false],
  ["İstanbul Üniversitesi", false],
  ["Marmara Üniversitesi", false],
  ["Ege Üniversitesi", false],
  ["Hacettepe Üniversitesi", false],
  ["Gazi Üniversitesi", false],
  ["Bursa Uludağ Üniversitesi", false],
  ["Eskişehir Osmangazi Üniversitesi", false],
  ["Galatasaray Lisesi", false],
  ["Kabataş Erkek Lisesi", false],
  ["İstanbul Erkek Lisesi", false],
  ["Türk Dili ve Edebiyatı Bölümü", false],
  ["Siyasal Bilgiler Fakültesi", false],
  ["Başakşehir Çam ve Sakura Şehir Hastanesi", false],
  ["İstanbul Büyükşehir Belediyesi", false],
  ["Ankara Büyükşehir Belediyesi", false],
  ["İzmir Büyükşehir Belediyesi", false],
  ["Birleşmiş Milletler", false],
];

/** Check if a lowercase string has any vowel. */
export function hasVowel(s: string): boolean {
  return VOWEL_RE.test(s);
}
