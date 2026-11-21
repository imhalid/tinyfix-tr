import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FEATURE_DIM,
  buildContextFeatures,
  encodeSubwords,
  morphFeatureBits,
  pack,
  packSubwords,
  ContextModel,
} from "./context.ts";
import { CAREFUL, Corrector, type WordAnalysis, type WordValidator } from "./corrector.ts";
import { KnownMisspellings } from "./known.ts";
import { Lexicon } from "./lexicon.ts";
import {
  collapsedDoubledLocative,
  fixDisharmoniousApostropheSuffix,
  harmonizeQuestionParticle,
  hasBlockedApostropheStem,
  isHarmoniousApostropheMarkChange,
  isPlaceApostropheHead,
  isValidGenericApostrophe,
  isValidKnownParticleSuffix,
  isValidPlaceApostrophe,
  matchAcronymApostrophe,
} from "./rules/turkish-rules.ts";
import { lowerTr, markVariants, matchCase } from "./turkish.ts";
import { loadMorphology } from "../bench/setup.ts";

test("Turkish casing", () => {
  assert.equal(lowerTr("İSTANBUL ILIK"), "istanbul ılık");
  assert.equal(matchCase("Cok", "çok"), "Çok");
  assert.equal(matchCase("ISTANBUL", "istanbul"), "İSTANBUL");
  assert.ok(markVariants("cok").includes("çok"));
});

