/**
 * Runs the corrector over bench/<split>/*.jsonl and reports, per error class, how many sentences came out exactly
 * right, how many were changed wrongly, and how many were left alone. For "clean" it reports changed words per 1,000.
 *
 *   node bench/run.ts [dev|test|<path to a .jsonl file>] [--show N] [--class name] [--min-count N] [--min-pair N] [--dump file]
 *
 * "precision" is the share of single changes that, applied alone, bring the sentence closer to the gold one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ContextModel, SEQUENCE } from "../src/context.ts";
import { Corrector } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { loadBrowserCorrector, loadMorphology } from "./setup.ts";

interface Row {
  id: string | number;
  class: string;
  wrong: string;
  right: string;
}

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--show", "--class", "--min-count", "--min-pair", "--dump", "--context", "--context-threshold", "--lexicon", "--set", "--models"];
const target = args.find((arg, index) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[index - 1] ?? "")) ?? "dev";
const show = args.includes("--show") ? Number(args[args.indexOf("--show") + 1]) : 0;
const onlyClass = args.includes("--class") ? args[args.indexOf("--class") + 1] : undefined;
const browserMode = args.includes("--browser");
const modelsDir = args.includes("--models") ? args[args.indexOf("--models") + 1]! : "site/public/models";

const started = Date.now();
let lexicon: Lexicon;
let corrector: Corrector;
let loadSummary: string;

if (browserMode) {
  const loaded = await loadBrowserCorrector(modelsDir, {
    noMorphology: args.includes("--no-morphology"),
    noKnown: args.includes("--no-known"),
  });
  lexicon = loaded.lexicon;
  corrector = loaded.corrector;
  const rawMb = loaded.files.reduce((s, f) => s + f.raw, 0) / 1e6;
  const gzipMb = loaded.files.reduce((s, f) => s + f.gzip, 0) / 1e6;
  const brotliMb = loaded.files.reduce((s, f) => s + f.brotli, 0) / 1e6;
  loadSummary =
    `browser (${modelsDir}): ${lexicon.size.toLocaleString()} forms, ${lexicon.pairCount.toLocaleString()} pairs, ` +
    `${rawMb.toFixed(2)} MB raw / ${gzipMb.toFixed(2)} MB gzip / ${brotliMb.toFixed(2)} MB brotli, ` +
    `parsed in ${loaded.parseMs.toFixed(1)} ms (total ${loaded.totalMs.toFixed(1)} ms)\n`;
} else {
  const minCount = args.includes("--min-count") ? Number(args[args.indexOf("--min-count") + 1]) : 1;
  const minPair = args.includes("--min-pair") ? Number(args[args.indexOf("--min-pair") + 1]) : 1;
  lexicon = Lexicon.fromTsv(
    readFileSync(process.argv.includes("--lexicon") && process.argv[process.argv.indexOf("--lexicon") + 1] === "wiki" ? "data/work/unigrams.tsv" : "data/work/unigrams_conv.tsv", "utf8"),
    readFileSync("data/work/bigrams.tsv", "utf8"),
    minCount,
    minPair,
  );
  const known = args.includes("--no-known") ? undefined : KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8"));
  corrector = new Corrector(lexicon, undefined, known, process.argv.includes("--no-morphology") ? undefined : loadMorphology());
  const tsv = lexicon.toTsv();
  const gzipMb = (gzipSync(tsv.unigrams).length + gzipSync(tsv.bigrams).length) / 1e6;
  loadSummary =
    `lexicon: ${lexicon.size.toLocaleString()} forms (count >= ${minCount}), ${lexicon.pairCount.toLocaleString()} pairs (count >= ${minPair}), ${gzipMb.toFixed(1)} MB gzipped as TSV, loaded in ${Date.now() - started} ms\n`;
}
// --set name=value overrides one number in the settings, for trying values: --set typoEndWindow=3
for (const [index, arg] of args.entries()) {
  if (arg !== "--set") continue;
  const [path, value] = args[index + 1]!.split("=");
  const keys = path!.split(".");
  let target: Record<string, unknown> = corrector.settings as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = Number(value);
}
const contextPath = args.includes("--context") ? args[args.indexOf("--context") + 1] : undefined;
let contextModel: ContextModel | undefined;
if (contextPath) {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(contextPath);
  contextModel = new ContextModel(async (tokens, segments, n) => {
    const feeds = { tokens: new ort.Tensor("int64", tokens, [n, SEQUENCE]), segments: new ort.Tensor("int64", segments, [n, SEQUENCE]) };
    const result = await session.run(feeds);
    return result.scores!.data as Float32Array;
  });
  if (args.includes("--context-threshold")) corrector.settings.threshold.context = Number(args[args.indexOf("--context-threshold") + 1]);
  console.log(`context model: ${contextPath}, threshold ${corrector.settings.threshold.context}`);
}
console.log(loadSummary);

const path = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : join("bench", target);
const files = statSync(path).isFile() ? [path] : readdirSync(path).filter((f) => f.endsWith(".jsonl")).map((f) => join(path, f));
const rows: Row[] = files.flatMap((file) =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row),
);

/** Character edit distance, to tell whether a single change moves the text toward the gold sentence. */
function distance(first: string, second: string): number {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 1; i <= first.length; i++) {
    const current = [i];
    for (let j = 1; j <= second.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (first[i - 1] === second[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[second.length]!;
}

const dumpPath = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : undefined;
const dumped: string[] = [];

interface Tally {
  good: number;
  total: number;
  fixed: number;
  wrong: number;
  untouched: number;
  words: number;
  changes: number;
  examples: string[];
}
const byClass = new Map<string, Tally>();
const checkStarted = performance.now();
let words = 0;
for (const row of rows) {
  if (onlyClass && row.class !== onlyClass) continue;
  const tally = byClass.get(row.class) ?? { good: 0, total: 0, fixed: 0, wrong: 0, untouched: 0, words: 0, changes: 0, examples: [] };
  byClass.set(row.class, tally);
  const { text, corrections } = contextModel ? await corrector.correctAsync(row.wrong, contextModel) : corrector.correct(row.wrong);
  const count = row.wrong.split(/\s+/).length;
  words += count;
  tally.total++;
  tally.words += count;
  tally.changes += corrections.length;
  const before = distance(row.wrong, row.right);
  for (const c of corrections) {
    const alone = row.wrong.slice(0, c.start) + c.replacement + row.wrong.slice(c.end);
    if (distance(alone, row.right) < before) tally.good++;
    if (dumpPath) dumped.push(JSON.stringify({ id: row.id, class: row.class, original: c.original, replacement: c.replacement, kind: c.kind, margin: Number(c.margin.toFixed(2)), sentence: row.wrong }));
  }
  const isClean = row.wrong === row.right;
  if (text === row.right) tally[isClean ? "untouched" : "fixed"]++;
  else if (text === row.wrong) tally.untouched++;
  else tally.wrong++;
  if (text !== row.right && tally.examples.length < show) {
    const changes = corrections.map((c) => `${c.original}→${c.replacement} [${c.kind} ${c.margin.toFixed(1)}]`).join(", ");
    tally.examples.push(`  want: ${row.right}\n  got:  ${text}\n  changes: ${changes || "none"}`);
  }
}
const elapsed = performance.now() - checkStarted;

const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");
console.log("class            total   fixed   wrong-change   untouched   changed/1000 words   precision");
for (const [name, t] of [...byClass.entries()].sort()) {
  const isClean = name === "clean";
  console.log(
    `${name.padEnd(16)} ${String(t.total).padStart(5)}  ${(isClean ? "-" : pct(t.fixed, t.total)).padStart(6)}  ${pct(t.wrong, t.total).padStart(12)}  ${pct(t.untouched, t.total).padStart(10)}  ${((1000 * t.changes) / t.words).toFixed(2).padStart(10)}  ${(isClean ? "-" : pct(t.good, t.changes)).padStart(18)}`,
  );
}
console.log(`\n${words.toLocaleString()} words checked in ${elapsed.toFixed(0)} ms (${((1000 * elapsed) / words).toFixed(0)} µs per word)`);
if (dumpPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dumpPath, dumped.join("\n") + "\n");
}
for (const [name, t] of byClass) if (t.examples.length) console.log(`\n== ${name} misses ==\n${t.examples.join("\n\n")}`);
