import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Corrector, type WordAnalysis, type WordValidator } from "./corrector.ts";
import { KnownMisspellings } from "./known.ts";
import { Lexicon } from "./lexicon.ts";
import {
  collapsedDoubledLocative,
  fixDisharmoniousApostropheSuffix,
  harmonizeQuestionParticle,
  hasBlockedApostropheStem,
  isHarmoniousApostropheMarkChange,
  isValidGenericApostrophe,
  isValidKnownParticleSuffix,
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
  "Yarın akşam görüşrüz.",
  "İnsan bazen lmre gibi yazımlar görür.",
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
