/**
 * Simulates someone typing each sentence word by word, the way the site's editor checks it, and compares the result
 * with correcting the finished sentence in one go ("batch").
 *
 * After each finished word, the word `lag` positions back is checked with the fast core corrector.
 * At the end of the sentence:
 *   - `--settle`: rechecks the whole sentence as if pasted.
 *   - `--settle-add`: simulates the site's background pause pass:
 *       * Without `--context`: rechecks with core and only adds fixes to untouched words.
 *       * With `--context <onnx>`: runs `correctAsync` with the context model at the sentence pause. It may fix words
 *         that neither core nor the context model changed yet, and may override a core-rewritten word only when the
 *         context model is very confident (`kind === "context"` and `margin >= --settle-override`, default 2.5).
 *
 *   node bench/typing.ts [dev|test|file.jsonl] [--browser] [--context <onnx>] [--lag 0,1,2]
 *       [--settle | --settle-add] [--auto-marked] [--half even|odd] [--id-half even|odd] [--class name] [--show N]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ContextModel, FEATURE_DIM, LEGACY_FEATURE_DIM, SEQUENCE, sliceLegacyFeatures } from "../src/context.ts";
import { Corrector, type CandidateKind, type Correction } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { loadBrowserCorrector, loadMorphology } from "./setup.ts";

interface Row {
  id?: string | number;
  class: string;
  wrong: string;
  right: string;
}

const args = process.argv.slice(2);
const VALUE_FLAGS = [
  "--lag",
  "--class",
  "--show",
  "--lexicon",
  "--models",
  "--context",
  "--context-threshold",
  "--settle-override",
  "--half",
  "--id-half",
  "--set",
];
/** At the end of a sentence, check the whole sentence once more, as if it had been pasted. */
const settle = args.includes("--settle");
const settleAdd = args.includes("--settle-add");
const passAutoMarked = args.includes("--auto-marked");
const target = args.find((arg, index) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[index - 1] ?? "")) ?? "dev";
const lags = (args.includes("--lag") ? args[args.indexOf("--lag") + 1]! : "0,1,2").split(",").map(Number);
const onlyClass = args.includes("--class") ? args[args.indexOf("--class") + 1] : undefined;
const half = args.includes("--half") ? args[args.indexOf("--half") + 1] : undefined;
const idHalf = args.includes("--id-half") ? args[args.indexOf("--id-half") + 1] : undefined;
const show = args.includes("--show") ? Number(args[args.indexOf("--show") + 1]) : 0;
const browserMode = args.includes("--browser");
const modelsDir = args.includes("--models") ? args[args.indexOf("--models") + 1]! : "site/public/models";
const contextPath = args.includes("--context") ? args[args.indexOf("--context") + 1] : undefined;

const corrector = browserMode
  ? (await loadBrowserCorrector(modelsDir, { noMorphology: args.includes("--no-morphology") })).corrector
  : new Corrector(
      Lexicon.fromTsv(
        readFileSync(
          process.argv.includes("--lexicon") && process.argv[process.argv.indexOf("--lexicon") + 1] === "wiki"
            ? "data/work/unigrams.tsv"
            : "data/work/unigrams_conv.tsv",
          "utf8",
        ),
        readFileSync("data/work/bigrams.tsv", "utf8"),
        1,
        5,
      ),
      undefined,
      KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8")),
      process.argv.includes("--no-morphology") ? undefined : loadMorphology(),
    );

for (const [index, arg] of args.entries()) {
  if (arg !== "--set") continue;
  const [pathStr, value] = args[index + 1]!.split("=");
  const keys = pathStr!.split(".");
  let obj: Record<string, unknown> = corrector.settings as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) obj = obj[key] as Record<string, unknown>;
  obj[keys.at(-1)!] = Number(value);
}

let contextModel: ContextModel | undefined;
if (contextPath) {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(contextPath);
  const wantsSubwords = session.inputNames.includes("subwords");
  const wantsFeatures = session.inputNames.includes("features");
  contextModel = new ContextModel(
    async (tokens, segments, n, features, subwords) => {
      const feeds: Record<string, import("onnxruntime-node").Tensor> = {};
      if (wantsSubwords && subwords) {
        feeds.subwords = new ort.Tensor("int64", subwords.subwords, [n, subwords.seqLen]);
        feeds.sub_segments = new ort.Tensor("int64", subwords.subSegments, [n, subwords.seqLen]);
      } else {
        feeds.tokens = new ort.Tensor("int64", tokens, [n, SEQUENCE]);
        feeds.segments = new ort.Tensor("int64", segments, [n, SEQUENCE]);
      }
      if (wantsFeatures) {
        const featArr = features ?? new Float32Array(n * FEATURE_DIM);
        feeds.features = wantsSubwords
          ? new ort.Tensor("float32", featArr, [n, FEATURE_DIM])
          : new ort.Tensor("float32", sliceLegacyFeatures(featArr, n), [n, LEGACY_FEATURE_DIM]);
      }
      const result = await session.run(feeds);
      return result.scores!.data as Float32Array;
    },
    { subwordsOnly: wantsSubwords },
  );
  if (args.includes("--context-threshold")) {
    corrector.settings.threshold.context = Number(args[args.indexOf("--context-threshold") + 1]);
  }
}

