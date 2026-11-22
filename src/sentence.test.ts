import assert from "node:assert/strict";
import test from "node:test";
import { KnownMisspellings } from "./known.ts";
import { fixNumberSuffix, joinWithoutApostrophe } from "./rules/proper-names.ts";
import { applySentenceRules, type AmbigCandidateQuery, type SentenceResources } from "./sentence.ts";

const WORDS = new Set([
  "merhaba", "ben", "geldim", "sonra", "gittik", "bugün", "çok", "güzel", "nasılsın", "iyiyim", "ahmet", "sınıf",
  "kez", "dosya", "site", "şeyler", "bir", "ne", "oldu", "dedi", "evet", "hayır", "gel", "hemen", "dün", "ilk",
  "istanbul", "uygulama", "inanılmaz", "ile", "bu", "aynı", "onlar",
]);
const isWord = (lower: string) => WORDS.has(lower);
const NAMES = new Map([
  ["bell", "Bell"],
  ["hatay", "Hatay"],
  ["cola", "Cola"],
  ["ahmet", "Ahmet"],
  ["istanbul", "İstanbul"],
  ["türkçe", "Türkçe"],
]);
const nameFor = (lower: string) => NAMES.get(lower);
const STEMS: Record<string, string[]> = {
  istanbula: ["istanbul"],
  ahmetle: ["ahmet"],
  türkçeyi: ["türkçe"],
  belli: ["bel", "belli"],
  hatayı: ["hata"],
};
const stemsOf = (lower: string) => STEMS[lower] ?? [];

function fix(text: string, corrections: { start: number; end: number; original: string; replacement: string }[] = []) {
  let out = "";
  let cursor = 0;
  for (const c of applySentenceRules(text, corrections, isWord, nameFor, stemsOf)) {
    out += text.slice(cursor, c.start) + c.replacement;
    cursor = c.end;
  }
  return out + text.slice(cursor);
}

test("sentence rules: missing space after a full stop and capitals", () => {
  assert.equal(fix("merhaba.ben geldim"), "Merhaba. Ben geldim");
  assert.equal(fix("nasılsın?iyiyim"), "Nasılsın? İyiyim");
  assert.equal(fix("gel!hemen"), "Gel! Hemen");
  assert.equal(fix("dün geldim. sonra gittik."), "Dün geldim. Sonra gittik.");
  assert.equal(fix("evet. ilk kez"), "Evet. İlk kez");
  assert.equal(fix("Bugün çok güzel."), "Bugün çok güzel.");
  assert.equal(fix("“ne oldu?” dedi."), "“Ne oldu?” dedi.");
});

test("sentence rules: leave abbreviations, numbers, ellipses and addresses alone", () => {
  // "Dr." is not a sentence end, but "ahmet" is a name: it gets a capital anyway.
  assert.equal(fix("Dr. ahmet geldi"), "Dr. Ahmet geldi");
  assert.equal(fix("Bir dr. lazım"), "Bir dr. lazım");
  assert.equal(fix("Dr. ali geldi"), "Dr. ali geldi");
  assert.equal(fix("Kalem, defter vb. şeyler aldık"), "Kalem, defter vb. şeyler aldık");
  assert.equal(fix("Bu 3. sınıf, ilk kez geldim."), "Bu 3. sınıf, ilk kez geldim.");
  assert.equal(fix("Değer 3.5 oldu"), "Değer 3.5 oldu");
  assert.equal(fix("Bilmiyorum... belki gelir"), "Bilmiyorum... belki gelir");
  assert.equal(fix("Bilmiyorum… belki gelir"), "Bilmiyorum… belki gelir");
  assert.equal(fix("Siteye tdkai.halid.dev üzerinden girin"), "Siteye tdkai.halid.dev üzerinden girin");
  assert.equal(fix("Bunu dosya.pdf olarak gönder"), "Bunu dosya.pdf olarak gönder");
  assert.equal(fix("Bkz. site.com adresi"), "Bkz. site.com adresi");
  assert.equal(fix("ahmet@site.com yazdı"), "Ahmet@site.com yazdı".replace("Ahmet", "ahmet"));
  assert.equal(fix("A. Yılmaz geldi. sonra gittik"), "A. Yılmaz geldi. Sonra gittik");
  assert.equal(fix("iPhone aldım"), "iPhone aldım");
  assert.equal(fix("XVIII. yüzyıl boyunca"), "XVIII. yüzyıl boyunca");
  assert.equal(fix("Hızı 217 km. yaptı"), "Hızı 217 km. yaptı");
  assert.equal(fix("Frekans 5.75 MHz. tir"), "Frekans 5.75 MHz. tir");
  assert.equal(fix("Ruiz & Pav. ex Dunal"), "Ruiz & Pav. ex Dunal");
  assert.equal(fix("Filipina Hola! magazin dergisi"), "Filipina Hola! magazin dergisi");
  assert.equal(fix("Merhaba! nasılsın"), "Merhaba! Nasılsın");
  assert.equal(fix("Hey Ocean! ve diğerleri"), "Hey Ocean! ve diğerleri");
  assert.equal(fix("ს. ყაუხჩიშვილი. ბერძნული"), "ს. ყაუხჩიშვილი. ბერძნული");
  // Only real words on both sides: "istanbul.xyz" and "abc.def" are not sentences.
  assert.equal(fix("Adres abc.def olsun"), "Adres abc.def olsun");
});

