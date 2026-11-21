/** Runs a few sentences through the corrector and prints each change. node bench/examples.ts ["sentence" ...] */
import { readFileSync } from "node:fs";
import { Corrector } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { loadMorphology } from "./setup.ts";

const minCount = Number(process.env.MIN_COUNT ?? 1);
const lexicon = Lexicon.fromTsv(readFileSync("data/work/unigrams_conv.tsv", "utf8"), readFileSync("data/work/bigrams.tsv", "utf8"), minCount);
const corrector = new Corrector(lexicon, undefined, KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8")), process.argv.includes("--no-morphology") ? undefined : loadMorphology());

const defaults = [
  "Bugün cok yorgunum, Istanbul trafiği berbattı.",
  "Yarın Ankaraya gidiyorum.",
  "Birşey söylemek istiyorum ama hiç bir fikrim yok.",
  "Bu iş gelecek hafta biter mi bilmiyorum, sen geldinmi?",
  "Yarın sende gelecekmisin?",
  "Eski sürüm daha iyiydi ama arenasıda doluydu.",
  "Öyle bir şey diyorki herkes güldü.",
  "Oysa ki ben ona söylemiştim.",
  "Yerler de bulunabilirler.",
  "Akşam eve gelyorum.",
  "nasil yaptigini anlatiyor mu yoksa sen kendin mi tahmin edeceksin",
  "bunu turkce icin yapmamiz gerekiyor ne gerekiyorsa bana soyle sen yapabilirsen sen yap ama turkcede de cok iyi calismali",
  "turkce kurallarina gore duzgun bir sekilde calismali imla kurallari vs icin. yapabiliur miyiz bunu",
  "gemini neon'a da gorev verebilirsin bazi konlarda arkaplanda goal olarak o yapabilir bazi seyleri",
];
for (const sentence of process.argv.length > 2 ? process.argv.slice(2) : defaults) {
  const { text, corrections } = corrector.correct(sentence);
  console.log(`in:  ${sentence}\nout: ${text}`);
  console.log(`     ${corrections.map((c) => `${c.original}→${c.replacement} [${c.kind} ${c.margin.toFixed(1)}]`).join(", ") || "(no changes)"}\n`);
}