// The tests below need the lexicon built from Wikipedia (see README); they are skipped without it.
let corrector: Corrector | undefined;
try {
  const lexicon = Lexicon.fromTsv(readFileSync("data/work/unigrams_conv.tsv", "utf8"), readFileSync("data/work/bigrams.tsv", "utf8"), 1, 5);
  corrector = new Corrector(lexicon, undefined, KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8")), process.argv.includes("--no-morphology") ? undefined : loadMorphology());
} catch {
  corrector = undefined;
}

const fixes: [string, string][] = [
  ["Bugün cok yorgunum.", "Bugün çok yorgunum."],
  ["Yarın Ankaraya gidiyorum.", "Yarın Ankara'ya gidiyorum."],
  ["Birşey söylemek istiyorum ama hiç bir fikrim yok.", "Bir şey söylemek istiyorum ama hiçbir fikrim yok."],
  ["Bu iş biter mi bilmiyorum, sen geldinmi?", "Bu iş biter mi bilmiyorum, sen geldin mi?"],
  ["Yarın sen de gelecekmisin?", "Yarın sen de gelecek misin?"],
  ["Eski sürüm daha iyiydi ama arenasıda doluydu.", "Eski sürüm daha iyiydi ama arenası da doluydu."],
  ["Öyle bir şey diyorki herkes güldü.", "Öyle bir şey diyor ki herkes güldü."],
  ["Oysa ki ben ona söylemiştim.", "Oysaki ben ona söylemiştim."],
  ["Herkez geldi, malesef sen yoktun.", "Herkes geldi, maalesef sen yoktun."],
  ["yapabiliur miyiz bunu", "yapabilir miyiz bunu"],
];
// Correct text that must stay as it is: valid words the rules could mistake for errors.
const keeps = [
  "Kitabı bende kaldı, sen de gel.",
  "Odada kimse yoktu, o da gelmedi.",
  "Uç noktada durdu ve dişini sıktı.",
  "Ankaralı arkadaşım Türklerin tarihini anlattı.",
  "Türk Dil Kurumundan bir mektup geldi.",
  "Kitabımı evde unuttum, sevgimi ona anlattım.",
  "Evdeki hesap çarşıya uymaz.",
];

for (const [input, want] of fixes) {
  test(`fixes: ${input}`, { skip: !corrector && "lexicon not built" }, () => {
    assert.equal(corrector!.correct(input).text, want);
  });
}
for (const input of keeps) {
  test(`keeps: ${input}`, { skip: !corrector && "lexicon not built" }, () => {
    assert.equal(corrector!.correct(input).text, input);
  });
}

// Spoken-style contractions are a style choice: left alone by default (and not taken for slips), spelled out when asked.
test("contractions stay as typed by default", { skip: !corrector && "lexicon not built" }, () => {
  for (const input of ["Burda ne noldu, bilmiyorum.", "Yarın gidecem, sen nerde kaldın?"]) {
    assert.equal(corrector!.correct(input).text, input);
  }
});
test("contractions are spelled out when the option is on", { skip: !corrector && "lexicon not built" }, () => {
  corrector!.settings = { ...corrector!.settings, contractions: true };
  try {
    assert.equal(corrector!.correct("Burda ne oldu, bilmiyorum.").text, "Burada ne oldu, bilmiyorum.");
    assert.equal(corrector!.correct("Yarın gidecem, sen nerde kaldın?").text, "Yarın gideceğim, sen nerede kaldın?");
    const fix = corrector!.correct("Bugün noldu?").corrections[0];
    assert.equal(fix?.replacement, "ne oldu");
    assert.equal(fix?.kind, "contraction");
  } finally {
    corrector!.settings = { ...corrector!.settings, contractions: false };
  }
});

test("Turkish rule helpers", () => {
  // KnownMisspellings particle suffix guard
  assert.equal(isValidKnownParticleSuffix("kim mi", "ş"), false);
  assert.equal(isValidKnownParticleSuffix("var mı", "ş"), false);
  assert.equal(isValidKnownParticleSuffix("var mı", "sın"), true);
  assert.equal(isValidKnownParticleSuffix("var mı", "ydı"), true);
  assert.equal(isValidKnownParticleSuffix("var mı", "sin"), false);
  assert.equal(isValidKnownParticleSuffix("ya da", "cı"), false);
  assert.equal(isValidKnownParticleSuffix("değil ki", "m"), false);
  assert.equal(isValidKnownParticleSuffix("bir şey", "ler"), true);

  // Generic apostrophe stem & phonology guards
  assert.equal(hasBlockedApostropheStem("müslümanlar"), true);
  assert.equal(hasBlockedApostropheStem("japonların"), true);
  assert.equal(hasBlockedApostropheStem("yunanlardan"), true);
  assert.equal(hasBlockedApostropheStem("türklerin"), true);
  assert.equal(hasBlockedApostropheStem("türkçeden"), true);
  assert.equal(hasBlockedApostropheStem("hırvatça"), true);
  assert.equal(hasBlockedApostropheStem("karaca", false), true);
  assert.equal(hasBlockedApostropheStem("karaca", true), false);
  assert.equal(hasBlockedApostropheStem("bakanlığı"), true);
  assert.equal(hasBlockedApostropheStem("zeynep"), false);
  assert.equal(hasBlockedApostropheStem("clara"), false);
  assert.equal(hasBlockedApostropheStem("valerin"), false);
  assert.equal(isValidGenericApostrophe("zeynep", "ten"), true);
  assert.equal(isValidGenericApostrophe("zeynep", "den"), false);
  assert.equal(isValidGenericApostrophe("ankara", "in"), false);
  assert.equal(isValidGenericApostrophe("ankara", "nın"), true);
  assert.equal(isValidGenericApostrophe("google", "ın"), true);
  assert.equal(isValidGenericApostrophe("mark", "ya"), false);

  // Acronym & mixed-case brand apostrophe detection
  assert.deepEqual(matchAcronymApostrophe("HEXIMden"), { prefix: "HEXIM", suffix: "den", withMark: "hexım'den" });
  assert.deepEqual(matchAcronymApostrophe("KDAların"), { prefix: "KDA", suffix: "ların", withMark: "kda'ların" });
  assert.deepEqual(matchAcronymApostrophe("TLSnin"), { prefix: "TLS", suffix: "nin", withMark: "tls'nin" });
  assert.deepEqual(matchAcronymApostrophe("MacOSdaki"), { prefix: "MacOS", suffix: "daki", withMark: "macos'daki" });
  assert.deepEqual(matchAcronymApostrophe("OpenAIden"), { prefix: "OpenAI", suffix: "den", withMark: "openaı'den" });
  assert.equal(matchAcronymApostrophe("AIde"), null);
  assert.equal(matchAcronymApostrophe("EVde"), null);
  assert.equal(matchAcronymApostrophe("URLs"), null);

  // Apostrophe suffix vowel harmony & disharmony restoration (preserves -ki)
  assert.equal(isHarmoniousApostropheMarkChange("mortimer", "i", "ı"), false);
  assert.equal(isHarmoniousApostropheMarkChange("ravenna", "nin", "nın"), true);
  assert.equal(isHarmoniousApostropheMarkChange("mary", "i", "ı"), false);
  assert.equal(isHarmoniousApostropheMarkChange("altay", "in", "ın"), true);
  assert.equal(isHarmoniousApostropheMarkChange("begüm", "un", "ün"), true);
  assert.equal(isHarmoniousApostropheMarkChange("alkol", "un", "ün", true), true);
  assert.equal(isHarmoniousApostropheMarkChange("istanbul", "u", "ü", false), false);
  assert.equal(fixDisharmoniousApostropheSuffix("ukrayna'sinda"), "ukrayna'sında");
  assert.equal(fixDisharmoniousApostropheSuffix("ankara'sindaki"), "ankara'sındaki");
  assert.equal(fixDisharmoniousApostropheSuffix("kda'larin"), "kda'ların");
  assert.equal(fixDisharmoniousApostropheSuffix("ankara'daki"), null);
  assert.equal(fixDisharmoniousApostropheSuffix("ukrayna'sında"), null);
  assert.equal(fixDisharmoniousApostropheSuffix("mortimer'sinda"), null);

  // Doubled-locative plural typo detection
  assert.equal(collapsedDoubledLocative("bölgedeler", "de"), "bölgelerde");
  assert.equal(collapsedDoubledLocative("alandalar", "da"), "alanlarda");
  assert.equal(collapsedDoubledLocative("bölgelerde", "de"), null);

  // Standalone question particle harmony
  assert.equal(harmonizeQuestionParticle("mi", "var", false), "mı");
  assert.equal(harmonizeQuestionParticle("misin", "hazır", false), "mısın");
  assert.equal(harmonizeQuestionParticle("mu", "gördü", false), "mü");
  assert.equal(harmonizeQuestionParticle("mi", "saat", true), null);
  assert.equal(harmonizeQuestionParticle("mu", "alkol", true), "mü");
  assert.equal(harmonizeQuestionParticle("mü", "oldu", false), null);

  // TDK place/geographic/state apostrophe head-word rules vs institutions
  assert.equal(isPlaceApostropheHead("denizi"), true);
  assert.equal(isPlaceApostropheHead("cumhuriyeti"), true);
  assert.equal(isPlaceApostropheHead("mahallesi"), true);
  assert.equal(isPlaceApostropheHead("birliği", "avrupa"), true);
  assert.equal(isPlaceApostropheHead("birliği", "psikiyatri"), false);
  assert.equal(isPlaceApostropheHead("üniversitesi"), false);
  assert.equal(isPlaceApostropheHead("partisi"), false);
  assert.equal(isPlaceApostropheHead("kurumu"), false);
  assert.equal(isValidPlaceApostrophe("denizi", "nin"), true);
  assert.equal(isValidPlaceApostrophe("mahallesi", "nde"), true);
  assert.equal(isValidPlaceApostrophe("cumhuriyeti", "nden"), true);
  assert.equal(isValidPlaceApostrophe("okyanus", "ta"), true);
  assert.equal(isValidPlaceApostrophe("okyanus", "da"), false);
  assert.equal(isValidPlaceApostrophe("denizi", "nın"), false);
  assert.equal(hasBlockedApostropheStem("denizi", true, false), true);
  assert.equal(hasBlockedApostropheStem("denizi", true, true), false);
});

test("synthetic regression tests (no full lexicon required)", () => {
  const unigrams = [
    "ortaokul\t1550\t10",
    "ortaokulda\t160\t0",
    "orta\t5000\t100",
    "okul\t4000\t50",
    "gözlemci\t500\t20",
    "gözlemciden\t100\t0",
    "her\t50000\t500",
    "neyse\t5000\t50",
    "herneyse\t3792\t0",
    "ikinizin\t500\t5",
    "ikinizinde\t52\t0",
    "boyunu\t300\t0",
    "boyunda\t2000\t0",
    "giyside\t7\t0",
    "giysi\t1500\t10",
    "kitap\t5000\t50",
    "kitapta\t2000\t0",
    "hayal\t4000\t20",
    "hayalde\t120\t0",
    "çok\t80000\t500",
    "çokta\t80\t0",
    "yazım\t1182\t91",
    "yazımı\t794\t36",
    "yazılı\t5480\t108",
    "weeknd\t150\t130",
    "weeknd'in\t70\t65",
    "müslümanlar\t2000\t1800",
    "müslümanlara\t665\t500",
    "japon\t8000\t7000",
    "japonların\t400\t360",
    "yunan\t22000\t17000",
    "yunanlardan\t150\t130",
    "mortimer'ı\t12\t12",
    "ravenna'nın\t12\t12",
    "bağrım\t8\t0",
    "alveol\t25\t0",
    "yüklemek\t300\t0",
    "bre\t400\t30",
    "bölgelerde\t4800\t50",
    "bölgedeler\t2\t0",
    "elif\t500\t270",
    "elif'in\t120\t100",
    "elifin\t80\t3",
    "bursa\t5000\t3500",
    "bursa'dan\t500\t450",
    "ekim\t60000\t54000",
    "ekim'de\t800\t750",
    "ekimde\t300\t30",
    "cabası\t8\t0",
    "çabası\t804\t25",
    "asil\t1479\t187",
    "aşil'in\t53\t40",
    "suikastçı\t152\t0",
    "suikastçi\t84\t0",
    "var\t50000\t500",
    "mi\t10000\t10",
    "mı\t20000\t10",
    "saat\t10000\t200",
    "gordu\t0\t0",
    "gördü\t9944\t20",
    "mu\t10000\t10",
    "mü\t8000\t10",
    "miş\t159\t0",
    "mısın\t5000\t0",
    "gün\t40000\t200",
    "kim\t20000\t100",
    "gelecekm\t0\t0",
    "geleceksin\t5000\t0",
    "gelecek\t30000\t100",
    "katıldı\t8000\t10",
    "katıldımı\t0\t0",
    "katılımı\t5000\t10",
  ].join("\n");
  const bigrams = [
    "orta okul\t100",
    "ortaokul da\t2",
    "var mı\t5000",
    "saat mi\t40",
    "gördü mü\t300",
  ].join("\n");
  const knownTsv = [
    "kimmi\tkim mi\t0\t3000\tMINED",
    "varmı\tvar mı\t0\t5000\tMINED",
  ].join("\n");
  const validWords = new Set([
    "ortaokul", "ortaokulda", "her", "neyse", "ikinizin",
    "boyunu", "boyunda", "giyside", "giysi", "kitap", "kitapta",
    "hayal", "hayalde", "hayalden", "çok", "çokta", "yazım", "yazımı", "yazılı", "müslümanlar", "müslümanlara",
    "japon", "japonların", "japonlarının", "yunan", "yunanlardan", "yunanlardandır",
    "cabası", "çabası", "asil", "suikastçı", "yükleyince", "bağrım", "alveol", "alveolüsün",
    "bre", "bölgelerde", "bölgedeler",
    "var", "varde", "varda", "vardan", "saat", "saatte", "saatten", "gördü", "günde", "kimmiş",
    "katıldı", "katılımı", "gelecek", "geleceksin",
  ]);
  const analysesMap = new Map<string, readonly WordAnalysis[]>([
    ["japon", [{ stem: "japon", pos: "Noun", morphemes: ["A3sg"] }]],
    ["japonların", [{ stem: "japon", pos: "Noun", morphemes: ["A3pl", "Gen"] }]],
    ["yunan", [{ stem: "yunan", pos: "Noun", morphemes: ["A3sg"] }]],
    ["yunanlardan", [{ stem: "yunan", pos: "Noun", morphemes: ["A3pl", "Abl"] }]],
    ["yükleyince", [{ stem: "yükle", pos: "Verb", morphemes: ["When"] }]],
    ["alveolüsün", [{ stem: "alveol", pos: "Noun", morphemes: ["A3sg", "P3sg", "Zero", "Pres", "A2sg"] }]],
  ]);
  const morph: WordValidator = {
    isWord: (form) => validWords.has(form),
    analyze: (form) => analysesMap.get(form) ?? [],
  };
  const c = new Corrector(Lexicon.fromTsv(unigrams, bigrams, 1, 1), undefined, KnownMisspellings.fromTsv(knownTsv), morph);

  // Known particle suffixation: blocks kimmiş -> kim miş, allows varmısın -> var mısın
  assert.equal(c.correct("Kimmiş?").text, "Kimmiş?");
  assert.equal(c.correct("Varmısın?").text, "Var mısın?");

  // Margin-based candidate comparison: ortaokul da -> ortaokulda
  assert.equal(c.correct("Çocuk ortaokul da okudu.").text, "Çocuk ortaokulda okudu.");

  // Join guards: two capitalized mid-sentence words, Her neyse, İkinizin de
  assert.equal(c.correct("Bu Gözlemci Den geldi.").text, "Bu Gözlemci Den geldi.");
  assert.equal(c.correct("Her neyse tamam.").text, "Her neyse tamam.");
  assert.equal(c.correct("İkinizin de gelmesi gerek.").text, "İkinizin de gelmesi gerek.");

  // Morphological particle splits + typo hijacking guard + voicing/harmony guards
  assert.equal(c.correct("Küçük boyunuda aldım.").text, "Küçük boyunu da aldım.");
  assert.equal(c.correct("Giyside leke vardı.").text, "Giyside leke vardı.");
  assert.equal(c.correct("Bu kitapda yazılı.").text, "Bu kitapta yazılı.");
  assert.equal(c.correct("Bu hayalda güzel.").text, "Bu hayalda güzel.");
  assert.equal(c.correct("Bu çok ta güzel.").text, "Bu çok ta güzel.");
  assert.equal(c.correct("Güzel yazımmı bu.").text, "Güzel yazım mı bu.");

  // Apostrophe fixes & guards
  assert.equal(c.correct("Dün Weekndin şarkısı çaldı.").text, "Dün Weeknd'in şarkısı çaldı.");
  assert.equal(c.correct("Burada Muslumanlara yardım edildi.").text, "Burada Müslümanlara yardım edildi.");
  assert.equal(c.correct("Dönemin Japonlarının ve eski Yunanlardandır.").text, "Dönemin Japonlarının ve eski Yunanlardandır.");
  assert.equal(c.correct("Dün Elifin kitabı geldi.").text, "Dün Elif'in kitabı geldi.");
  assert.equal(c.correct("Bursadan geldik.").text, "Bursa'dan geldik.");
  assert.equal(c.correct("Ekimde soğuk olur.").text, "Ekimde soğuk olur.");
  assert.equal(c.correct("Bu 6 Ekimde oldu.").text, "Bu 6 Ekim'de oldu.");
  assert.equal(c.correct("13 Ekimde oldu.").text, "13 Ekim'de oldu.");
  assert.equal(c.correct("1. Ekimde oldu.").text, "1. Ekimde oldu.");
  assert.equal(c.correct("Veri HEXIMden ve KDAların içinden geldi.").text, "Veri HEXIM'den ve KDA'ların içinden geldi.");
  assert.equal(c.correct("Güncelleme MacOSdaki sorunu çözdü.").text, "Güncelleme MacOS'daki sorunu çözdü.");
  assert.equal(c.correct("GÜNde iki kez.").text, "GÜNde iki kez.");

  // Marks fixes & guards
  assert.equal(c.correct("Bu işin cabası şudur.").text, "Bu işin cabası şudur.");
  assert.equal(c.correct("Dün Asil'in ödevi bitti.").text, "Dün Asil'in ödevi bitti.");
  assert.equal(c.correct("Yazar Mortimer'i anlattı.").text, "Yazar Mortimer'i anlattı.");
  assert.equal(c.correct("Eski Ravenna'nin duvarları.").text, "Eski Ravenna'nın duvarları.");
  assert.equal(c.correct("Prens Morza Bagrim burada kaldı.").text, "Prens Morza Bagrim burada kaldı.");
  assert.equal(c.correct("Bu alveolusun yapısı.").text, "Bu alveolusun yapısı.");
  assert.equal(c.correct("Bir suikastci yakalandı.").text, "Bir suikastçı yakalandı.");
  assert.equal(c.correct("Tekrar yukleyince düzeldi.").text, "Tekrar yükleyince düzeldi.");
  assert.equal(c.correct("Ukrayna'sinda yaşananlar.").text, "Ukrayna'sında yaşananlar.");
  assert.equal(c.correct("var mi?").text, "var mı?");
  assert.equal(c.correct("gordu mu?").text, "gördü mü?");
  assert.equal(c.correct("saat mi?").text, "saat mi?");

  // Short-stem ki guard & doubled-locative typo guard & unsplit harmonized question typo guard
  assert.equal(c.correct("Bu breki kazandı.").text, "Bu breki kazandı.");
  assert.equal(c.correct("Başka bölgedelerde görüldü.").text, "Başka bölgedelerde görüldü.");
  assert.equal(c.correct("Bu bölgelerdede görüldü.").text, "Bu bölgelerde de görüldü.");
  assert.equal(c.correct("Toplantıya katıldımı?").text, "Toplantıya katıldı mı?");

  // Idempotence on outputs
  for (const sample of [
    "Küçük boyunuda aldım.",
    "Dün Weekndin şarkısı çaldı.",
    "Bursadan geldik.",
    "Veri HEXIMden geldi.",
    "gordu mu?",
  ]) {
    const once = c.correct(sample).text;
    assert.equal(c.correct(once).text, once);
  }
});

const noMorphology = process.argv.includes("--no-morphology");

const extraFixes: [string, string][] = [
  ["Büyük boyunu kullanıyordum, küçük boyunuda aldım.", "Büyük boyunu kullanıyordum, küçük boyunu da aldım."],
  ["İklim değişikliği yağış düzeninide doğrudan etkiliyor.", "İklim değişikliği yağış düzenini de doğrudan etkiliyor."],
  ["Yüz yüze görüşmelerede yer verilmiştir.", "Yüz yüze görüşmelere de yer verilmiştir."],
  ["Kendime almıştım, çok beğenince kardeşimede bir tane sipariş ettim.", "Kendime almıştım, çok beğenince kardeşime de bir tane sipariş ettim."],
  ["Çocuk ortaokul da okurken müzikle ilgilendi.", "Çocuk ortaokulda okurken müzikle ilgilendi."],
  ["Bu kayalık ta ilginç izler vardı.", "Bu kayalıkta ilginç izler vardı."],
  ["Son güncellemeyi test ortamına yükledinizmi?", "Son güncellemeyi test ortamına yüklediniz mi?"],
  ["Bu mont yeterince sıcak tutarmı diye tereddüt etmiştim.", "Bu mont yeterince sıcak tutar mı diye tereddüt etmiştim."],
  ["Aldığım takım gerçekten güzelmi güzel.", "Aldığım takım gerçekten güzel mi güzel."],
  ["Tasarım revizyonlarını Zeynepten teslim aldık.", "Tasarım revizyonlarını Zeynep'ten teslim aldık."],
  ["Bursadan gönderdiğimiz koli bu sabah teslim edilmiştir.", "Bursa'dan gönderdiğimiz koli bu sabah teslim edilmiştir."],
  ["Ödevin araştırma bölümünü Elifin hazırladığı kaynakçayla birleştirdik.", "Ödevin araştırma bölümünü Elif'in hazırladığı kaynakçayla birleştirdik."],
  ["Bağlantı TLSnin güncel sürümüyle korunuyor.", "Bağlantı TLS'nin güncel sürümüyle korunuyor."],
  ["Uygulamayı silip tekrar yukleyince düzeldi.", "Uygulamayı silip tekrar yükleyince düzeldi."],
  ["Kutunun köşesi biraz ezilmisti.", "Kutunun köşesi biraz ezilmişti."],
  ["Eve dönerken marketten ekmek ve yogurt alabilir misin?", "Eve dönerken marketten ekmek ve yoğurt alabilir misin?"],
  ["Bu dizustu bilgisayari oyun icin alan var mi?", "Bu dizüstü bilgisayarı oyun için alan var mı?"],
  ["Yüzden fazla kişi biliyorumki bunu gördü.", "Yüzden fazla kişi biliyorum ki bunu gördü."],
  ["Ravenna'nin eski yapıları korunmuştur.", "Ravenna'nın eski yapıları korunmuştur."],
  // v7 accuracy rules: marks, equal-margin threshold, ASCII sentence, apostrophe, typo channel, compound verbs, splits
  ["Dün okuldaydi ama hazirliklariyla ilgileniyordu.", "Dün okuldaydı ama hazırlıklarıyla ilgileniyordu."],
  ["Yarin erken gidecegiz ve bu konuyu kapatacaktir.", "Yarın erken gideceğiz ve bu konuyu kapatacaktır."],
  ["Bir dogrunun egrisi ve makasi cizildi.", "Bir doğrunun eğrisi ve makası çizildi."],
  ["Hava isinmadir ama gecenleri unutmadi.", "Hava ısınmadır ama geçenleri unutmadı."],
  ["Isa'nin dogumu ve Istanbul'da yasam.", "İsa'nın doğumu ve İstanbul'da yaşam."],
  ["Bu Odullerinde buyuk basari gosterdi.", "Bu Ödüllerinde büyük başarı gösterdi."],
  ["13 Kasımda toplantı yapıldı.", "13 Kasım'da toplantı yapıldı."],
  ["Dün Karacadan güzel bir haber geldi.", "Dün Karaca'dan güzel bir haber geldi."],
  ["Arkadaşım Discordu ve Arsenalı çok seviyor.", "Arkadaşım Discord'u ve Arsenal'ı çok seviyor."],
  ["Takım Malatyaspora karşı oynadı.", "Takım Malatyaspor'a karşı oynadı."],
  ["Yazar Aclan Beyin evine gitti.", "Yazar Aclan Bey'in evine gitti."],
  ["Güncelleme MacOSdaki ve OpenAIden gelen hatayı giderdi.", "Güncelleme MacOS'daki ve OpenAI'den gelen hatayı giderdi."],
  ["Çok masrflı bir mddesel liste hazırladm.", "Çok masraflı bir maddesel liste hazırladım."],
  ["Yeni çizien rapou zamanpa inceledik.", "Yeni çizilen raporu zamanla inceledik."],
  ["Bu kitap üzerined uzun uzun konuştuk.", "Bu kitap üzerinde uzun uzun konuştuk."],
  ["Çok çalışıyrum ama siparşim henüz gelmedi.", "Çok çalışıyorum ama siparişim henüz gelmedi."],
  ["Bu fikirden vaz geçtim ama zaman kayıp ettim.", "Bu fikirden vazgeçtim ama zaman kaybettim."],
  ["Kendimi iyi his ediyorum, bunu ön gördüm.", "Kendimi iyi hissediyorum, bunu öngördüm."],
  ["Durumu hemen farkettim ama evi terketti.", "Durumu hemen fark ettim ama evi terk etti."],
  ["Başvuru kabuledildi, çalışma devamediyor.", "Başvuru kabul edildi, çalışma devam ediyor."],
  ["Bu durumu siz de hisettiniz mi?", "Bu durumu siz de hissettiniz mi?"],
  ["Haftasonu yurtiçi seyahatimiz git gide uzadı.", "Hafta sonu yurt içi seyahatimiz gitgide uzadı."],
  ["Mağazaya hoşgeldiniz, bizimde haberimiz oldu.", "Mağazaya hoş geldiniz, bizim de haberimiz oldu."],
  ["Çok üzülsede istemesede bunu kabullendi.", "Çok üzülse de istemese de bunu kabullendi."],
  ["Böyle bir ihtimalide göz önünde bulundurduk.", "Böyle bir ihtimali de göz önünde bulundurduk."],
  ["Burası Ankara'dada bilinir, Çin'dirki meşhurdur.", "Burası Ankara'da da bilinir, Çin'dir ki meşhurdur."],
  // v8 user-reported short words, misplaced space, two-error combos, vowel drops, and TDK place-name apostrophes
  ["Dün bne eve geç geldim.", "Dün ben eve geç geldim."],
  ["Bu akşam ane eve geldi.", "Bu akşam anne eve geldi."],
  ["Bugün ann e erken geldi.", "Bugün anne erken geldi."],
  ["Bunu neden yapmıyorsunanlamadim.", "Bunu neden yapmıyorsun anlamadım."],
  // Pronoun + "de" before a verb of the same person is the conjunction; before a third-person verb it is locative.
  ["Dün akşam bende geldim.", "Dün akşam ben de geldim."],
  ["Bizde gittik oraya.", "Biz de gittik oraya."],
  ["Kitap bende kaldı.", "Kitap bende kaldı."],
  // Spoken "bişey" is written "bir şey".
  ["Bişey yazıyorum ama düzeltmiyor.", "Bir şey yazıyorum ama düzeltmiyor."],
  ["hiçbişey olmadı", "hiçbir şey olmadı"],
  // Missed letters and swapped vowels (measured on synthetic chat data, half A tuned / half B checked).
  ["Mesela burada nuler oluyor?", "Mesela burada neler oluyor?"],
  ["Mesela brada neler oluyor?", "Mesela burada neler oluyor?"],
  ["Şuna bir bka.", "Şuna bir bak."],
  ["Bu aralar çok çalşıyorum.", "Bu aralar çok çalışıyorum."],
  // Was kept only to avoid "görürüz" (a dropped "ş"); a Turkish letter is now kept, so the missed "ü" is restored.
  ["Yarın akşam görüşrüz.", "Yarın akşam görüşürüz."],
  ["Kitap bende kaldı.", "Kitap bende kaldı."],
  // A doubled suffix is not a second word: "değildirdir" must not become "değil dırdır".
  ["Bu iyi değildirdir.", "Bu iyi değildirdir."],
  ["Yarın ne yapacağını biliyormusunm?", "Yarın ne yapacağını biliyor musun?"],
  ["Birazdan yanına geliyorm.", "Birazdan yanına geliyorum."],
  ["Bunu tek başıma yapabilirm.", "Bunu tek başıma yapabilirim."],
  ["İstersen yarın eve gidebilirm.", "İstersen yarın eve gidebilirim."],
  ["Yoldayım birazdan gelyorm.", "Yoldayım birazdan geliyorum."],
  ["Bu proje üzerinde çok çalışıyrm.", "Bu proje üzerinde çok çalışıyorum."],
  ["Bu anlaşma ABDde ve ABDnin tarihinde önemlidir.", "Bu anlaşma ABD'de ve ABD'nin tarihinde önemlidir."],
  ["Gemi Marmara Denizinin ortasından geçti.", "Gemi Marmara Denizi'nin ortasından geçti."],
  ["Ankara, Türkiye Cumhuriyetinin başkentidir.", "Ankara, Türkiye Cumhuriyeti'nin başkentidir."],
  ["Ailem Kadıköy Mahallesinde oturuyor.", "Ailem Kadıköy Mahallesi'nde oturuyor."],
  ["Yazın Van Gölünde ve Ağrı Dağının eteklerinde gezdik.", "Yazın Van Gölü'nde ve Ağrı Dağı'nın eteklerinde gezdik."],
  ["Akşam İstiklal Caddesinde yürüyüş yaptık.", "Akşam İstiklal Caddesi'nde yürüyüş yaptık."],
  ["Dugonglar Büyük Okyanusta yaşarlar.", "Dugonglar Büyük Okyanus'ta yaşarlar."],
  ["Belge Osmanlı Devletinin arşivindedir.", "Belge Osmanlı Devleti'nin arşivindedir."],
  ["Ülke Avrupa Birliğine resmen başvurdu.", "Ülke Avrupa Birliği'ne resmen başvurdu."],
];

const extraKeeps = [
  "Kimmiş o kapıdaki?",
  "Her neyse, bunu sonra konuşuruz.",
  "İkinizin de gelmesi gerekiyor.",
  "Giyside küçük bir leke vardı.",
  "Ekimde havalar yavaş yavaş soğur.",
  "Bu işin cabası da var.",
  "Yapay zekâyı kolluyor, ona yardımcı oluyorduk.",
  "Düğmeye basınız lütfen.",
  "Toplantıya Asil'in ekibi de katıldı.",
  "Bu saat mi doğru gösteriyor?",
  "Sırpları ve Müslümanlara yapılan yardımları anlattı.",
  "Hırvatçadan çevrilen metni okuduk.",
  "Ta çocukluğundan beri burada yaşar.",
  "O dönemin Japonlarının etkisi büyüktür.",
  "Bu gelenek eski Yunanlardandır.",
  "Yazar Mortimer'i bu bölümde yeniden anlattı.",
  "Prens Morza Bagrim bu bölgede uzun süre kaldı.",
  "Akciğerdeki alveolusun yapısı mikroskopla incelendi.",
  "Bu breki maçı belirledi.",
  "Aynı durum başka bölgedelerde görüldü.",
  // v7 precision guards
  "Danimarkacada bu sözcük farklı kullanılır.",
  "Macbeth'inde ve Sözlük'ünde aynı tema işlenir.",
  "Fatimi devleti tarih kitaplarında anlatılır.",
  "Dekolmanı ameliyatla tedavi edildi.",
  "Bu işin olmağı zor görünüyor.",
  "İnsan bazen lmre gibi yazımlar görür.",
  // v8 precision & TDK institution guards
  "Ann e mektup göndermek istedi.",
  "Bu ne de güzel, o da geldi.",
  "Dün ben bir an şu ne dedim.",
  "Öğrenci Ankara Üniversitesinde okuyor.",
  "Lider Adalet Partisinin kararını açıkladı.",
  "Yüksek Seçim Kurulunun verileri yayımlandı.",
  "Bu rapor Amerikan Psikiyatri Birliğinin çalışmasıdır.",
  "Mezun olduğu Kabataş Erkek Lisesinin takımında oynadı.",
  "Bu maç Superbowl akşamında izlendi.",
  "Hımm, bu fikri daha önce düşünmemiştim.",
];

for (const [input, want] of extraFixes) {
  test(`fixes (v5): ${input}`, { skip: (!corrector || noMorphology) && "lexicon or morphology not built" }, () => {
    const once = corrector!.correct(input).text;
    assert.equal(once, want);
    assert.equal(corrector!.correct(once).text, once);
  });
}
for (const input of extraKeeps) {
  test(`keeps (v5): ${input}`, { skip: (!corrector || noMorphology) && "lexicon or morphology not built" }, () => {
    assert.equal(corrector!.correct(input).text, input);
  });
}

test("letters autocorrect wrote don't count as typed with a Turkish keyboard", { skip: !corrector && "lexicon not built" }, () => {
  // "Açık" was "Acik" before autocorrect fixed it; the rest of the sentence is still typed without Turkish letters.
  const text = "Açık deniz boru hatti ";
  assert.equal(corrector!.correct(text, { autoMarked: [[0, 4]] }).text, "Açık deniz boru hattı ");
  // Typed by the user with a Turkish keyboard: "hatti" is left alone.
  assert.equal(corrector!.correct(text).text, text);
});

test("two-word listed fixes also match when typed without Turkish letters", { skip: !corrector && "lexicon not built" }, () => {
  assert.equal(corrector!.correct("Yarin gelecekmisin, hic bir sey yok.").text, "Yarın gelecek misin, hiçbir şey yok.");
  assert.equal(corrector!.correct("bir cok insan geldi").text, "birçok insan geldi");
});

test("ol- after a participle is a helper verb, not öl-", { skip: !corrector && "lexicon not built" }, () => {
  assert.equal(corrector!.correct("Ona yardim ediyor oluyorduk.").text, "Ona yardım ediyor oluyorduk.");
  assert.equal(corrector!.correct("Ona yardım ediyor oluyorduk.").text, "Ona yardım ediyor oluyorduk.");
});

test("a unique valid mark variant keeps its lower bar when plain restoration also proposes it", { skip: !corrector && "lexicon not built" }, () => {
  assert.equal(corrector!.correct("bu cihaz neden duzeltmiyor").text, "bu cihaz neden düzeltmiyor");
});

test("context model v2 features, packing, and per-regime contextOffsets", async () => {
  const unigrams = [
    "oldu\t5000\t10",
    "öldü\t2000\t10",
    "uç\t1000\t5",
    "üç\t8000\t20",
    "bende\t10000\t50",
    "ben\t50000\t200",
    "de\t500000\t1000",
    "ev\t10000\t100",
    "evde\t8000\t50",
    "geldi\t20000\t100",
    "adam\t5000\t50",
    "cok\t10\t0",
    "çok\t100000\t500",
  ].join("\n");
  const bigrams = ["ben de\t15000", "ev de\t120"].join("\n");
  const analysesMap = new Map<string, readonly WordAnalysis[]>([
    ["oldu", [{ stem: "ol", pos: "Verb", morphemes: ["Past", "A3sg"] }]],
    ["öldü", [{ stem: "öl", pos: "Verb", morphemes: ["Past", "A3sg"] }]],
    ["evde", [{ stem: "ev", pos: "Noun", morphemes: ["A3sg", "Loc"] }]],
    ["ev", [{ stem: "ev", pos: "Noun", morphemes: ["A3sg"] }]],
    ["ben", [{ stem: "ben", pos: "Pron", morphemes: ["A1sg"] }]],
    ["bende", [{ stem: "ben", pos: "Pron", morphemes: ["A1sg", "Loc"] }]],
  ]);
  const morph: WordValidator = {
    isWord: (form) => analysesMap.has(form),
    analyze: (form) => analysesMap.get(form) ?? [],
  };
  const lex = Lexicon.fromTsv(unigrams, bigrams, 1, 1);

  // 8-bit morphology feature mask matches scripts/extract-morph-features.ts
  assert.equal(morphFeatureBits("oldu", morph), 1 | 2 | 128); // valid + Verb + Past (finite)
  assert.equal(morphFeatureBits("evde", morph), 1 | 4 | 32); // valid + Noun + Loc
  assert.equal(morphFeatureBits("ben", morph), 1 | 16); // valid + Pron
  assert.equal(morphFeatureBits("yokboyle", morph), 0);

  // 18-dim structured feature vector
  const feats = buildContextFeatures(["oldu", "öldü"], "marks", true, lex, morph);
  assert.equal(feats.length, 2);
  assert.equal(feats[0]!.length, FEATURE_DIM);
  assert.equal(feats[0]![1], 0); // most frequent candidate has relative log freq 0
  assert.ok(feats[1]![1]! < 0); // rarer candidate has negative relative log freq
  assert.equal(feats[0]![3], 0); // single word (no space)
  assert.equal(feats[0]![4], 0); // "oldu" has no Turkish marks
  assert.equal(feats[1]![4], 1); // "öldü" has Turkish marks
  assert.equal(feats[0]![5], 1); // asciiContext = true
  assert.equal(feats[0]![6], 1); // kind one-hot: marks = index 0 -> slot 6
  assert.equal(feats[0]![10], 1); // morph valid
  assert.equal(feats[0]![11], 1); // pos_verb
  assert.equal(feats[0]![17], 1); // has_finite

  const packed = pack([{ left: "Adam ", right: ".", candidates: ["oldu", "öldü"], features: feats }]);
  assert.equal(packed.n, 2);
  assert.equal(packed.features.length, 2 * FEATURE_DIM);
  assert.equal(packed.features[FEATURE_DIM + 4], 1);

  // Per-regime contextOffsets: marksAscii uses threshold.context + marksAscii, while marksMarked adds marksMarked.
  const seenAsciiFlags: number[] = [];
  const fakeModel = new ContextModel(async (_tok, _seg, n, features) => {
    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (features) seenAsciiFlags.push(features[i * FEATURE_DIM + 5]!);
      // Candidate 0 (typed) gets 0, candidate 1 (alt) gets 3.5 -> clears ASCII (3.0) but not marked (4.0)
      scores[i] = i % 2 === 1 ? 3.5 : 0;
    }
    return scores;
  });
  const settings = {
    ...CAREFUL,
    threshold: { ...CAREFUL.threshold, context: 3.0 },
    contextOffsets: { marksAscii: 0, marksMarked: 1.0, marksMarkedOnMarked: 2.5, deDaSplit: 0, deDaJoin: 0, kiSplit: 0, kiJoin: 0, miSplit: 0, miJoin: 0 },
  };
  const c = new Corrector(lex, settings, undefined, morph);
  // ASCII sentence (no Turkish marks elsewhere): margin 3.5 >= 3.0 -> fixes "oldu" -> "öldü"
  assert.equal((await c.correctAsync("Adam oldu.", fakeModel)).text, "Adam öldü.");
  // Marked sentence ("çok" has Turkish marks): margin 3.5 < 3.0 + 1.0 -> leaves "oldu" untouched
  assert.equal((await c.correctAsync("Adam çok oldu.", fakeModel)).text, "Adam çok oldu.");
  assert.ok(seenAsciiFlags.includes(1));
  assert.ok(seenAsciiFlags.includes(0));
});

