/**
 * Splits mined misspelling candidates (data/rules/mined-candidates.tsv) by whether the morphology layer accepts the
 * "wrong" form as a real Turkish word. Forms it accepts ("yapıyordun", "görmen") are dropped; the rest go to
 * data/rules/mined-for-review.tsv for review.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { TurkishMorphology } from "../src/morphology/index.ts";

const dictionaries = ["master-dictionary.dict", "non-tdk.dict", "informal.dict", "proper.dict"].map((name) =>
  readFileSync(`data/morph/${name}`, "utf8"),
);
const morphology = TurkishMorphology.fromDictionaries(dictionaries);
const lines = readFileSync("data/rules/mined-candidates.tsv", "utf8").split("\n").filter(Boolean);
const header = lines[0]!;
const kept: string[] = [];
let dropped = 0;
for (const line of lines.slice(1)) {
  const [wrong] = line.split("\t");
  if (morphology.isWord(wrong!)) dropped++;
  else kept.push(line);
}
writeFileSync("data/rules/mined-for-review.tsv", [header, ...kept].join("\n") + "\n");
console.log(`${lines.length - 1} candidates: ${dropped} are real words by the morphology layer, ${kept.length} left for review`);
