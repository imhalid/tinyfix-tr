/**
 * Runs the corrector over bench/<split>/*.jsonl and reports:
 * 1) Auto-fix table (fixed / wrong-change / untouched / changed per 1,000 words / precision)
 * 2) Detection (inspect) table:
 *    - Error classes: fixed / flag@1 / flag@5 / flag-no-hit / missed / detected (fixed+flagged)
 *    - Clean classes: false flags per 1,000 words (+ top 30 false flags when --top-flags is passed or not odd half)
 *
 *   node bench/run.ts [dev|test|<path to a .jsonl file>] [--browser] [--context <onnx>] [--half even|odd] [--id-half even|odd]
 *                     [--show N] [--show-flags N] [--top-flags N] [--no-inspect] [--class name] [--dump file]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ContextModel, FEATURE_DIM, LEGACY_FEATURE_DIM, SEQUENCE, sliceLegacyFeatures } from "../src/context.ts";
import { Corrector, tokenize, type Correction, type SpellFlag } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { loadBrowserCorrector, loadKnownTsv, loadMorphology } from "./setup.ts";

interface Row {
  id: string | number;
  class: string;
  wrong: string;
  right: string;
}

const args = process.argv.slice(2);
const VALUE_FLAGS = [
  "--show",
  "--show-flags",
  "--top-flags",
  "--class",
  "--min-count",
  "--min-pair",
  "--dump",
  "--context",
  "--context-threshold",
  "--lexicon",
  "--set",
  "--models",
  "--half",
  "--id-half",
];
const target = args.find((arg, index) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[index - 1] ?? "")) ?? "dev";
const show = args.includes("--show") ? Number(args[args.indexOf("--show") + 1]) : 0;
const showFlags = args.includes("--show-flags") ? Number(args[args.indexOf("--show-flags") + 1]) : 0;
const noInspect = args.includes("--no-inspect");
const onlyClass = args.includes("--class") ? args[args.indexOf("--class") + 1] : undefined;
const half = args.includes("--half") ? args[args.indexOf("--half") + 1] : undefined;
const idHalf = args.includes("--id-half") ? args[args.indexOf("--id-half") + 1] : undefined;
const isOddSplit = half === "odd" || idHalf === "odd";
const topFlagsLimit = args.includes("--top-flags")
  ? Number(args[args.indexOf("--top-flags") + 1])
  : isOddSplit
    ? 0
    : 30;
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
    readFileSync(
      process.argv.includes("--lexicon") && process.argv[process.argv.indexOf("--lexicon") + 1] === "wiki"
        ? "data/work/unigrams.tsv"
        : "data/work/unigrams_conv.tsv",
      "utf8",
    ),
    readFileSync("data/work/bigrams.tsv", "utf8"),
    minCount,
    minPair,
  );
  const known = args.includes("--no-known") ? undefined : KnownMisspellings.fromTsv(loadKnownTsv());
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
  let targetObj: Record<string, unknown> = corrector.settings as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) targetObj = targetObj[key] as Record<string, unknown>;
  targetObj[keys.at(-1)!] = Number(value);
}
const contextPath = args.includes("--context") ? args[args.indexOf("--context") + 1] : undefined;
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
  if (args.includes("--context-threshold")) corrector.settings.threshold.context = Number(args[args.indexOf("--context-threshold") + 1]);
  console.log(`context model: ${contextPath}, threshold ${corrector.settings.threshold.context}`);
}
console.log(loadSummary);

const path = statSync(target, { throwIfNoEntry: false })?.isFile() ? target : join("bench", target);
const files = statSync(path).isFile() ? [path] : readdirSync(path).filter((f) => f.endsWith(".jsonl")).map((f) => join(path, f));
const rows: Row[] = files
  .flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((_, idx) => (half === "even" ? idx % 2 === 0 : half === "odd" ? idx % 2 === 1 : true))
      .map((line) => JSON.parse(line) as Row),
  )
  .filter((row) => {
    if (!idHalf) return true;
    const m = String(row.id).match(/(\d+)/);
    if (!m) return true;
    return idHalf === "even" ? Number(m[1]) % 2 === 0 : Number(m[1]) % 2 === 1;
  });

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

/**
 * Classifies detection outcome for an error sentence (wrong !== right) into 5 mutually exclusive states:
 *   "fixed"      - auto-fixes produced exact gold text
 *   "flag1"      - every unfixed error is flagged and its #1 suggestion fixes it to gold (or single-token match)
 *   "flag5"      - every unfixed error is flagged and a top-5 suggestion fixes it
 *   "flagNoHit"  - unfixed error(s) flagged, but gold word is not in top 5 (or mixed with wrong auto-fix)
 *   "missed"     - unfixed error was neither fixed nor flagged
 */