test("sentence rules: proper names", () => {
  assert.equal(fix("Dün ahmet ile istanbula gittik."), "Dün Ahmet ile İstanbul'a gittik.");
  assert.equal(fix("Bunu ahmet'e sor, türkçe biliyor."), "Bunu Ahmet'e sor, Türkçe biliyor.");
  assert.equal(fix("Bu ahmetle ilgili"), "Bu Ahmet'le ilgili");
  assert.equal(fix("Bugün dr. ahmet geldi"), "Bugün Dr. Ahmet geldi");
  assert.equal(fix("Onlar türkçeyi seviyor"), "Onlar Türkçeyi seviyor");
  // Ordinary words that only start like a name: "bel + li", "hata + yı".
  assert.equal(fix("Bu belli değil"), "Bu belli değil");
  assert.equal(fix("Aynı hatayı yaptım"), "Aynı hatayı yaptım");
  assert.equal(fix("Bir pina colada istedim"), "Bir pina colada istedim");
  assert.equal(fix("Adres istanbul.com olsun"), "Adres istanbul.com olsun");
  assert.equal(fix("Jyutping: ahmet2 olur"), "Jyutping: ahmet2 olur");
  assert.equal(fix('Bu "i" harfi'), 'Bu "i" harfi');
});

test("sentence rules: merge with a fix another rule makes to the same word", () => {
  // "cok" -> "çok" by the marks rule; at a sentence start it becomes "Çok".
  assert.equal(fix("cok güzel", [{ start: 0, end: 3, original: "cok", replacement: "çok" }]), "Çok güzel");
  // Missing space before a word that another rule fixes: "merhaba.cok" -> "Merhaba. Çok".
  assert.equal(
    fix("merhaba.cok güzel", [{ start: 8, end: 11, original: "cok", replacement: "çok" }]),
    "Merhaba. Çok güzel",
  );
});

test("proper-name helpers: number suffixes and apostrophe-removal softening", () => {
  // Number + suffix TDK apostrophe & consonant voicing
  assert.equal(fixNumberSuffix("1985", "te", false), "te");
  assert.equal(fixNumberSuffix("1985", "de", false), "te");
  assert.equal(fixNumberSuffix("1985", "de", true), "te");
  assert.equal(fixNumberSuffix("1985", "te", true), null); // already correct
  assert.equal(fixNumberSuffix("2023", "de", false), "te");
  assert.equal(fixNumberSuffix("80", "lere", false), "lere");
  assert.equal(fixNumberSuffix("2", "nci", false), "nci");
  assert.equal(fixNumberSuffix("30", "da", false), "da");
  // Unit and short-code guards
  assert.equal(fixNumberSuffix("5", "cm", false), null);
  assert.equal(fixNumberSuffix("3", "a", false), null);
  assert.equal(fixNumberSuffix("20", "px", false), null);

  // Softening when stripping an erroneous apostrophe
  const morphWords = new Set(["kitabı", "ağaca", "tutarlılığı"]);
  const isMorph = (w: string) => morphWords.has(w);
  assert.equal(joinWithoutApostrophe("Hristiyanlık", "ın", isMorph), "Hristiyanlığın");
  assert.equal(joinWithoutApostrophe("Atatürkçülük", "ün", isMorph), "Atatürkçülüğün");
  assert.equal(joinWithoutApostrophe("Başbakanlık", "a", isMorph), "Başbakanlığa");
  assert.equal(joinWithoutApostrophe("kitap", "ı", isMorph), "kitabı");
  assert.equal(joinWithoutApostrophe("ağaç", "a", isMorph), "ağaca");
  assert.equal(joinWithoutApostrophe("Türkler", "in", isMorph), "Türklerin");
});

