/**
 * Reads lowercased Turkish word forms (one per line) from stdin and prints those
 * accepted by the morphology layer (`TurkishMorphology.isWord`) to stdout.
 *
 * Used by `py/build_conversational.py` to keep morphologically invalid subtitle
 * misspellings ("farkettim", "terketti", OCR artifacts) out of `unigrams_conv.tsv`.
 */
import { readFileSync } from "node:fs";
import { loadMorphology } from "../bench/setup.ts";

const morphology = loadMorphology();
const input = readFileSync(0, "utf8");
const out: string[] = [];

for (const line of input.split("\n")) {
  const word = line.trim();
  if (!word) continue;
  const analyses = morphology.analyze(word);
  if (analyses.length === 0) continue;
  const pureVerb = analyses.every((a) => a.pos === "Verb");
  out.push(pureVerb ? `${word}\tV` : `${word}\tW`);
}

if (out.length > 0) {
  process.stdout.write(out.join("\n") + "\n");
}
