import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_FIX_KINDS, applyFixes, createTdkai, type Fix, type RawData } from "../src/index.ts";

/** Eşik testleri tek kelimeyle çalışır: cümle başı büyük harfi (noktalama türü) bu testlerin konusu değil. */
const NO_PUNCT = { kinds: ALL_FIX_KINDS.filter((kind) => kind !== "noktalama" && kind !== "kisaltma") };

/** Testler için elle yazılmış küçük sözlük. */
const TEST_DATA: RawData = {
  unigrams: [
    "bugün\t8000\t100",
    "çok\t10000\t100",
    "yorgunum\t500\t0",
    "nasıl\t5000\t50",
    "yarın\t3000\t100",
    "ankara\t50000\t49000",
    "ankara'ya\t4000\t3900",
    "gidiyorum\t2000\t0",
    "sen\t20000\t100",
    "geldin\t1500\t0",
    "ev\t10000\t100",
    "de\t500000\t1000",
    "evde\t8000\t50",
    "kaldım\t3000\t0",
    "bir\t100000\t500",
    "şey\t50000\t100",
    "hiç\t40000\t100",
    "hiçbir\t20772\t100",
    "fikrim\t1000\t0",
    "yok\t30000\t100",
    "ama\t80000\t200",
    "herkes\t3709\t50",
    "maalesef\t242\t10",
    "geldi\t20000\t100",
    "yapabilir\t15000\t10",
    "miyiz\t1000\t0",
    "bunu\t25000\t100",
    "soz\t5\t0",
    "söz\t80\t0",
    "uc\t25\t0",
    "uç\t2500\t0",
    "nokta\t5000\t0",
    "değil\t20000\t50",
  ].join("\n"),
  bigrams: [
    "ev de\t10",
    "bir şey\t5325",
    "hiç bir\t45",
  ].join("\n"),
  known: [
    "# wrong\tright\twrong_count\tright_count\tsection",
    "herkez\therkes\t0\t3709\tMISSPELLINGS",
    "malesef\tmaalesef\t3\t242\tMISSPELLINGS",
    "birşey\tbir şey\t4\t5325\tMISSPELLINGS",
    "hiç bir\thiçbir\t45\t20772\tMISSPELLINGS",
  ].join("\n"),
};

