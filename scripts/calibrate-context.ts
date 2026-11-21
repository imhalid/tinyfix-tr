/**
 * Sweeps Context Model v2 thresholds (uniform + direction-aware per-regime offsets) on
 * dev-even, handwritten, and conversation/clean in a single ONNX pass (caching raw scores per query).
 *
 * Usage:
 *   node scripts/calibrate-context.ts [--context data/work/context/model/context.onnx] [--models site/public/models]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadBrowserCorrector } from "../bench/setup.ts";
import { ContextModel, FEATURE_DIM, SEQUENCE, type ContextQuery } from "../src/context.ts";
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
  : "data/work/context/model/context.onnx";
const modelsDir = args.includes("--models") ? args[args.indexOf("--models") + 1]! : "site/public/models";

const ort = await import("onnxruntime-node");
const session = await ort.InferenceSession.create(contextPath);
const wantsFeatures = session.inputNames.includes("features");
console.log(`Loaded ${contextPath} (wantsFeatures=${wantsFeatures})`);

const realModel = new ContextModel(async (tokens, segments, n, features) => {
  const feeds: Record<string, import("onnxruntime-node").Tensor> = {
    tokens: new ort.Tensor("int64", tokens, [n, SEQUENCE]),
    segments: new ort.Tensor("int64", segments, [n, SEQUENCE]),
  };
  if (wantsFeatures) {
    feeds.features = new ort.Tensor("float32", features ?? new Float32Array(n * FEATURE_DIM), [n, FEATURE_DIM]);
  }
  const result = await session.run(feeds);
  return result.scores!.data as Float32Array;
});

const scoreCache = new Map<string, number[][]>();
const cachedModel = {
  async score(queries: readonly ContextQuery[]): Promise<number[][]> {
    if (queries.length === 0) return [];
    const key = queries.map((q) => `${q.left.slice(-20)}|${q.candidates.join(",")}|${q.right.slice(0, 20)}`).join("||");
    const hit = scoreCache.get(key);
    if (hit) return hit;
    const out = await realModel.score(queries);
    scoreCache.set(key, out);
    return out;
  },
} as ContextModel;

function loadSplit(dir: string, half?: "even" | "odd"): Row[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .filter((_, idx) => (half === "even" ? idx % 2 === 0 : half === "odd" ? idx % 2 === 1 : true))
        .map((line) => JSON.parse(line) as Row),
    );
}

const { corrector } = await loadBrowserCorrector(modelsDir);
const devEven = loadSplit("bench/dev", "even");
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
const baseHw = await evalRows(handwritten, CAREFUL, false);
const baseConv = await evalRows(conv, CAREFUL, false);
console.log(
  `\nBASE (no ctx)   devErr=${baseDev.errPct.toFixed(2)}% (w=${baseDev.errWrongPct.toFixed(2)}%)  ` +
    `devClean=${baseDev.cleanRate.toFixed(2)} (${baseDev.cleanTouched})  ` +
    `hwErr=${baseHw.errPct.toFixed(2)}% hwClean=${baseHw.cleanRate.toFixed(2)}  ` +
    `convClean=${baseConv.cleanRate.toFixed(2)}`,
);

console.log("\n=== UNIFORM THRESHOLD SWEEP (all offsets = 0, veto = 6.0) ===");
for (const t of [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0]) {
  const s: Settings = {
    ...CAREFUL,
    threshold: { ...CAREFUL.threshold, context: t },
    contextVeto: 6.0,
    contextOffsets: { marksAscii: 0, marksMarked: 0, marksMarkedOnMarked: 0, deDaSplit: 0, deDaJoin: 0, kiSplit: 0, kiJoin: 0, miSplit: 0, miJoin: 0 },
  };
  const d = await evalRows(devEven, s, true);
  const h = await evalRows(handwritten, s, true);
  const c = await evalRows(conv, s, true);
  const g = (cls: string) => {
    const x = d.stats.get(cls);
    return x ? `${((100 * x.fixed) / x.total).toFixed(1)}%` : "-";
  };
  console.log(
    `T=${t.toFixed(1)} | devErr=${d.errPct.toFixed(2)}% (${(d.errPct - baseDev.errPct >= 0 ? "+" : "")}${(d.errPct - baseDev.errPct).toFixed(2)}) ` +
      `devClean=${d.cleanRate.toFixed(2)} (+${(d.cleanRate - baseDev.cleanRate).toFixed(2)}) | ` +
      `hwErr=${h.errPct.toFixed(2)}% (${(h.errPct - baseHw.errPct >= 0 ? "+" : "")}${(h.errPct - baseHw.errPct).toFixed(2)}) hwClean=${h.cleanRate.toFixed(2)} | ` +
      `convClean=${c.cleanRate.toFixed(2)} (${(c.cleanRate - baseConv.cleanRate >= 0 ? "+" : "")}${(c.cleanRate - baseConv.cleanRate).toFixed(2)}) | ` +
      `ascS=${g("ascii_sentence")} ascW=${g("ascii_word")} deJ=${g("de_da_join")} deS=${g("de_da_split")} ki=${g("ki")} mi=${g("mi")}`,
  );
}

console.log("\n=== DIRECTION-AWARE PER-REGIME SWEEP (base = 3.0) ===");
const configs: Array<{ name: string; veto: number; offsets: NonNullable<Settings["contextOffsets"]> }> = [
  { name: "D1: mA=0 mM=1.5 mMM=4 dS=1.5 dJ=0.0 kS=1.5 kJ=0.5 mS=1.5 mJ=0.5 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 1.5, marksMarkedOnMarked: 4, deDaSplit: 1.5, deDaJoin: 0, kiSplit: 1.5, kiJoin: 0.5, miSplit: 1.5, miJoin: 0.5 } },
  { name: "D2: mA=0 mM=2.0 mMM=5 dS=2.0 dJ=0.5 kS=2.0 kJ=0.5 mS=2.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.0, marksMarkedOnMarked: 5, deDaSplit: 2.0, deDaJoin: 0.5, kiSplit: 2.0, kiJoin: 0.5, miSplit: 2.0, miJoin: 1.0 } },
  { name: "D3: mA=0 mM=2.0 mMM=5 dS=2.5 dJ=0.0 kS=2.0 kJ=0.5 mS=2.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.0, marksMarkedOnMarked: 5, deDaSplit: 2.5, deDaJoin: 0.0, kiSplit: 2.0, kiJoin: 0.5, miSplit: 2.0, miJoin: 1.0 } },
  { name: "D4: mA=0 mM=2.0 mMM=6 dS=3.0 dJ=0.0 kS=2.5 kJ=0.5 mS=2.5 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.0, marksMarkedOnMarked: 6, deDaSplit: 3.0, deDaJoin: 0.0, kiSplit: 2.5, kiJoin: 0.5, miSplit: 2.5, miJoin: 1.0 } },
  { name: "D5: mA=0 mM=2.5 mMM=6 dS=3.3 dJ=0.0 kS=2.5 kJ=0.5 mS=2.5 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.5, marksMarkedOnMarked: 6, deDaSplit: 3.3, deDaJoin: 0.0, kiSplit: 2.5, kiJoin: 0.5, miSplit: 2.5, miJoin: 1.0 } },
  { name: "D6: mA=0 mM=2.5 mMM=6 dS=3.5 dJ=0.5 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.5, marksMarkedOnMarked: 6, deDaSplit: 3.5, deDaJoin: 0.5, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
  { name: "D7: mA=0 mM=2.5 mMM=6 dS=4.0 dJ=0.0 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.5, marksMarkedOnMarked: 6, deDaSplit: 4.0, deDaJoin: 0.0, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
  { name: "D8: mA=0 mM=3.0 mMM=6 dS=3.5 dJ=0.0 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 3.0, marksMarkedOnMarked: 6, deDaSplit: 3.5, deDaJoin: 0.0, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
  { name: "D9: mA=0 mM=2.5 mMM=6 dS=3.5 dJ=0.0 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=3.5", veto: 3.5, offsets: { marksAscii: 0, marksMarked: 2.5, marksMarkedOnMarked: 6, deDaSplit: 3.5, deDaJoin: 0.0, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
  { name: "D10: mA=0 mM=2.5 mMM=6 dS=3.5 dJ=0.0 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=4.5", veto: 4.5, offsets: { marksAscii: 0, marksMarked: 2.5, marksMarkedOnMarked: 6, deDaSplit: 3.5, deDaJoin: 0.0, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
  { name: "D11: mA=0 mM=2.2 mMM=6 dS=3.5 dJ=0.0 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.2, marksMarkedOnMarked: 6, deDaSplit: 3.5, deDaJoin: 0.0, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
  { name: "D12: mA=0 mM=2.2 mMM=6 dS=4.5 dJ=0.0 kS=3.0 kJ=0.5 mS=3.0 mJ=1.0 v=6", veto: 6.0, offsets: { marksAscii: 0, marksMarked: 2.2, marksMarkedOnMarked: 6, deDaSplit: 4.5, deDaJoin: 0.0, kiSplit: 3.0, kiJoin: 0.5, miSplit: 3.0, miJoin: 1.0 } },
];

for (const cfg of configs) {
  const s: Settings = {
    ...CAREFUL,
    threshold: { ...CAREFUL.threshold, context: 3.0 },
    contextVeto: cfg.veto,
    contextOffsets: cfg.offsets,
  };
  const d = await evalRows(devEven, s, true);
  const h = await evalRows(handwritten, s, true);
  const c = await evalRows(conv, s, true);
  const g = (cls: string) => {
    const x = d.stats.get(cls);
    return x ? `${((100 * x.fixed) / x.total).toFixed(1)}%` : "-";
  };
  console.log(
    `${cfg.name}\n  devErr=${d.errPct.toFixed(2)}% (+${(d.errPct - baseDev.errPct).toFixed(2)}) ` +
      `devClean=${d.cleanRate.toFixed(2)} (+${(d.cleanRate - baseDev.cleanRate).toFixed(2)}) | ` +
      `hwErr=${h.errPct.toFixed(2)}% (+${(h.errPct - baseHw.errPct).toFixed(2)}) hwClean=${h.cleanRate.toFixed(2)} | ` +
      `convClean=${c.cleanRate.toFixed(2)} (${(c.cleanRate - baseConv.cleanRate >= 0 ? "+" : "")}${(c.cleanRate - baseConv.cleanRate).toFixed(2)}) | ` +
      `ascS=${g("ascii_sentence")} ascW=${g("ascii_word")} deJ=${g("de_da_join")} deS=${g("de_da_split")} ki=${g("ki")} mi=${g("mi")}`,
  );
}