const settleOverrideBar = args.includes("--settle-override")
  ? Number(args[args.indexOf("--settle-override") + 1])
  : Math.max(corrector.settings.contextTypoOverride ?? 2.5, corrector.settings.threshold.context);

const path = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : join("bench", target);
const files = statSync(path).isFile() ? [path] : readdirSync(path).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(path, f));
const rows: Row[] = files
  .flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((_, idx) => (half === "even" ? idx % 2 === 0 : half === "odd" ? idx % 2 === 1 : true))
      .map((line) => JSON.parse(line) as Row),
  )
  .filter((row) => {
    if (onlyClass && row.class !== onlyClass) return false;
    if (!idHalf) return true;
    const m = String(row.id ?? "").match(/(\d+)/);
    if (!m) return true;
    return idHalf === "even" ? Number(m[1]) % 2 === 0 : Number(m[1]) % 2 === 1;
  });

/** Word spans of a text: [start, end) of each run of letters (with an inner apostrophe). */
function words(text: string): [number, number][] {
  return [...text.matchAll(/\p{L}+(?:['’]\p{L}+)?/gu)].map((m) => [m.index, m.index + m[0].length]);
}

interface CoreRecord {
  start: number;
  end: number;
  original: string;
  kind: CandidateKind;
}

/** Applies fixes; shifts `autoMarked` and `coreRecords` along and records the new spans. */
function apply(
  text: string,
  fixes: Correction[],
  autoMarked: [number, number][] = [],
  coreRecords: CoreRecord[] = [],
  recordAsCore = true,
): string {
  let out = "";
  let cursor = 0;
  const kept: [number, number][] = [];
  const added: [number, number][] = [];
  const keptCore: CoreRecord[] = [];
  const addedCore: CoreRecord[] = [];
  const shifts: [at: number, by: number][] = [];
  for (const fix of [...fixes].sort((a, b) => a.start - b.start)) {
    if (fix.start < cursor) continue;
    out += text.slice(cursor, fix.start);
    const newStart = out.length;
    const newEnd = out.length + fix.replacement.length;
    added.push([newStart, newEnd]);
    if (recordAsCore) {
      addedCore.push({ start: newStart, end: newEnd, original: fix.original, kind: fix.kind });
    }
    out += fix.replacement;
    shifts.push([fix.end, fix.replacement.length - (fix.end - fix.start)]);
    cursor = fix.end;
  }
  const shift = (pos: number) => pos + shifts.filter(([at]) => at <= pos).reduce((sum, [, by]) => sum + by, 0);
  for (const [from, to] of autoMarked) {
    if (fixes.some((fix) => fix.start < to && fix.end > from)) continue;
    kept.push([shift(from), shift(to)]);
  }
  for (const rec of coreRecords) {
    if (fixes.some((fix) => fix.start < rec.end && fix.end > rec.start)) continue;
    keptCore.push({ ...rec, start: shift(rec.start), end: shift(rec.end) });
  }
  autoMarked.splice(0, autoMarked.length, ...kept, ...added);
  coreRecords.splice(0, coreRecords.length, ...keptCore, ...addedCore);
  return out + text.slice(cursor);
}

/** Types `input` word by word with core autocorrect, then runs optional end-of-sentence settle/context pass. */
async function typeOut(input: string, lag: number): Promise<{ text: string; changes: number }> {
  const spans = words(input);
  let typed = "";
  let consumed = 0;
  let changes = 0;
  const pending: number[] = [];
  const autoMarked: [number, number][] = [];
  const coreRecords: CoreRecord[] = [];
  const contextTouched: [number, number][] = [];

  const checkWord = (wordIndex: number, cursor: number) => {
    const span = words(typed)[wordIndex];
    if (!span) return;
    const fixes = corrector
      .correct(typed, passAutoMarked ? { autoMarked } : {})
      .corrections.filter((fix) => fix.start < span[1] && fix.end > span[0] && fix.end <= cursor);
    if (fixes.length > 0) {
      changes += fixes.length;
      typed = apply(typed, fixes, autoMarked, coreRecords, true);
    }
  };

  for (let i = 0; i < spans.length; i++) {
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
  while (pending.length > 0) checkWord(pending.shift()!, typed.length);

  if (settle) {
    const res = contextModel ? await corrector.correctAsync(typed, contextModel) : corrector.correct(typed);
    changes += res.corrections.length;
    typed = res.text;
  }

  // --settle-add: background pass on pause.
  // Without --context: rechecks with core and only adds fixes to words untouched by core.
  // With --context: runs the context model over the full sentence. May fix any word not yet changed by the
  // context model; overrides a word previously rewritten by core only when the context model is very confident.
  if (settleAdd) {
    if (contextModel) {
      const priorTypoOriginals = coreRecords
        .filter((rec) => rec.kind === "typo" || rec.kind === "marks")
        .map((rec) => ({ start: rec.start, end: rec.end, original: rec.original }));
      const res = await corrector.correctAsync(typed, contextModel, {
        autoMarked: passAutoMarked ? autoMarked : undefined,
        priorTypoOriginals,
      });
      const fixes = res.corrections.filter((fix) => {
        if (contextTouched.some(([from, to]) => fix.start < to && fix.end > from)) return false;
        const hitCore = autoMarked.some(([from, to]) => fix.start < to && fix.end > from);
        if (!hitCore) return true;
        return fix.kind === "context" && fix.margin >= settleOverrideBar;
      });
      if (fixes.length > 0) {
        // Only count newly touched spans toward changes (overriding a previously counted core span stays 1 change).
        for (const fix of fixes) {
          if (!autoMarked.some(([from, to]) => fix.start < to && fix.end > from)) changes++;
        }
        typed = apply(typed, fixes, autoMarked, coreRecords, false);
        for (const fix of fixes) contextTouched.push([fix.start, fix.end]);
      }
    } else {
      const fixes = corrector
        .correct(typed, passAutoMarked ? { autoMarked } : {})
        .corrections.filter((fix) => !autoMarked.some(([from, to]) => fix.start < to && fix.end > from));
      if (fixes.length > 0) {
        changes += fixes.length;
        typed = apply(typed, fixes, autoMarked, coreRecords, true);
      }
    }
  }
  return { text: typed, changes };
}

console.log(
  `${rows.length} sentences from ${path}${contextPath ? ` (context: ${contextPath}, override>=${settleOverrideBar})` : ""}\n`,
);
console.log("lag  mode      fixed (non-clean)   clean changed   clean ch/1000w   same as batch");
const batch: { text: string; changes: number }[] = [];
for (const row of rows) {
  const res = contextModel ? await corrector.correctAsync(row.wrong, contextModel) : corrector.correct(row.wrong);
  batch.push({ text: res.text, changes: res.corrections.length });
}

const report = (label: string, outputs: { text: string; changes: number }[]) => {
  const errors = rows.filter((row) => row.wrong !== row.right);
  const fixed = rows.filter((row, i) => row.wrong !== row.right && outputs[i]!.text === row.right).length;
  const clean = rows.filter((row) => row.wrong === row.right);
  let cleanChanged = 0;
  let cleanWords = 0;
  let cleanChanges = 0;
  rows.forEach((row, i) => {
    if (row.wrong !== row.right) return;
    cleanWords += row.wrong.split(/\s+/).length;
    if (outputs[i]!.text !== row.wrong) {
      cleanChanged++;
      cleanChanges += outputs[i]!.changes;
    }
  });
  const same = outputs.filter((out, i) => out.text === batch[i]!.text).length;
  const chRate = cleanWords > 0 ? ((1000 * cleanChanges) / cleanWords).toFixed(2) : "-";
  console.log(
    `${label}   ${((100 * fixed) / Math.max(errors.length, 1)).toFixed(1).padStart(15)}%   ` +
      `${((100 * cleanChanged) / Math.max(clean.length, 1)).toFixed(1).padStart(11)}%   ` +
      `${chRate.padStart(14)}   ${((100 * same) / rows.length).toFixed(1).padStart(12)}%`,
  );
};

report("  -  batch  ", batch);
for (const lag of lags) {
  const outputs: { text: string; changes: number }[] = [];
  for (const row of rows) outputs.push(await typeOut(row.wrong, lag));
  report(`  ${lag}  typing `, outputs);
  if (show) {
    let shown = 0;
    rows.forEach((row, i) => {
      if (shown < show && outputs[i]!.text !== batch[i]!.text) {
        shown++;
        console.log(`    batch:  ${batch[i]!.text}\n    typing: ${outputs[i]!.text}\n`);
      }
    });
  }
}