describe("autr çekirdek API", () => {
  it("dört hata türünü de doğru biçimde yakalar ve uygular", async () => {
    const autr = createTdkai(TEST_DATA);
    try {
      const text =
        "Bugün cok yorgunum. Yarın Ankaraya gidiyorum. Birşey yok ama hiç bir fikrim yok. Herkez geldi, malesef yapabiliur miyiz bunu? Sen geldinmi? Ev de kaldım.";
      const fixes = await autr.check(text);

      // Çakışmaz ve sıralıdır
      for (let i = 1; i < fixes.length; i++) {
        assert.ok(fixes[i - 1]!.to <= fixes[i]!.from, "düzeltmeler çakışmamalı");
      }

      // Her düzeltmenin güven değeri 0..1 arasında ve konumu metinle bire bir uyumlu
      for (const fix of fixes) {
        assert.equal(text.slice(fix.from, fix.to), fix.original);
        assert.ok(fix.confidence >= 0 && fix.confidence <= 1, `geçersiz confidence: ${fix.confidence}`);
        assert.ok(ALL_FIX_KINDS.includes(fix.kind));
      }

      const byOriginal = new Map(fixes.map((fix) => [fix.original, fix]));
      assert.equal(byOriginal.get("cok")?.replacement, "çok");
      assert.equal(byOriginal.get("cok")?.kind, "turkce-karakter");

      assert.equal(byOriginal.get("Ankaraya")?.replacement, "Ankara'ya");
      assert.equal(byOriginal.get("Ankaraya")?.kind, "kesme");

      assert.equal(byOriginal.get("Birşey")?.replacement, "Bir şey");
      assert.equal(byOriginal.get("Birşey")?.kind, "bitisik-ayri");

      assert.equal(byOriginal.get("hiç bir")?.replacement, "hiçbir");
      assert.equal(byOriginal.get("hiç bir")?.kind, "bitisik-ayri");

      assert.equal(byOriginal.get("geldinmi")?.replacement, "geldin mi");
      assert.equal(byOriginal.get("geldinmi")?.kind, "bitisik-ayri");

      assert.equal(byOriginal.get("Ev de")?.replacement, "Evde");
      assert.equal(byOriginal.get("Ev de")?.kind, "bitisik-ayri");

      assert.equal(byOriginal.get("Herkez")?.replacement, "Herkes");
      assert.equal(byOriginal.get("Herkez")?.kind, "yazim");

      assert.equal(byOriginal.get("malesef")?.replacement, "maalesef");
      assert.equal(byOriginal.get("malesef")?.kind, "yazim");

      assert.equal(byOriginal.get("yapabiliur")?.replacement, "yapabilir");
      assert.equal(byOriginal.get("yapabiliur")?.kind, "yazim");

      const applied = autr.apply(text, fixes);
      assert.equal(
        applied,
        "Bugün çok yorgunum. Yarın Ankara'ya gidiyorum. Bir şey yok ama hiçbir fikrim yok. Herkes geldi, maalesef yapabilir miyiz bunu? Sen geldin mi? Evde kaldım.",
      );
      assert.equal(await autr.fix(text), applied);
    } finally {
      await autr.dispose();
    }
  });

  it("kinds seçeneği ile yalnızca istenen türleri döndürür", async () => {
    const autr = createTdkai(TEST_DATA);
    try {
      const text = "Bugün cok yorgunum, Ankaraya birşey ve herkez geldi.";

      const onlyMarks = await autr.check(text, { kinds: ["turkce-karakter"] });
      assert.deepEqual(
        onlyMarks.map((fix) => [fix.original, fix.replacement, fix.kind]),
        [["cok", "çok", "turkce-karakter"]],
      );

      const onlySpacing = await autr.check(text, { kinds: ["bitisik-ayri"] });
      assert.deepEqual(
        onlySpacing.map((fix) => [fix.original, fix.replacement, fix.kind]),
        [["birşey", "bir şey", "bitisik-ayri"]],
      );

      const onlySpelling = await autr.check(text, { kinds: ["yazim"] });
      assert.deepEqual(
        onlySpelling.map((fix) => [fix.original, fix.replacement, fix.kind]),
        [["herkez", "herkes", "yazim"]],
      );

      const empty = await autr.check(text, { kinds: [] });
      assert.deepEqual(empty, []);
    } finally {
      await autr.dispose();
    }
  });

  it("range yalnızca ilgili aralığı kontrol eder ama bağlamı tüm metinden okur", async () => {
    const autr = createTdkai(TEST_DATA);
    try {
      // 1) İkinci cümledeki kelime aralığı, ilk cümledeki hatayı döndürmez
      const sentence = "Bugün cok yorgunum. Yarın Ankaraya gidiyorum.";
      const ankaraStart = sentence.indexOf("Ankaraya");
      const ankaraEnd = ankaraStart + "Ankaraya".length;
      const ankaraFixes = await autr.check(sentence, { range: [ankaraStart, ankaraEnd] });
      assert.equal(ankaraFixes.length, 1);
      assert.equal(ankaraFixes[0]!.original, "Ankaraya");
      assert.equal(ankaraFixes[0]!.replacement, "Ankara'ya");

      // 2) Soru işareti aralık dışında kalsa bile soru eki bağlamdan anlaşılır
      const question = "Sen geldinmi?";
      const qStart = question.indexOf("geldinmi");
      const qEnd = qStart + "geldinmi".length;
      const qFixes = await autr.check(question, { range: [qStart, qEnd] });
      assert.equal(qFixes.length, 1);
      assert.equal(qFixes[0]!.replacement, "geldin mi");

      // 3) Metnin geri kalanında Türkçe karakter olması bağlam olarak okunur
      const withoutMarks = await autr.check("uc nokta", { range: [0, 2] });
      assert.equal(withoutMarks.length, 1);
      assert.equal(withoutMarks[0]!.replacement, "Uç"); // metnin başı: büyük harf de aynı düzeltmeye katılır

      const withMarksElsewhere = await autr.check("uc nokta değil", { range: [0, 2] });
      // Türkçe karakter eklenmez; metnin başı olduğu için yalnızca büyük harf önerilir ("Uc").
      assert.deepEqual(withMarksElsewhere.map((fix) => [fix.replacement, fix.kind]), [["Uc", "noktalama"]]);

      // 4) İki kelimelik birleştirme, ikinci kelime aralığı verildiğinde yakalanır
      const joinText = "Ev de kaldım.";
      const deStart = joinText.indexOf("de");
      const deFixes = await autr.check(joinText, { range: [deStart, deStart + 2] });
      assert.equal(deFixes.length, 1);
      assert.equal(deFixes[0]!.original, "Ev de");
      assert.equal(deFixes[0]!.replacement, "Evde");

      // 5) Boş aralıkta sonuç boştur
      assert.deepEqual(await autr.check(sentence, { range: [5, 5] }), []);
    } finally {
      await autr.dispose();
    }
  });

  it("careful ve balanced kipleri arasındaki eşik farkını uygular", async () => {
    const careful = createTdkai(TEST_DATA, { mode: "careful" });
    const balanced = createTdkai(TEST_DATA, { mode: "balanced" });
    try {
      // "soz" (5) -> "söz" (80): careful eşiğinin altında, balanced eşiğinin üstünde
      assert.equal(await careful.fix("soz", NO_PUNCT), "soz");
      assert.equal(await balanced.fix("soz", NO_PUNCT), "söz");

      // Çağrı bazlı mode geçersiz kılma ve setMode desteği
      assert.equal(await careful.fix("soz", { ...NO_PUNCT, mode: "balanced" }), "söz");
      assert.equal(await careful.fix("soz", NO_PUNCT), "soz");

      careful.setMode("balanced");
      assert.equal(await careful.fix("soz", NO_PUNCT), "söz");
    } finally {
      await careful.dispose();
      await balanced.dispose();
    }
  });

  it("ignore ve unignore Türkçe büyük/küçük harf duyarsız çalışır", async () => {
    const autr = createTdkai(TEST_DATA);
    try {
      autr.ignore("Herkez");
      assert.equal(await autr.fix("Herkez ve herkez geldi."), "Herkez ve herkez geldi.");

      autr.unignore("herkez");
      assert.equal(await autr.fix("Herkez geldi."), "Herkes geldi.");
    } finally {
      await autr.dispose();
    }
  });

  it("satır içi ve blok kod parçalarına dokunmaz", async () => {
    const autr = createTdkai(TEST_DATA);
    try {
      const text = "Bugün cok iyiyim ama `cok herkez` ve\n```\ncok herkez\n```\ndokunulmaz.";
      const fixes = await autr.check(text);
      assert.deepEqual(
        fixes.map((fix) => [fix.from, fix.original, fix.replacement]),
        [[6, "cok", "çok"]],
      );
    } finally {
      await autr.dispose();
    }
  });

  it("apply uyuşmayan veya çakışan düzeltmelerde hata fırlatır", () => {
    const wrongOriginal: Fix = {
      from: 0,
      to: 3,
      original: "xyz",
      replacement: "abc",
      kind: "yazim",
      confidence: 0.9,
      scope: "kelime",
    };
    assert.throws(() => applyFixes("cok", [wrongOriginal]));

    const overlapping: Fix[] = [
      { from: 0, to: 3, original: "cok", replacement: "çok", kind: "turkce-karakter", confidence: 0.9, scope: "kelime" },
      { from: 2, to: 5, original: "k y", replacement: "k z", kind: "yazim", confidence: 0.9, scope: "baglam" },
    ];
    assert.throws(() => applyFixes("cok y", overlapping));
  });

  it("dispose sonrası kullanım hata fırlatır", async () => {
    const autr = createTdkai(TEST_DATA);
    await autr.dispose();
    await assert.rejects(() => autr.check("cok"));
  });

  it("noktalama türünde özel ad, kurum, sayı eki ve kesme kurallarını uygular", async () => {
    const dataWithNames: RawData = {
      ...TEST_DATA,
      known: [
        TEST_DATA.known,
        "ankara\tAnkara\t0\t50000\tNAME",
        "türkçe\tTürkçe\tnoapos\t40000\tNAME",
        "türk dil kurumu\tTürk Dil Kurumu\t0\t10000\tPHRASE_NOAPOS",
      ].join("\n"),
    };
    const autr = createTdkai(dataWithNames);
    try {
      const text = "dün türk dil kurumuna geldi.yarın 1985te ankaraya gidiyorum, türkçe'yi sevdik.";
      const fixes = await autr.check(text, { kinds: ["noktalama"] });
      assert.ok(fixes.length > 0);
      for (const fix of fixes) {
        assert.equal(fix.kind, "noktalama");
      }
      assert.equal(
        autr.apply(text, fixes),
        "Dün Türk Dil Kurumuna geldi. Yarın 1985'te Ankara'ya gidiyorum, Türkçeyi sevdik.",
      );
      // noktalama kapalıyken bu değişiklikler yapılmaz
      assert.equal(await autr.fix("1985te ankaraya geldik.", NO_PUNCT), "1985te ankaraya geldik.");
    } finally {
      await autr.dispose();
    }
  });
});