function classifySentenceDetection(
  wrong: string,
  right: string,
  fixedText: string,
  corrections: readonly Correction[],
  flags: readonly SpellFlag[],
): "fixed" | "flag1" | "flag5" | "flagNoHit" | "missed" {
  if (fixedText === right) return "fixed";

  const applyEdits = (edits: Array<{ start: number; end: number; replacement: string }>): string => {
    const ordered = [...edits].sort((a, b) => a.start - b.start);
    let out = "";
    let cur = 0;
    for (const e of ordered) {
      if (e.start < cur) continue;
      out += wrong.slice(cur, e.start) + e.replacement;
      cur = e.end;
    }
    return out + wrong.slice(cur);
  };

  // Identify flags that actually sit on an erroneous span (using token alignment when lengths match, or edit distance).
  const wToks = tokenize(wrong).filter((t) => t.isWord);
  const rToks = tokenize(right).filter((t) => t.isWord);

  if (wToks.length === rToks.length) {
    // Clean token-aligned comparison (covers 100% of typo / omission / adjacent_key / vowel_swap / transposition / mixed / misspelling).
    const errorIndices: number[] = [];
    for (let i = 0; i < wToks.length; i++) {
      if (wToks[i]!.text !== rToks[i]!.text) errorIndices.push(i);
    }
    if (errorIndices.length > 0) {
      let allDetected = true;
      let anyWrongFix = false;
      let worstRank = 0; // 0 = auto-fixed, 1 = flag@1, 2 = flag@5, 3 = flagNoHit
      for (const idx of errorIndices) {
        const wt = wToks[idx]!;
        const want = rToks[idx]!.text;
        const corr = corrections.find((c) => c.start < wt.end && c.end > wt.start);
        if (corr) {
          const singleApplied = wrong.slice(0, corr.start) + corr.replacement + wrong.slice(corr.end);
          const gotWord = corr.start === wt.start && corr.end === wt.end ? corr.replacement : singleApplied;
          if (gotWord !== want && distance(singleApplied, right) >= distance(wrong, right)) {
            anyWrongFix = true;
          }
          continue;
        }
        const flag = flags.find((f) => f.start === wt.start && f.end === wt.end);
        if (!flag) {
          allDetected = false;
          continue;
        }
        if (flag.suggestions[0] === want) {
          worstRank = Math.max(worstRank, 1);
        } else if (flag.suggestions.slice(0, 5).includes(want)) {
          worstRank = Math.max(worstRank, 2);
        } else {
          worstRank = Math.max(worstRank, 3);
        }
      }
      if (!allDetected) return "missed";
      if (anyWrongFix) return "flagNoHit";
      if (worstRank === 0) return "fixed";
      if (worstRank === 1) return "flag1";
      if (worstRank === 2) return "flag5";
      return "flagNoHit";
    }
  }

  // Fallback for split/join/apostrophe sentences where token counts differ.
  if (flags.length === 0) return "missed";
  const baseEdits = corrections.map((c) => ({ start: c.start, end: c.end, replacement: c.replacement }));
  const distBase = distance(fixedText, right);
  const top1Edits = [
    ...baseEdits,
    ...flags
      .filter((f) => f.suggestions.length > 0)
      .map((f) => ({ start: f.start, end: f.end, replacement: f.suggestions[0]! })),
  ];
  if (applyEdits(top1Edits) === right) return "flag1";

  // Try picking best suggestion per flag within top 5.
  let anyImproved = false;
  let allTop1 = true;
  const bestEdits = [...baseEdits];
  for (const f of flags) {
    let bestSugg: string | null = null;
    let bestD = distBase;
    let bestIdx = -1;
    for (let s = 0; s < Math.min(5, f.suggestions.length); s++) {
      const cand = applyEdits([...baseEdits, { start: f.start, end: f.end, replacement: f.suggestions[s]! }]);
      const d = distance(cand, right);
      if (d < bestD) {
        bestD = d;
        bestSugg = f.suggestions[s]!;
        bestIdx = s;
      }
    }
    if (bestSugg !== null) {
      anyImproved = true;
      if (bestIdx > 0) allTop1 = false;
      bestEdits.push({ start: f.start, end: f.end, replacement: bestSugg });
    }
  }
  if (anyImproved && applyEdits(bestEdits) === right) return allTop1 ? "flag1" : "flag5";
  if (anyImproved) return "flagNoHit";
  // Check if a flag landed on a token that doesn't appear in `right`.
  const rightSet = new Set(rToks.map((t) => t.text));
  if (flags.some((f) => !rightSet.has(f.original))) return "flagNoHit";
  return "missed";
}

