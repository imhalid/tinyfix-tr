import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";
import { encodeBinaryDictionary } from "./binary.ts";
import { parseDictionaries } from "./dictionary.ts";
import { MorphPrior, TurkishMorphology, turkishEditCost } from "./index.ts";

const DICT_PATHS = [
  "data/morph/master-dictionary.dict",
  "data/morph/non-tdk.dict",
  "data/morph/informal.dict",
  "data/morph/proper.dict",
] as const;

const dictTexts = DICT_PATHS.map((p) => readFileSync(p, "utf8"));

const loadStart = performance.now();
const morph = TurkishMorphology.fromDictionaries(dictTexts);
const loadMs = performance.now() - loadStart;

function loadWordList(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("TurkishMorphology", () => {
  test("loads Zemberek dictionaries quickly", () => {
    console.log(`[morphology] dictionary load time: ${loadMs.toFixed(1)} ms`);
    assert.ok(morph.isWord("ev"));
  });

  test("accepts all required valid forms from specification", () => {
    const validWords = [
      "düşünmüştün",
      "getirsek",
      "ekmemi",
      "yatıyorsun",
      "olmuştun",
      "yorumumu",
      "kitabımı",
      "öyküsüz",
      "araştırtmaya",
      "açkılanmayan",
      "gidecekmişsin",
      "yapamayacaklarımızdan",
      "evdekiler",
      "kitapçılardan",
      "ağzımızı",
      "burnundan",
      "diyordum",
      "yiyeceksin",
      // Additional valid examples mentioned in GOREV4.md
      "soyumdan",
      "anlaşayım",
      "göndertme",
      "getirdiğimi",
      "yapmamı",
      "olduğumu",
    ];

    for (const word of validWords) {
      assert.equal(morph.isWord(word), true, `expected valid word to be accepted: "${word}"`);
    }
  });

  test("rejects all required invalid forms from specification", () => {
    const invalidWords = [
      "seyehat",
      "herkez",
      "yalnış",
      "yanlız",
      "malesef",
      "orjinal",
      "birşey",
      "herşey",
      "geliyom",
      "gelyorum",
      "yapabiliur",
      "kazanackasın",
    ];

    for (const word of invalidWords) {
      assert.equal(morph.isWord(word), false, `expected invalid word to be rejected: "${word}"`);
    }
  });

  test("rejects attached question particles, attached conjunctions, colloquial drops, and bad phonology", () => {
    const rejected = [
      // Attached question particle (mi/mı/mu/mü)
      "geldinmi",
      "gidecekmisin",
      "varmı",
      "yokmu",
      "değilmi",
      "biliyormusun",
      // Attached conjunctions (de/da/ki)
      "olsada",
      "yinede",
      "dahada",
      "nasılda",
      "öylemi",
      "iyiki",
      "demekki",
      "tabiki",
      // Colloquial vowel-drop contractions
      "burda",
      "şurda",
      "orda",
      "içerde",
      "dışarda",
      "yukarda",
      "ilerde",
      // Phonological / morphotactic violations
      "kitapı",
      "kitapım",
      "kitablar",
      "kitabta",
      "evte",
      "evlar",
      "masaler",
      "gitecek",
      "gitiyor",
      // "bene" çıkarıldı: TDK sözlüğünde gerçek bir kelime (menengiç), Zemberek de tanıyor.
      "yeyen",
      "diyer",
      "evdekiyi",
      "evdekide",
      // Incomplete modified stems (CannotTerminate)
      "kitab",
      "ağz",
      "burn",
      "hakk",
      "gid",
    ];

    for (const word of rejected) {
      assert.equal(morph.isWord(word), false, `expected invalid form to be rejected: "${word}"`);
    }
  });

  test("handles Turkish phonology: harmony, assimilation, voicing, vowel drop, doubling, buffers, irregulars", () => {
    const valid = [
      // Vowel harmony (including InverseHarmony)
      "evler",
      "masalar",
      "gözlerim",
      "kolumuz",
      "saatler",
      "kalpler",
      "kalbim",
      "hayallerim",
      // Consonant assimilation (d/t, c/ç)
      "kitapta",
      "kitaptan",
      "kitapçı",
      "evde",
      "evden",
      "yaptı",
      "geldi",
      "seçti",
      "gitmişti",
      // Consonant voicing & NoVoicing exceptions
      "kitabı",
      "ağacı",
      "rengi",
      "dengi",
      "çocuğu",
      "genci",
      "dermatoloğu",
      "gidiyor",
      "ediyor",
      "hukuku",
      "holdingi",
      // Vowel drop (nouns and LastVowelDrop verbs)
      "burnu",
      "ağzı",
      "oğlum",
      "şehrimizde",
      "aklında",
      "gönlüm",
      "ömrümüz",
      "kıvrıldı",
      "kavruldu",
      // Consonant doubling
      "hakkı",
      "hakkımızda",
      "affına",
      "tıbbı",
      "reddi",
      "zıddı",
      "hissi",
      // Buffer consonants (y, n, s) & compounds
      "arabayı",
      "arabaya",
      "arabası",
      "arabasını",
      "arabanın",
      "buzdolabına",
      "buzdolapları",
      "buzdolabım",
      "anaokulunda",
      // Irregulars (ben/sen, demek/yemek, ne, su)
      "bana",
      "sana",
      "benim",
      "bizim",
      "bizlerin",
      "onunla",
      "bununla",
      "neyi",
      "neye",
      "neyin",
      "nesini",
      "nesine",
      "diyor",
      "diyorum",
      "yiyor",
      "yiyecek",
      "deyince",
      "yiyince",
      "deyip",
      "yiyip",
      "suyu",
      "suyun",
      "suyumuz",
      "akarsuyun",
    ];

    for (const word of valid) {
      assert.equal(morph.isWord(word), true, `expected phonologically valid word: "${word}"`);
    }
  });

  test("handles nominal inflection, -ki, copula (ek-fiil), -ken, and derivations", () => {
    const valid = [
      // Plural, 6 possessives, all cases
      "ev",
      "evim",
      "evin",
      "evi",
      "evimiz",
      "eviniz",
      "evleri",
      "evimi",
      "evine",
      "evinde",
      "evinden",
      "evinin",
      "evimle",
      "evce",
      // -ki (locative, time, genitive) + pronominal case/plural
      "evdeki",
      "evdekini",
      "evdekine",
      "evdekinde",
      "evdekinden",
      "evdekinin",
      "evdekileri",
      "evdekilerden",
      "dünkü",
      "dünküler",
      "yarınki",
      "benimki",
      "benimkini",
      "masanınki",
      // Copula & -ken
      "öğretmenim",
      "öğretmensin",
      "öğretmendir",
      "öğretmendi",
      "öğretmenmiş",
      "öğretmense",
      "evdeyim",
      "evdeydik",
      "evdeymiş",
      "evdeyken",
      "çocukken",
      "değilim",
      "değildi",
      "değilmiş",
      "değilse",
      "değildir",
      "nasılsın",
      "öyleydi",
      // Derivations: -li, -siz, -lik, -ci, -ce, -cik, -daş, -sal
      "evli",
      "evsiz",
      "insanlık",
      "güzelliği",
      "kitapçı",
      "yavaşça",
      "insanca",
      "evcik",
      "kedicik",
      "meslektaş",
      "yurttaş",
      "sınıftaş",
      "köydeşlerimizden",
      "odadaş",
      "tarihsel",
      "toplumsal",
      "bilimsel",
    ];

    for (const word of valid) {
      assert.equal(morph.isWord(word), true, `expected valid nominal form: "${word}"`);
    }
  });

  test("handles verbal inflection, compound tenses, participles, converbs, and voice chaining", () => {
    const valid = [
      // Tenses, negation, imperative, ability, compound tenses
      "geliyorum",
      "geliyorsun",
      "geliyor",
      "geliyoruz",
      "geliyorsunuz",
      "geliyorlar",
      "gelmiyorum",
      "geleceğim",
      "geleceksin",
      "gelmeyeceğim",
      "geldim",
      "geldin",
      "geldik",
      "geldiniz",
      "geldiler",
      "gelmedim",
      "gelmişim",
      "gelmişsin",
      "gelir",
      "gelirim",
      "gelmem",
      "gelmez",
      "gelmezsin",
      "gelmeyiz",
      "gelmeli",
      "gelmeliyim",
      "gelse",
      "gelsem",
      "gelsek",
      "gelseydim",
      "geleyim",
      "gelelim",
      "gel",
      "gelsin",
      "gelin",
      "geliniz",
      "gelsinler",
      "gelebilirim",
      "gelemem",
      "gelemiyorum",
      "gelemeyeceğim",
      "geliyordum",
      "gelecektim",
      "gelmiştin",
      "gelirdi",
      "gelmezdi",
      "gelmeliydi",
      "arıyorum",
      "bekliyor",
      "okuyorum",
      // Verbal nouns, participles, converbs + nominal suffixes
      "gelme",
      "gelmemi",
      "gelmek",
      "gelmekten",
      "gelmekte",
      "gelmekle",
      "gelmekteyim",
      "geldik",
      "geldiğim",
      "gelecek",
      "gelen",
      "gelenlerden",
      "gelip",
      "gelmeyip",
      "gelerek",
      "gelmeyerek",
      "gelince",
      "gelmeyince",
      "gelmeden",
      "gelemeden",
      "geldikten",
      "yaptıktan",
      "geldikçe",
      "gelmedikçe",
      "gelirken",
      "geliyorken",
      "gelecekken",
      // Voice: passive, causative (+ chaining), reflexive, reciprocal
      "yapıldı",
      "yapılıyor",
      "yazılmış",
      "aranıyor",
      "alındı",
      "bilinen",
      "silindi",
      "denildi",
      "yeniyor",
      "yaptırdı",
      "yaptırttı",
      "okuttu",
      "okutturdu",
      "araştırttı",
      "bitirdi",
      "düşürdü",
      "yıkandı",
      "giyindi",
      "tarandı",
      "görüştük",
      "yazışıyorlar",
      "tanıştık",
    ];

    for (const word of valid) {
      assert.equal(morph.isWord(word), true, `expected valid verbal form: "${word}"`);
    }
  });

  test("analyze() returns structured stem, pos, and morphemes", () => {
    const samples = [
      { word: "kitabımı", expectedStem: "kitap", expectedPos: "Noun" },
      { word: "gidecekmişsin", expectedStem: "git", expectedPos: "Verb" },
      { word: "araştırtmaya", expectedStem: "araştır", expectedPos: "Verb" },
      { word: "evdekiler", expectedStem: "ev", expectedPos: "Noun" },
      { word: "diyordum", expectedStem: "de", expectedPos: "Verb" },
      { word: "ağzımızı", expectedStem: "ağız", expectedPos: "Noun" },
      { word: "yapamayacaklarımızdan", expectedStem: "yap", expectedPos: "Verb" },
    ] as const;

    for (const { word, expectedStem, expectedPos } of samples) {
      const analyses = morph.analyze(word);
      assert.ok(analyses.length > 0, `expected at least one analysis for "${word}"`);
      const match = analyses.find((a) => a.stem === expectedStem && a.pos === expectedPos);
      assert.ok(
        match !== undefined,
        `expected analysis with stem="${expectedStem}", pos="${expectedPos}" for "${word}", got: ${JSON.stringify(analyses)}`,
      );
      assert.ok(match.morphemes.length > 0, `expected non-empty morphemes for "${word}"`);
    }

    assert.deepEqual(morph.analyze(""), []);
    assert.deepEqual(morph.analyze("seyehat"), []);
    assert.deepEqual(morph.analyze("herkez"), []);
  });

  test("handles Turkish casing, circumflexes, empty input, and minimal custom dictionaries", () => {
    assert.equal(morph.isWord(""), false);
    assert.equal(morph.isWord("İSTANBULDA"), true);
    assert.equal(morph.isWord("GİDECEKMİŞSİN"), true);
    assert.equal(morph.isWord("IŞIKLARDAN"), true);
    assert.equal(morph.isWord("hükûmetten"), true);
    assert.equal(morph.isWord("hükümetten"), true);
    assert.equal(morph.isWord("âcizane"), true);
    assert.equal(morph.isWord("kitâbımı"), false);

    const mini = TurkishMorphology.fromDictionaries(["ev\nkitap\ngelmek [A:Aorist_I]\n"]);
    assert.equal(mini.isWord("evdekiler"), true);
    assert.equal(mini.isWord("kitabımı"), true);
    assert.equal(mini.isWord("geliyordum"), true);
    assert.equal(mini.isWord("masa"), false);
  });

  test("sample-wrong.txt acceptance rate is below 3%", () => {
    const wrongWords = loadWordList("data/morph/sample-wrong.txt");
    assert.ok(wrongWords.length > 0, "sample-wrong.txt should not be empty");

    const accepted: string[] = [];
    for (const word of wrongWords) {
      if (morph.isWord(word)) {
        accepted.push(word);
      }
    }

    const rate = accepted.length / wrongWords.length;
    console.log(
      `[morphology] sample-wrong.txt: ${accepted.length}/${wrongWords.length} accepted (${(rate * 100).toFixed(2)}%)`,
    );
    if (accepted.length > 0) {
      console.log(`[morphology] sample-wrong.txt accepted words: ${accepted.join(", ")}`);
    }

    assert.ok(
      rate < 0.03,
      `sample-wrong.txt acceptance rate ${(rate * 100).toFixed(2)}% (${accepted.length}/${wrongWords.length}) must be < 3%: ${accepted.join(", ")}`,
    );
  });

  test("sample-valid.txt recall and lookup speed report (informational)", () => {
    const validWords = loadWordList("data/morph/sample-valid.txt");
    assert.ok(validWords.length > 0, "sample-valid.txt should not be empty");

    // Measure uncached lookups on a fresh analyzer instance.
    const freshMorph = TurkishMorphology.fromDictionaries(dictTexts);
    let acceptedCount = 0;

    const uncachedStart = performance.now();
    for (const word of validWords) {
      if (freshMorph.isWord(word)) {
        acceptedCount++;
      }
    }
    const uncachedUsPerWord = ((performance.now() - uncachedStart) * 1000) / validWords.length;

    const cachedStart = performance.now();
    for (const word of validWords) {
      freshMorph.isWord(word);
    }
    const cachedUsPerWord = ((performance.now() - cachedStart) * 1000) / validWords.length;

    const rate = (acceptedCount / validWords.length) * 100;
    console.log(
      `[morphology] sample-valid.txt: ${acceptedCount}/${validWords.length} accepted (${rate.toFixed(2)}%) | uncached: ${uncachedUsPerWord.toFixed(2)} us/word | cached: ${cachedUsPerWord.toFixed(2)} us/word`,
    );
  });

  test("binary AMR1 format produces identical isWord() and analyze() results to text .dict", () => {
    const items = parseDictionaries(dictTexts);
    const binaryBytes = encodeBinaryDictionary(items);
    const binStart = performance.now();
    const binMorph = TurkishMorphology.fromBinary(binaryBytes);
    const binLoadMs = performance.now() - binStart;
    console.log(`[morphology] binary AMR1 load time: ${binLoadMs.toFixed(1)} ms (${binaryBytes.byteLength} bytes raw)`);

    const checkWords = [
      ...loadWordList("data/morph/sample-valid.txt"),
      ...loadWordList("data/morph/sample-wrong.txt"),
      "hükûmetten",
      "hükümetten",
      "âcizane",
      "kitâbımı",
      "zeytinyağları",
      "buzdolabım",
      "bana",
      "sana",
      "diyordum",
      "yiyeceksin",
      "birbirimize",
      "çoğumuzdan",
      "saatler",
      "kalbim",
    ];

    for (const word of checkWords) {
      assert.equal(binMorph.isWord(word), morph.isWord(word), `isWord mismatch for "${word}"`);
    }
    for (const word of checkWords.slice(0, 500)) {
      assert.deepEqual(binMorph.analyze(word), morph.analyze(word), `analyze mismatch for "${word}"`);
    }
    for (const word of ["hükûmetten", "zeytinyağları", "bana", "diyordum", "ağzımızı", "evdekiler", "kitabımı"]) {
      assert.deepEqual(binMorph.analyze(word), morph.analyze(word), `analyze mismatch for "${word}"`);
    }
  });

  test("AMR2 binary round-trip preserves MorphPrior counts and suffix-chain probabilities", () => {
    const miniItems = parseDictionaries(["düzenlemek\nkullanmak\ngerek\n"]);
    const prior = new MorphPrior({
      lemmaCounts: new Map([
        ["düzenle|Verb", 75000],
        ["kullan|Verb", 250000],
        ["gerek|Noun", 5000],
      ]),
      chainProbs: new Map([
        ["Verb|Neg+Prog1+A3sg", 0.002],
        ["Verb|Pass+Verb+Prog1+A3sg", 0.0007],
        ["Verb|PastPart+Noun+A3sg+P1sg+Loc", 0.0005],
      ]),
      bigramProbs: new Map([
        ["^Verb>Neg", 0.08],
        ["Neg>Prog1", 0.12],
        ["Prog1>A3sg", 0.45],
        ["A3sg>$", 0.8],
      ]),
    });
    const bytes = encodeBinaryDictionary(miniItems, prior);
    const loaded = TurkishMorphology.fromBinary(bytes);
    assert.equal(loaded.hasPrior, true);
    assert.ok(loaded.isWord("düzenlemiyor"));
    const pNeg = loaded.priorCount("düzenlemiyor");
    const pPass = loaded.priorCount("düzenleniyor");
    assert.ok(pNeg > 100 && pNeg < 220, `expected ~150 for düzenlemiyor, got ${pNeg}`);
    assert.ok(pNeg > pPass, `expected active negative (${pNeg}) > passive (${pPass})`);
    assert.ok(loaded.priorCount("kullandığımda") > 80);
    assert.equal(loaded.priorCount("duzenblemiyor"), 0);
  });

  test("fuzzySearch finds mark-loss + 1-edit, cross-boundary swaps, and 2-edit double omissions", () => {
    const f1 = morph.fuzzySearch("duzenblemiyor", 1, 20);
    assert.ok(
      f1.some((c) => c.word === "düzenlemiyor" && c.foldedEdits === 1),
      `expected düzenlemiyor in fuzzySearch(duzenblemiyor, 1), got: ${f1.map((c) => c.word).join(", ")}`,
    );
    // Out-of-band short stems must never leak into results.
    assert.ok(!f1.some((c) => c.word.length < 10), `unexpected short candidate in ${f1.map((c) => c.word).join(", ")}`);

    const f2 = morph.fuzzySearch("duzenlemniyor", 1, 20);
    assert.ok(f2.some((c) => c.word === "düzenlemiyor"));
    assert.ok(f2.some((c) => c.word === "düzenleniyor"));

    const fSwap = morph.fuzzySearch("kalelmerimi", 1, 20);
    assert.ok(fSwap.some((c) => c.word === "kalemlerimi"), "cross-boundary transposition should be found");

    const fZero = morph.fuzzySearch("kullandğımda", 1, 20);
    assert.ok(fZero.some((c) => c.word === "kullandığımda"), "zero-count 1-omission should be found");

    const fDouble1 = morph.fuzzySearch("grkli", 2, 40);
    assert.ok(fDouble1.some((c) => c.word === "gerekli"), "double omission grkli -> gerekli");

    const fDouble2 = morph.fuzzySearch("beketiyruz", 2, 40);
    assert.ok(fDouble2.some((c) => c.word === "bekletiyoruz"), "double omission beketiyruz -> bekletiyoruz");

    // Verify Turkish edit cost prefers mark-restoration + near-key over far substitutions.
    assert.ok(turkishEditCost("duzenblemiyor", "düzenlemiyor") < 1.3);
    assert.ok(turkishEditCost("kullandğımda", "kullandığımda") < 0.7);
  });
});
