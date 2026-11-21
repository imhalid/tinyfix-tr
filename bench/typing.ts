/**
 * Simulates someone typing each sentence word by word, the way the site's editor checks it, and compares the result
 * with correcting the finished sentence in one go ("batch").
 *
 * After each finished word, the word `lag` positions back is checked: the whole text so far is given to the
 * corrector, and only changes that touch that word and end before the cursor are kept, as in the editor. At the end
 * of the sentence the words still waiting are checked too. lag 0 checks a word as soon as it's finished; lag 2 waits
 * for two more words, as tinyfix does.
 *
 * With --auto-marked the corrector is told which spans autocorrect itself rewrote, as the site does, so the Turkish
 * letters it put there don't count as signs that the user types them.
 *
 *   node bench/typing.ts [dev|test|file.jsonl] [--lag 0,1,2] [--settle] [--auto-marked] [--class name] [--show N]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Corrector, type Correction } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { loadBrowserCorrector, loadMorphology } from "./setup.ts";

interface Row {
  class: string;
  wrong: string;
  right: string;
}

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--lag", "--class", "--show", "--lexicon", "--models"];
/** At the end of a sentence, check the whole sentence once more, as if it had been pasted. */
const settle = args.includes("--settle");
const passAutoMarked = args.includes("--auto-marked");
const target = args.find((arg, index) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[index - 1] ?? "")) ?? "dev";
const lags = (args.includes("--lag") ? args[args.indexOf("--lag") + 1]! : "0,1,2").split(",").map(Number);
const onlyClass = args.includes("--class") ? args[args.indexOf("--class") + 1] : undefined;
const show = args.includes("--show") ? Number(args[args.indexOf("--show") + 1]) : 0;
const browserMode = args.includes("--browser");
const modelsDir = args.includes("--models") ? args[args.indexOf("--models") + 1]! : "site/public/models";

const corrector = browserMode
  ? (await loadBrowserCorrector(modelsDir, { noMorphology: args.includes("--no-morphology") })).corrector
  : new Corrector(
      Lexicon.fromTsv(readFileSync(process.argv.includes("--lexicon") && process.argv[process.argv.indexOf("--lexicon") + 1] === "wiki" ? "data/work/unigrams.tsv" : "data/work/unigrams_conv.tsv", "utf8"), readFileSync("data/work/bigrams.tsv", "utf8"), 1, 5),
      undefined,
      KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8")),
      process.argv.includes("--no-morphology") ? undefined : loadMorphology(),
    );

const path = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : join("bench", target);
const files = statSync(path).isFile() ? [path] : readdirSync(path).filter((f) => f.endsWith(".jsonl")).map((f) => join(path, f));
const rows: Row[] = files
  .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row))
  .filter((row) => !onlyClass || row.class === onlyClass);

/** Word spans of a text: [start, end) of each run of letters (with an inner apostrophe). */
function words(text: string): [number, number][] {
  return [...text.matchAll(/\p{L}+(?:['’]\p{L}+)?/gu)].map((m) => [m.index, m.index + m[0].length]);
}

/** Applies the fixes; `autoMarked` (spans autocorrect wrote) is shifted along and gets the new spans added. */
function apply(text: string, fixes: Correction[], autoMarked: [number, number][] = []): string {
  let out = "";
  let cursor = 0;
  const kept: [number, number][] = [];
  const added: [number, number][] = [];
  const shifts: [at: number, by: number][] = [];
  for (const fix of [...fixes].sort((a, b) => a.start - b.start)) {
    if (fix.start < cursor) continue;
    out += text.slice(cursor, fix.start);
    added.push([out.length, out.length + fix.replacement.length]);
    out += fix.replacement;
    shifts.push([fix.end, fix.replacement.length - (fix.end - fix.start)]);
    cursor = fix.end;
  }
  const shift = (pos: number) => pos + shifts.filter(([at]) => at <= pos).reduce((sum, [, by]) => sum + by, 0);
  for (const [from, to] of autoMarked) {
    if (fixes.some((fix) => fix.start < to && fix.end > from)) continue;
    kept.push([shift(from), shift(to)]);
  }
  autoMarked.splice(0, autoMarked.length, ...kept, ...added);
  return out + text.slice(cursor);
}

/** Types `input` word by word, checking the word `lag` positions back after each finished word. */
function typeOut(input: string, lag: number): string {
  const spans = words(input);
  let typed = ""; // what the editor holds so far, with fixes applied
  let consumed = 0; // how much of `input` has been typed
  const pending: number[] = []; // indexes into the editor text's words still waiting to be checked
  const autoMarked: [number, number][] = []; // spans autocorrect has rewritten
  const checkWord = (wordIndex: number, cursor: number) => {
    const span = words(typed)[wordIndex];
    if (!span) return;
    const fixes = corrector
      .correct(typed, passAutoMarked ? { autoMarked } : {})
      .corrections.filter((fix) => fix.start < span[1] && fix.end > span[0] && fix.end <= cursor);
    if (fixes.length > 0) typed = apply(typed, fixes, autoMarked);
  };
  for (let i = 0; i < spans.length; i++) {
    // Type the word and whatever follows it up to the next word (spaces, punctuation).
    const end = i + 1 < spans.length ? spans[i + 1]![0] : input.length;
    typed += input.slice(consumed, end);
    consumed = end;
    const finished = /[\s\p{P}]/u.test(typed.at(-1) ?? "");
    if (!finished && i + 1 < spans.length) continue;
    pending.push(i);
    while (pending.length > lag) {
      const wordIndex = pending.shift()!;
      checkWord(wordIndex, typed.length);
    }
  }
  // End of the sentence: the words still waiting are checked with everything typed.
  while (pending.length > 0) checkWord(pending.shift()!, typed.length);
  if (settle) typed = corrector.correct(typed).text;
  return typed;
}

console.log(`${rows.length} sentences from ${path}\n`);
console.log("lag  mode      fixed (non-clean)   clean changed   same as batch");
const batch = rows.map((row) => corrector.correct(row.wrong).text);
const report = (label: string, outputs: string[]) => {
  const errors = rows.filter((row) => row.wrong !== row.right);
  const fixed = rows.filter((row, i) => row.wrong !== row.right && outputs[i] === row.right).length;
  const clean = rows.filter((row) => row.wrong === row.right);
  const cleanChanged = rows.filter((row, i) => row.wrong === row.right && outputs[i] !== row.wrong).length;
  const same = outputs.filter((out, i) => out === batch[i]).length;
  console.log(
    `${label}   ${((100 * fixed) / Math.max(errors.length, 1)).toFixed(1).padStart(15)}%   ${((100 * cleanChanged) / Math.max(clean.length, 1)).toFixed(1).padStart(11)}%   ${((100 * same) / rows.length).toFixed(1).padStart(12)}%`,
  );
};
report("  -  batch  ", batch);
for (const lag of lags) {
  const outputs = rows.map((row) => typeOut(row.wrong, lag));
  report(`  ${lag}  typing `, outputs);
  if (show) {
    let shown = 0;
    rows.forEach((row, i) => {
      if (shown < show && outputs[i] !== batch[i]) {
        shown++;
        console.log(`    batch:  ${batch[i]}\n    typing: ${outputs[i]}\n`);
      }
    });
  }
}
