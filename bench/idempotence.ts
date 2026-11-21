/**
 * Does correcting already-corrected text change it again? The editor re-runs the engine on corrected paragraphs at
 * every word boundary, so a second pass that changes something means text keeps shifting under the writer.
 *   node bench/idempotence.ts [dev|test|file.jsonl] [--show N]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Corrector } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { loadMorphology } from "./setup.ts";

const args = process.argv.slice(2);
const target = args.find((arg, index) => !arg.startsWith("--") && !["--show", "--lexicon"].includes(args[index - 1] ?? "")) ?? "dev";
const show = args.includes("--show") ? Number(args[args.indexOf("--show") + 1]) : 0;
const lexicon = Lexicon.fromTsv(readFileSync(process.argv.includes("--lexicon") && process.argv[process.argv.indexOf("--lexicon") + 1] === "wiki" ? "data/work/unigrams.tsv" : "data/work/unigrams_conv.tsv", "utf8"), readFileSync("data/work/bigrams.tsv", "utf8"), 1, 5);
const corrector = new Corrector(lexicon, undefined, KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8")), process.argv.includes("--no-morphology") ? undefined : loadMorphology());
const path = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : join("bench", target);
const files = statSync(path).isFile() ? [path] : readdirSync(path).filter((f) => f.endsWith(".jsonl")).map((f) => join(path, f));
const rows = files.flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { wrong: string }));

let unstable = 0;
const changes = new Map<string, number>();
for (const row of rows) {
  const once = corrector.correct(row.wrong).text;
  const second = corrector.correct(once);
  if (second.text === once) continue;
  unstable++;
  for (const c of second.corrections) {
    const key = `${c.original} → ${c.replacement} [${c.kind}]`;
    changes.set(key, (changes.get(key) ?? 0) + 1);
  }
  if (unstable <= show) console.log(`  once:   ${once}\n  second: ${second.text}\n`);
}
console.log(`${rows.length} sentences, ${unstable} (${((100 * unstable) / rows.length).toFixed(2)}%) change on a second pass`);
for (const [key, count] of [...changes].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(count).padStart(3)}  ${key}`);