const dumpPath = args.includes("--dump") ? args[args.indexOf("--dump") + 1] : undefined;
const dumped: string[] = [];

interface Tally {
  good: number;
  total: number;
  fixed: number;
  wrong: number;
  untouched: number;
  cleanRows: number;
  words: number;
  changes: number;
  examples: string[];
  // Detection / flagging tallies
  detFixed: number;
  detFlag1: number;
  detFlag5: number;
  detFlagNoHit: number;
  detMissed: number;
  // Error-token tallies (for multi-error sentences like mixed/omission)
  errTokens: number;
  errTokFixed: number;
  errTokFlag1: number;
  errTokFlag5: number;
  errTokFlagNoHit: number;
  errTokWrongFix: number;
  errTokMissed: number;
  // Clean flagging tallies
  flagCount: number;
  cleanFlagFreq: Map<string, { count: number; reason: string; top: string }>;
  flagMissExamples: string[];
}

const byClass = new Map<string, Tally>();
const checkStarted = performance.now();
let words = 0;

for (const row of rows) {
  if (onlyClass && row.class !== onlyClass) continue;
  let tally = byClass.get(row.class);
  if (!tally) {
    tally = {
      good: 0,
      total: 0,
      fixed: 0,
      wrong: 0,
      untouched: 0,
      cleanRows: 0,
      words: 0,
      changes: 0,
      examples: [],
      detFixed: 0,
      detFlag1: 0,
      detFlag5: 0,
      detFlagNoHit: 0,
      detMissed: 0,
      errTokens: 0,
      errTokFixed: 0,
      errTokFlag1: 0,
      errTokFlag5: 0,
      errTokFlagNoHit: 0,
      errTokWrongFix: 0,
      errTokMissed: 0,
      flagCount: 0,
      cleanFlagFreq: new Map(),
      flagMissExamples: [],
    };
    byClass.set(row.class, tally);
  }

  let text: string;
  let corrections: Correction[];
  let flags: SpellFlag[] = [];
  if (noInspect) {
    const res = contextModel ? await corrector.correctAsync(row.wrong, contextModel) : corrector.correct(row.wrong);
    text = res.text;
    corrections = res.corrections;
  } else {
    const res = contextModel ? await corrector.inspectAsync(row.wrong, contextModel) : corrector.inspect(row.wrong);
    text = res.text;
    corrections = res.corrections;
    flags = res.flags;
  }

  const count = row.wrong.split(/\s+/).length;
  words += count;
  tally.total++;
  tally.words += count;
  tally.changes += corrections.length;
  tally.flagCount += flags.length;

  const before = distance(row.wrong, row.right);
  for (const c of corrections) {
    const alone = row.wrong.slice(0, c.start) + c.replacement + row.wrong.slice(c.end);
    if (distance(alone, row.right) < before) tally.good++;
    if (dumpPath) {
      dumped.push(
        JSON.stringify({
          id: row.id,
          class: row.class,
          original: c.original,
          replacement: c.replacement,
          kind: c.kind,
          margin: Number(c.margin.toFixed(2)),
          sentence: row.wrong,
        }),
      );
    }
  }
  const isClean = row.wrong === row.right;
  if (isClean) {
    tally.cleanRows++;
    for (const f of flags) {
      const key = f.original;
      const cur = tally.cleanFlagFreq.get(key);
      if (cur) cur.count++;
      else tally.cleanFlagFreq.set(key, { count: 1, reason: f.reason, top: f.suggestions[0] ?? "-" });
    }
  } else if (!noInspect) {
    const outcome = classifySentenceDetection(row.wrong, row.right, text, corrections, flags);
    if (outcome === "fixed") tally.detFixed++;
    else if (outcome === "flag1") tally.detFlag1++;
    else if (outcome === "flag5") tally.detFlag5++;
    else if (outcome === "flagNoHit") tally.detFlagNoHit++;
    else tally.detMissed++;

    // Token-level breakdown when aligned
    const wToks = tokenize(row.wrong).filter((t) => t.isWord);
    const rToks = tokenize(row.right).filter((t) => t.isWord);
    if (wToks.length === rToks.length) {
      for (let i = 0; i < wToks.length; i++) {
        if (wToks[i]!.text === rToks[i]!.text) continue;
        tally.errTokens++;
        const wt = wToks[i]!;
        const want = rToks[i]!.text;
        const corr = corrections.find((c) => c.start < wt.end && c.end > wt.start);
        if (corr) {
          if (corr.start === wt.start && corr.end === wt.end && corr.replacement === want) tally.errTokFixed++;
          else tally.errTokWrongFix++;
          continue;
        }
        const fl = flags.find((f) => f.start === wt.start && f.end === wt.end);
        if (!fl) {
          tally.errTokMissed++;
        } else if (fl.suggestions[0] === want) {
          tally.errTokFlag1++;
        } else if (fl.suggestions.slice(0, 5).includes(want)) {
          tally.errTokFlag5++;
        } else {
          tally.errTokFlagNoHit++;
        }
      }
    }

    if ((outcome === "missed" || outcome === "flagNoHit") && tally.flagMissExamples.length < showFlags) {
      const flStr = flags.map((f) => `${f.original}[${f.reason}]→(${f.suggestions.join("/")})`).join(", ");
      const chStr = corrections.map((c) => `${c.original}→${c.replacement}[${c.kind}]`).join(", ");
      tally.flagMissExamples.push(
        `  [${outcome}] want: ${row.right}\n          raw:  ${row.wrong}\n          fix:  ${chStr || "none"} | flags: ${flStr || "none"}`,
      );
    }
  }

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
  const isClean = name === "clean" || (t.total > 0 && t.cleanRows === t.total);
  console.log(
    `${name.padEnd(16)} ${String(t.total).padStart(5)}  ${(isClean ? "-" : pct(t.fixed, t.total)).padStart(6)}  ${pct(t.wrong, t.total).padStart(12)}  ${pct(t.untouched, t.total).padStart(10)}  ${((1000 * t.changes) / t.words).toFixed(2).padStart(10)}  ${(isClean ? "-" : pct(t.good, t.changes)).padStart(18)}`,
  );
}
console.log(`\n${words.toLocaleString()} words checked in ${elapsed.toFixed(0)} ms (${((1000 * elapsed) / words).toFixed(0)} µs per word)`);

