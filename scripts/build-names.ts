/**
 * Proper names list for capitalization ("ahmet" -> "Ahmet", "istanbul" -> "İstanbul").
 *
 * Input: data/work/name_candidates.tsv from py/build_names.py (words capitalized at least 97% of the time
 * mid-sentence in Turkish Wikipedia). Drops every candidate that is also an ordinary word: a lemma in Zemberek's
 * common-word dictionaries ("deniz", "umut", "ocak", "bey", "ali"), or a form the lexicon often sees in lowercase.
 *
 *   node scripts/build-names.ts      -> data/rules/names.tsv
 *
 * The browser build appends these rows to known.tsv as its NAME section.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadMorphology } from "../bench/setup.ts";
import { lowerTr, upperTr } from "../src/turkish.ts";

const COMMON_DICTIONARIES = ["data/morph/master-dictionary.dict", "data/morph/non-tdk.dict", "data/morph/informal.dict"];

const common = new Set<string>();
for (const path of COMMON_DICTIONARIES) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const lemma = line.trim().split(/\s/)[0];
    if (!lemma || lemma.startsWith("#")) continue;
    // Capitalized entries in the common dictionaries are names too; only lowercase lemmas are ordinary words.
    if (lemma[0] === lemma[0]!.toLocaleUpperCase("tr")) continue;
    common.add(lowerTr(lemma));
  }
}

// Inflected forms of ordinary words ("partisi", "üniversitesi", "kupası") are capitalized in Wikipedia only because
// they sit inside names ("Cumhuriyet Halk Partisi"); written alone they are ordinary words.
const morphology = loadMorphology();
const inflectsCommonWord = (word: string) =>
  morphology.analyze(word).some((analysis) => analysis.stem !== word && common.has(lowerTr(analysis.stem)));

const MIN_CAPITALS = 150;

const rows: string[] = [];
let dropped = 0;
for (const line of readFileSync("data/work/name_candidates.tsv", "utf8").split("\n")) {
  const [word, caps, total] = line.split("\t");
  if (!word || !caps || !total) continue;
  // Rare forms are often foreign words or species names ("nepos", "yaginumai"): only well-attested names.
  if (!/^[a-zçğıöşüâîû]+$/.test(word) || word.length < 3 || Number(caps) < MIN_CAPITALS) {
    dropped++;
    continue;
  }
  if (common.has(word) || inflectsCommonWord(word)) {
    dropped++;
    continue;
  }
  const name = upperTr(word[0]!) + word.slice(1);
  rows.push(`${word}\t${name}\t${Number(total) - Number(caps)}\t${caps}\tNAME`);
}
rows.sort();
writeFileSync(
  "data/rules/names.tsv",
  "# lowercase\tname\tlowercase_mid_count\tcapital_mid_count\tNAME   (py/build_names.py + scripts/build-names.ts)\n" +
    rows.join("\n") +
    "\n",
);
console.log(`${rows.length} names written, ${dropped} candidates dropped as ordinary words or not plain words`);
