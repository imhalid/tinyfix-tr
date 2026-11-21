/**
 * Sweeps Context Model v3 (or legacy v2) thresholds & typo bars on dev-even, tune-even,
 * handwritten, and conversation/clean in a single cached ONNX pass.
 *
 * Usage:
 *   node scripts/calibrate-context.ts [--context data/work/context_v3/model/context.onnx] [--models site/public/models]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadBrowserCorrector } from "../bench/setup.ts";
import {
  ContextModel,
  FEATURE_DIM,
  LEGACY_FEATURE_DIM,
  SEQUENCE,
  sliceLegacyFeatures,
  type ContextQuery,
} from "../src/context.ts";
import { CAREFUL, type Settings } from "../src/corrector.ts";

interface Row {
  id: string | number;
  class: string;
  wrong: string;
  right: string;
}

const args = process.argv.slice(2);
const contextPath = args.includes("--context")
  ? args[args.indexOf("--context") + 1]!
  : "data/work/context_v3/model/context.onnx";
const modelsDir = args.includes("--models") ? args[args.indexOf("--models") + 1]! : "site/public/models";

const ort = await import("onnxruntime-node");
const session = await ort.InferenceSession.create(contextPath);
const wantsSubwords = session.inputNames.includes("subwords");
const wantsFeatures = session.inputNames.includes("features");
console.log(`Loaded ${contextPath} (wantsSubwords=${wantsSubwords}, wantsFeatures=${wantsFeatures})`);

const realModel = new ContextModel(
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

const scoreCache = new Map<string, number[][]>();
const cachedModel = {
  async score(queries: readonly ContextQuery[]): Promise<number[][]> {
    if (queries.length === 0) return [];
    const key = queries.map((q) => `${q.left.slice(-40)}|${q.candidates.join(",")}|${q.right.slice(0, 40)}`).join("||");
    const hit = scoreCache.get(key);
    if (hit) return hit;
    const out = await realModel.score(queries);
    scoreCache.set(key, out);
    return out;
  },
} as ContextModel;

function loadSplit(target: string, half?: "even" | "odd", idHalf?: "even" | "odd"): Row[] {
  const files = statSync(target).isFile()
    ? [target]
    : readdirSync(target)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => join(target, f));
  return files
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
      return !m || (idHalf === "even" ? Number(m[1]) % 2 === 0 : Number(m[1]) % 2 === 1);
    });
}

const { corrector } = await loadBrowserCorrector(modelsDir);
const devEven = loadSplit("bench/dev", "even");
const tuneEven = loadSplit("bench/synth/tune.jsonl", undefined, "even");
const handwritten = loadSplit("bench/handwritten");
const conv = loadSplit("bench/conversation");

async function evalRows(rows: Row[], settings: Settings, useContext: boolean) {
  corrector.settings = settings;
  const stats = new Map<string, { total: number; fixed: number; wrong: number; words: number; changes: number }>();
  for (const row of rows) {
    const s = stats.get(row.class) ?? { total: 0, fixed: 0, wrong: 0, words: 0, changes: 0 };
    stats.set(row.class, s);
    const res = useContext ? await corrector.correctAsync(row.wrong, cachedModel) : corrector.correct(row.wrong);
    s.total++;
    s.words += row.wrong.split(/\s+/).length;
    s.changes += res.corrections.length;
    const isClean = row.wrong === row.right;
    if (res.text === row.right) {
      if (!isClean) s.fixed++;
    } else if (res.text !== row.wrong) {
      s.wrong++;
    }
  }
  let errTotal = 0;
  let errFixed = 0;
  let errWrong = 0;
  for (const [cls, s] of stats) {
    if (cls === "clean") continue;
    errTotal += s.total;
    errFixed += s.fixed;
    errWrong += s.wrong;
  }
  const clean = stats.get("clean");
  const cleanRate = clean ? (1000 * clean.changes) / clean.words : 0;
  return {
    stats,
    errPct: errTotal ? (100 * errFixed) / errTotal : 0,
    errWrongPct: errTotal ? (100 * errWrong) / errTotal : 0,
    cleanRate,
    cleanTouched: clean ? clean.wrong : 0,
  };
}

const baseDev = await evalRows(devEven, CAREFUL, false);
const baseTune = await evalRows(tuneEven, CAREFUL, false);
const baseHw = await evalRows(handwritten, CAREFUL, false);
const baseConv = await evalRows(conv, CAREFUL, false);
console.log(
  `\nBASE (no ctx)   devErr=${baseDev.errPct.toFixed(2)}% devClean=${baseDev.cleanRate.toFixed(2)} | ` +
    `tuneErr=${baseTune.errPct.toFixed(2)}% (w=${baseTune.errWrongPct.toFixed(2)}%) tuneClean=${baseTune.cleanRate.toFixed(2)} | ` +
    `hwErr=${baseHw.errPct.toFixed(2)}% hwClean=${baseHw.cleanRate.toFixed(2)} | ` +
    `convClean=${baseConv.cleanRate.toFixed(2)}`,
);

console.log("\n=== UNIFORM CONTEXT THRESHOLD SWEEP (default typo bars, veto=6.0) ===");
for (const t of [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0]) {
  const s: Settings = {
    ...CAREFUL,
    threshold: { ...CAREFUL.threshold, context: t },
    contextVeto: 6.0,
    contextTypoOverride: 2.5,
    contextTypoAmbigGap: 1.5,
    contextTypoAmbigVsTyped: 2.5,
    contextTypoRescue: 4.5,
  };
  const d = await evalRows(devEven, s, true);
  const tn = await evalRows(tuneEven, s, true);
  const h = await evalRows(handwritten, s, true);
  const c = await evalRows(conv, s, true);
  const g = (cls: string) => {
    const x = d.stats.get(cls);
    return x ? `${((100 * x.fixed) / x.total).toFixed(1)}%` : "-";
  };
  console.log(
    `T=${t.toFixed(1)} | dev=${d.errPct.toFixed(2)}% (${(d.errPct - baseDev.errPct >= 0 ? "+" : "")}${(d.errPct - baseDev.errPct).toFixed(2)}) cl=${d.cleanRate.toFixed(2)} (${(d.cleanRate - baseDev.cleanRate >= 0 ? "+" : "")}${(d.cleanRate - baseDev.cleanRate).toFixed(2)}) | ` +
      `tune=${tn.errPct.toFixed(2)}% (+${(tn.errPct - baseTune.errPct).toFixed(2)}, w=${tn.errWrongPct.toFixed(1)}%) cl=${tn.cleanRate.toFixed(2)} | ` +
      `hw=${h.errPct.toFixed(2)}% cl=${h.cleanRate.toFixed(2)} | conv=${c.cleanRate.toFixed(2)} (${(c.cleanRate - baseConv.cleanRate >= 0 ? "+" : "")}${(c.cleanRate - baseConv.cleanRate).toFixed(2)}) | ` +
      `ascW=${g("ascii_word")} deJ=${g("de_da_join")} deS=${g("de_da_split")} ki=${g("ki")} mi=${g("mi")} typ=${g("typo")}`,
  );
}

console.log("\n=== TYPO BAR SWEEP (T=3.0) ===");
const typoConfigs = [
  { ov: 1.5, gap: 1.0, vst: 1.5, rsc: 3.0 },
  { ov: 2.0, gap: 1.0, vst: 2.0, rsc: 3.5 },
  { ov: 2.0, gap: 1.5, vst: 2.0, rsc: 4.0 },
  { ov: 2.5, gap: 1.5, vst: 2.5, rsc: 4.5 },
  { ov: 3.0, gap: 1.5, vst: 3.0, rsc: 5.0 },
  { ov: 3.0, gap: 2.0, vst: 3.0, rsc: 6.0 },
  { ov: 2.5, gap: 1.5, vst: 2.5, rsc: 99.0 },
  { ov: 2.0, gap: 1.2, vst: 2.0, rsc: 99.0 },
];
for (const tc of typoConfigs) {
  const s: Settings = {
    ...CAREFUL,
    threshold: { ...CAREFUL.threshold, context: 3.0 },
    contextTypoOverride: tc.ov,
    contextTypoAmbigGap: tc.gap,
    contextTypoAmbigVsTyped: tc.vst,
    contextTypoRescue: tc.rsc,
  };
  const d = await evalRows(devEven, s, true);
  const tn = await evalRows(tuneEven, s, true);
  const c = await evalRows(conv, s, true);
  const g = (cls: string) => {
    const x = d.stats.get(cls);
    return x ? `${((100 * x.fixed) / x.total).toFixed(1)}%` : "-";
  };
  console.log(
    `ov=${tc.ov} gap=${tc.gap} vst=${tc.vst} rsc=${tc.rsc} | ` +
      `dev=${d.errPct.toFixed(2)}% typ=${g("typo")} cl=${d.cleanRate.toFixed(2)} | ` +
      `tune=${tn.errPct.toFixed(2)}% (+${(tn.errPct - baseTune.errPct).toFixed(2)}, w=${tn.errWrongPct.toFixed(1)}%) cl=${tn.cleanRate.toFixed(2)} | ` +
      `conv=${c.cleanRate.toFixed(2)}`,
  );
}