if (!noInspect) {
  console.log("\n=== DETECTION (inspect: auto-fix + flags) ===");
  console.log(
    "class            total   fixed  flag@1  flag@5  flag-no  missed  detected(f+fl)  flags/1000w",
  );
  for (const [name, t] of [...byClass.entries()].sort()) {
    const isClean = name === "clean" || (t.total > 0 && t.cleanRows === t.total);
    const flPer1k = ((1000 * t.flagCount) / t.words).toFixed(2);
    if (isClean) {
      console.log(
        `${name.padEnd(16)} ${String(t.total).padStart(5)}       -       -       -        -       -               -  ${flPer1k.padStart(11)}`,
      );
    } else {
      const detected = t.detFixed + t.detFlag1 + t.detFlag5 + t.detFlagNoHit;
      console.log(
        `${name.padEnd(16)} ${String(t.total).padStart(5)}  ${pct(t.detFixed, t.total).padStart(6)}  ${pct(t.detFlag1, t.total).padStart(6)}  ${pct(t.detFlag5, t.total).padStart(6)}  ${pct(t.detFlagNoHit, t.total).padStart(7)}  ${pct(t.detMissed, t.total).padStart(6)}  ${pct(detected, t.total).padStart(14)}  ${flPer1k.padStart(11)}`,
      );
    }
  }

  // Token-level detection summary for aligned typo classes (critical for multi-error sentences like mixed/omission).
  const tokRows = [...byClass.entries()].sort().filter(([, t]) => t.errTokens > 0);
  if (tokRows.length > 0) {
    console.log("\n=== TOKEN-LEVEL DETECTION (per erroneous word) ===");
    console.log(
      "class            errTok  fixed  flag@1  flag@5  flag-no  wr-fix  missed  detected(f+fl)",
    );
    for (const [name, t] of tokRows) {
      const detTok = t.errTokFixed + t.errTokFlag1 + t.errTokFlag5 + t.errTokFlagNoHit + t.errTokWrongFix;
      console.log(
        `${name.padEnd(16)} ${String(t.errTokens).padStart(6)}  ${pct(t.errTokFixed, t.errTokens).padStart(5)}  ${pct(t.errTokFlag1, t.errTokens).padStart(6)}  ${pct(t.errTokFlag5, t.errTokens).padStart(6)}  ${pct(t.errTokFlagNoHit, t.errTokens).padStart(7)}  ${pct(t.errTokWrongFix, t.errTokens).padStart(6)}  ${pct(t.errTokMissed, t.errTokens).padStart(6)}  ${pct(detTok, t.errTokens).padStart(14)}`,
      );
    }
  }

  if (topFlagsLimit > 0) {
    for (const [name, t] of [...byClass.entries()].sort()) {
      if (t.cleanFlagFreq.size === 0) continue;
      const top = [...t.cleanFlagFreq.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, topFlagsLimit);
      console.log(`\n== top ${top.length} clean false flags (${name}: ${t.flagCount} total, ${((1000 * t.flagCount) / t.words).toFixed(2)}/1000w) ==`);
      console.log(
        "  " +
          top.map(([w, info]) => `${w}(${info.count},${info.reason}→${info.top})`).join(", "),
      );
    }
  }

  for (const [name, t] of byClass) {
    if (t.flagMissExamples.length > 0) {
      console.log(`\n== ${name} detection misses ==\n${t.flagMissExamples.join("\n\n")}`);
    }
  }
}

if (dumpPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dumpPath, dumped.join("\n") + "\n");
}
for (const [name, t] of byClass) if (t.examples.length) console.log(`\n== ${name} misses ==\n${t.examples.join("\n\n")}`);