test("TDK full-engine clean-text false-positive guards and preserved true fixes", () => {
  const known = KnownMisspellings.fromTsv(
    [
      "şili\tŞili\t0\t5000\tNAME",
      "dicle\tDicle\t0\t5000\tNAME",
      "sırp\tSırp\t0\t5000\tNAME",
      "yahudi\tYahudi\t0\t5000\tNAME",
      "londra\tLondra\t0\t10000\tNAME",
      "eskimo\tEskimo\t0\t2000\tNAME",
      "hacettepe\tHacettepe\t0\t5000\tNAME",
      "boğaziçi\tBoğaziçi\t0\t8000\tNAME",
      "fransızca\tFransızca\tnoapos\t10000\tNAME",
      "mustafa\tMustafa\t0\t30000\tNAME",
      "murat\tMurat\t0\t20000\tNAME",
      "volvo\tVolvo\t0\t700\tNAME",
      "ptt\tPTT\t0\t5000\tACRO",
      "mustafa\tMustafa\t0\t500\tGIVEN",
      "murat\tMurat\t0\t500\tGIVEN",
      "eren\tEren\t0\t500\tGIVEN",
      "okan\tOkan\t0\t500\tGIVEN",
      "barış\tBarış\t0\t500\tGIVEN",
      "savaş\tSavaş\t0\t500\tGIVEN",
      "güneş\tGüneş\t0\t500\tGIVEN",
      "okan\tOkan\t0\t500\tSURNAME",
      "manço\tManço\t0\t500\tSURNAME",
      "yıldız\tYıldız\t0\t0\tAMBIG",
      "savaş\tSavaş\t0\t0\tAMBIG",
      "güneş\tGüneş\t0\t0\tAMBIG",
      "eren\tEren\t0\t0\tAMBIG",
    ].join("\n"),
  );
  const morphSet = new Set([
    "sunucuların", "eren", "sona", "savaşa", "savaş", "güneş", "sokağıdır", "kış", "uykusuna", "yattı",
    "eski", "çağ", "astronomlarının", "orta", "güney", "kulübü", "partisini", "komisyonu", "elçiliği",
    "müdürü", "başkanı", "odası", "köy", "iletişim", "bölümünden", "öğretmenler", "günü",
  ]);
  const counts: Record<string, number> = {
    "murat'ın": 800,
    muratın: 10,
    sunucuların: 120,
    volvo: 698,
    weisse: 38,
    sharks: 79,
  };
  const capShares: Record<string, number> = {
    volvo: 0.5,
    weisse: 0.78,
    sharks: 0.82,
  };
  const pairs: Record<string, number> = {
    "sona eren": 400,
  };
  const fixFull = (text: string, collectAmbig?: AmbigCandidateQuery[]): string => {
    const res: SentenceResources = {
      known,
      isMorphWord: (w) => morphSet.has(w),
      count: (w) => counts[w] ?? 0,
      capitalShare: (w) => capShares[w] ?? 0,
      pair: (a, b) => pairs[`${a} ${b}`] ?? 0,
      collectAmbig,
    };
    let out = "";
    let cursor = 0;
    for (const c of applySentenceRules(text, [], (w) => morphSet.has(w), (w) => known.nameFor(w), () => null, res)) {
      out += text.slice(cursor, c.start) + c.replacement;
      cursor = c.end;
    }
    return out + text.slice(cursor);
  };

  // 1. Generic era modifier vs historical period
  assert.equal(
    fixFull("Gezegen adı çünkü eski çağ astronomlarının kayıtlarından gelir."),
    "Gezegen adı çünkü eski çağ astronomlarının kayıtlarından gelir.",
  );
  assert.equal(fixFull("eski çağın uygarlıkları incelendi."), "Eski Çağ'ın uygarlıkları incelendi.");
  assert.equal(fixFull("İlk çağ yazının icadıyla başladı."), "İlk Çağ yazının icadıyla başladı.");

  // 2. Job role after institution vs official makam title
  assert.equal(
    fixFull("Annesi daha sonra Bremen Sanat Müzesi müdürü ressam Carl Horn ile evlendi."),
    "Annesi daha sonra Bremen Sanat Müzesi müdürü ressam Carl Horn ile evlendi.",
  );
  assert.equal(
    fixFull("Eski Azerbaycan Millî Meclisi başkanı Resul Guliyev konuştu."),
    "Eski Azerbaycan Millî Meclisi başkanı Resul Guliyev konuştu.",
  );
  assert.equal(
    fixFull("Türk Dil Kurumu başkanına dilekçe verdik."),
    "Türk Dil Kurumu Başkanı'na dilekçe verdik.",
  );
  assert.equal(
    fixFull("Türk Dil Kurumu başkanı açıklama yaptı."),
    "Türk Dil Kurumu Başkanı açıklama yaptı.",
  );

  // 3. Descriptive direction adjectives vs established regions
  assert.equal(
    fixFull("Hayvancılık ise ağırlıkla orta Şili ve güney Şili’nin kuzey kısımlarında yapılır."),
    "Hayvancılık ise ağırlıkla orta Şili ve güney Şili’nin kuzey kısımlarında yapılır.",
  );
  assert.equal(
    fixFull("Uçak güneybatıdan güney Hint Okyanusu'na doğru ilerledi."),
    "Uçak güneybatıdan güney Hint Okyanusu'na doğru ilerledi.",
  );
  assert.equal(
    fixFull("batı anadolu kıyılarında zeytinlikler yaygın."),
    "Batı Anadolu kıyılarında zeytinlikler yaygın.",
  );

  // 4. Do not guess-capitalize uncertain mixed-case multi-word institutions
  assert.equal(
    fixFull("Dicle Gençlik kulübü sezon sonunda ligden çekilmiştir."),
    "Dicle Gençlik kulübü sezon sonunda ligden çekilmiştir.",
  );
  assert.equal(
    fixFull("Parti, Sırp Listesi partisini eleştirdi."),
    "Parti, Sırp Listesi partisini eleştirdi.",
  );
  assert.equal(
    fixFull("Eike Geisel, Yahudi kültür Birliği hakkında belgeseller yayınladı."),
    "Eike Geisel, Yahudi kültür Birliği hakkında belgeseller yayınladı.",
  );
  assert.equal(
    fixFull("Millî Eğitim Özel İhtisas komisyonu raporu yayımlandı."),
    "Millî Eğitim Özel İhtisas komisyonu raporu yayımlandı.",
  );
  assert.equal(
    fixFull("Paşa, Londra Büyük elçiliği esnasında çalıştı."),
    "Paşa, Londra Büyük elçiliği esnasında çalıştı.",
  );
  assert.equal(
    fixFull("Sonraki 3 yıl ise PTT genel müdürlüğünde avukatlık yaptı."),
    "Sonraki 3 yıl ise PTT genel müdürlüğünde avukatlık yaptı.",
  );
  assert.equal(
    fixFull("Aslında Boston Üniversitesi iletişim bölümünden mezun oldum."),
    "Aslında Boston Üniversitesi iletişim bölümünden mezun oldum.",
  );
  assert.equal(
    fixFull("Şenlikler eskiden Eskimo köy odası içinde olurdu."),
    "Şenlikler eskiden Eskimo köy odası içinde olurdu.",
  );
  // Real all-lowercase / canonical institutions still work
  assert.equal(
    fixFull("Boğaziçi üniversitesinde yüksek lisans yapıyor."),
    "Boğaziçi Üniversitesinde yüksek lisans yapıyor.",
  );
  assert.equal(
    fixFull("Pastayı köşedeki yıldız pastanesinden aldım."),
    "Pastayı köşedeki Yıldız Pastanesinden aldım.",
  );

  // 5. Inflected institution head must not trigger geo capitalization on predicate copula
  assert.equal(
    fixFull("Mekân Atatürk Lisesi’nin sokağıdır."),
    "Mekân Atatürk Lisesinin sokağıdır.",
  );

  // 6. Common Turkish participle before an already-capitalized full name must not be capitalized
  assert.equal(
    fixFull("Sezon sonunda sözleşmesi sona eren Okan Buruk takımdan ayrıldı."),
    "Sezon sonunda sözleşmesi sona eren Okan Buruk takımdan ayrıldı.",
  );
  assert.equal(
    fixFull("Çocukken barış Manço'nun şarkılarını dinlerdik."),
    "Çocukken Barış Manço'nun şarkılarını dinlerdik.",
  );

  // 7. Contextual 2-word special days & everyday-word literary/film titles
  assert.equal(
    fixFull("Bugün öğretmenler günü, çiçek almam lazım."),
    "Bugün öğretmenler günü, çiçek almam lazım.",
  );
  assert.equal(
    fixFull("Öğretmenler günü için sınıfımızla küçük bir sürpriz hazırladık."),
    "Öğretmenler günü için sınıfımızla küçük bir sürpriz hazırladık.",
  );
  assert.equal(
    fixFull("Öğretmenler günü kutlu olsun!"),
    "Öğretmenler Günü kutlu olsun!",
  );
  assert.equal(
    fixFull("gaziler günü töreninde müdürümüz konuştu."),
    "Gaziler Günü töreninde müdürümüz konuştu.",
  );
  assert.equal(
    fixFull("Ayılar kış uykusuna yattı."),
    "Ayılar kış uykusuna yattı.",
  );
  assert.equal(
    fixFull("Dün akşam kış uykusu filmini izledim."),
    "Dün akşam Kış Uykusu filmini izledim.",
  );

  // 8. Foreign English-plural & low-capShare brand guards vs preserved TDK true fixes
  assert.equal(
    fixFull("Sharks'ların yapması gereken tek şey topu tutmak."),
    "Sharks'ların yapması gereken tek şey topu tutmak.",
  );
  assert.equal(
    fixFull("O aptal Volvo'ları bozulup duruyor."),
    "O aptal Volvo'ları bozulup duruyor.",
  );
  // Preserved TDK true fixes
  assert.equal(fixFull("Hacettepe Üniversitesi'nde görev yaptı."), "Hacettepe Üniversitesinde görev yaptı.");
  assert.equal(fixFull("Eserleri Fransızca'ya çevrildi."), "Eserleri Fransızcaya çevrildi.");
  assert.equal(fixFull("Modern Berliner Weisse'ler üretilir."), "Modern Berliner Weisseler üretilir.");
  assert.equal(fixFull("Kaynak olabilecek sunucu'ların adresleri belli."), "Kaynak olabilecek sunucuların adresleri belli.");
  assert.equal(fixFull("Yangından sonra Mustafa ağa'nın babası geldi."), "Yangından sonra Mustafa Ağa'nın babası geldi.");
  assert.equal(fixFull("Muratın oğlu uzun süre hüküm sürmüştür."), "Murat'ın oğlu uzun süre hüküm sürmüştür.");

  // 9. Parenthetical remark after full stop & neural context gloss/same-stem guards
  assert.equal(
    fixFull('Bu adıma "tick" adı verilir. (başka bir deyişle, dağılım sonucudur).'),
    'Bu adıma "tick" adı verilir. (başka bir deyişle, dağılım sonucudur).',
  );
  const ambig1: AmbigCandidateQuery[] = [];
  fixFull('Helyum (Yunanca "güneş" anlamına gelen helios), kimyasal elementtir.', ambig1);
  assert.equal(ambig1.some((q) => q.base === "güneş"), false);
  const ambig2: AmbigCandidateQuery[] = [];
  fixFull("Olay, savaşa neden olduğu için, savaş başladıktan sonra arttı.", ambig2);
  assert.equal(ambig2.some((q) => q.base === "savaşa" || q.base === "savaş"), false);
});