test("Context Model v3: subword packing and typo candidate disambiguation (override, ambiguous, rescue, priorTypoOriginals)", async () => {
  // 1. Subword tokenizer + dynamic packer checks
  const ids1 = encodeSubwords("Ankara'ya giderken GOES-15 verilerini inceledik.");
  assert.ok(ids1.length > 5);
  assert.equal(ids1[0], 4); // <cap> before Ankara
  assert.ok(ids1.includes(5)); // <allcap> before GOES
  assert.ok(ids1.includes(6)); // <num> for 15
  assert.notDeepEqual(encodeSubwords("içinde"), encodeSubwords("için de"));
  assert.notDeepEqual(encodeSubwords("yıllar"), encodeSubwords("yollar"));
  assert.notDeepEqual(encodeSubwords("oldu"), encodeSubwords("öldü"));

  const subPacked = packSubwords([
    { left: "Ondan hiç ", right: " alamadım.", candidates: ["hber", "her", "haber"] },
  ]);
  assert.equal(subPacked.n, 3);
  assert.equal(subPacked.subwords[0], 2n); // <cls> at pos 0
  assert.equal(subPacked.subSegments[0], 1n);
  // Candidate segment (2n) and right segment (3n) must both be present
  assert.ok(Array.from(subPacked.subSegments).includes(2n));
  assert.ok(Array.from(subPacked.subSegments).includes(3n));

  // 2. Synthetic lexicon + morphology covering override (hber->her/haber), ambiguous (etkildi->etkiledi/etkili),
  //    and below-threshold rescue (kesintis->kesintisi)
  const unigrams = [
    "ondan\t5000\t100",
    "hiç\t50000\t200",
    "her\t100000\t500",
    "haber\t10000\t100",
    "alamadım\t2000\t0",
    "film\t8000\t100",
    "beni\t30000\t100",
    "çok\t100000\t100",
    "etkiledi\t1500\t0",
    "etkili\t11800\t0",
    "elektrik\t5000\t100",
    "kesintisi\t80\t0",
    "yüzünden\t8000\t0",
  ].join("\n");
  const validWords = new Set(["ondan", "hiç", "her", "haber", "alamadım", "film", "beni", "çok", "etkiledi", "etkili", "elektrik", "kesintisi", "yüzünden"]);
  const morph: WordValidator = { isWord: (w) => validWords.has(w) };
  const lex = Lexicon.fromTsv(unigrams, "", 1, 1);
  const c = new Corrector(lex, { ...CAREFUL }, undefined, morph);

  // Core without context picks higher-frequency "her" for "hber", leaves tied "etkildi" and rare "kesintis" untouched
  assert.equal(c.correct("Ondan hiç hber alamadım.").text, "Ondan hiç her alamadım.");
  assert.equal(c.correct("Film beni çok etkildi.").text, "Film beni çok etkildi.");
  assert.equal(c.correct("Elektrik kesintis yüzünden.").text, "Elektrik kesintis yüzünden.");

  // Check typoCandidatesFor returns both competing candidates with exact features
  const hberCands = c.typoCandidatesFor("hber", { atSentenceStart: false, textHasMarks: true, questionAhead: false });
  assert.deepEqual(hberCands.map((x) => x.text), ["her", "haber"]);

  const seenLeft: string[] = [];
  const scoreMap: Record<string, number> = {
    hber: -2.0,
    her: 1.0,
    haber: 5.5, // delta over core pick "her" = 4.5 >= contextTypoOverride (2.5)
    etkildi: -2.0,
    etkili: 1.0,
    etkiledi: 4.0, // vsTyped=6.0 >= 2.5, gap=3.0 >= 1.5
    kesintis: -1.5,
    kesintisi: 4.5, // vsTyped=6.0 >= contextTypoRescue (4.5)
  };
  const fakeTypoModel = new ContextModel(
    async (_tok, _seg, n, features, subwords) => {
      assert.ok(subwords && subwords.seqLen >= 4);
      assert.equal(features?.length, n * FEATURE_DIM);
      // Verify kind=typo feature slot 18 is 1
      for (let i = 0; i < n; i++) assert.equal(features![i * FEATURE_DIM + 18], 1);
      // Use a small helper by looking up candidate text via pack() isn't needed if we match via subwords;
      // use a second model below with score() override to inspect exact strings cleanly.
      return new Float32Array(n);
    },
    { subwordsOnly: true },
  );
  // Smoke-check subwordsOnly path runs cleanly
  await c.correctAsync("Ondan hiç hber alamadım.", fakeTypoModel);

  const namedModel = {
    async score(queries: readonly { left: string; right: string; candidates: string[]; features?: readonly (readonly number[])[] }[]) {
      return queries.map((q) => {
        seenLeft.push(q.left);
        return q.candidates.map((cand) => scoreMap[cand] ?? 0);
      });
    },
  } as unknown as ContextModel;

  // 3. Mode T2 (override): switches core's wrong "her" -> "haber"
  assert.equal((await c.correctAsync("Ondan hiç hber alamadım.", namedModel)).text, "Ondan hiç haber alamadım.");
  // When context model is NOT confident enough over core pick, core's pick stands
  scoreMap.haber = 2.0; // delta = 1.0 < contextTypoOverride (1.2)
  assert.equal((await c.correctAsync("Ondan hiç hber alamadım.", namedModel)).text, "Ondan hiç her alamadım.");
  scoreMap.haber = 5.5;

  // 4. Mode T1 (ambiguous): resolves tied "etkildi" -> "etkiledi"
  assert.equal((await c.correctAsync("Film beni çok etkildi.", namedModel)).text, "Film beni çok etkiledi.");

  // 5. Mode T3 (rescue): rescues low-count "kesintis" -> "kesintisi" when confident, leaves untouched if weak
  assert.equal((await c.correctAsync("Elektrik kesintis yüzünden.", namedModel)).text, "Elektrik kesintisi yüzünden.");
  scoreMap.kesintisi = 0.5; // vsTyped = 2.0 < contextTypoRescue (2.5)
  assert.equal((await c.correctAsync("Elektrik kesintis yüzünden.", namedModel)).text, "Elektrik kesintis yüzünden.");

  // 6. TDK SOMBAHCEMİ words ("Mademki", "illaki") are never split by the context model
  const kiLex = Lexicon.fromTsv(
    "mademki\t500\t10\nmadem\t500\t10\nillaki\t500\t0\nilla\t500\t0\nki\t50000\t0\n",
    "",
    1,
    1,
  );
  const kiCorrector = new Corrector(kiLex, { ...CAREFUL }, undefined, morph);
  const splitAllModel = {
    async score(queries: readonly { candidates: string[] }[]) {
      return queries.map((q) => q.candidates.map((_, i) => (i === 0 ? 0 : 10)));
    },
  } as unknown as ContextModel;
  assert.equal((await kiCorrector.correctAsync("Mademki geldin, illaki konuşalım.", splitAllModel)).text, "Mademki geldin, illaki konuşalım.");

  // 6. Pause-pass priorTypoOriginals: "her" (originally typed "hber") is re-evaluated with full sentence -> "haber"
  const pauseText = "Ondan hiç her alamadım.";
  const herStart = pauseText.indexOf("her");
  const pauseRes = await c.correctAsync(pauseText, namedModel, {
    priorTypoOriginals: [{ start: herStart, end: herStart + 3, original: "hber" }],
  });
  assert.equal(pauseRes.text, "Ondan hiç haber alamadım.");

  // 7. Core-restored context: earlier core mark fix ("cok" -> "çok") is cleaned in `left` seen by context model
  seenLeft.length = 0;
  await c.correctAsync("Film beni cok etkildi.", namedModel);
  assert.ok(seenLeft.some((l) => l.includes("çok")), `expected core-restored 'çok' in left context, got: ${JSON.stringify(seenLeft)}`);
});
