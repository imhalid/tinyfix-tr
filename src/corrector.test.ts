import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Corrector } from "./corrector.ts";
import { KnownMisspellings } from "./known.ts";
import { Lexicon } from "./lexicon.ts";
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
