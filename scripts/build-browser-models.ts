/**
 * Builds the compact browser model bundle into `site/public/models/` (or `--out <dir>`):
 *   - `lexicon.bin`  (ALX1: columnar 1-byte front-coded unigrams + split-CSR bigrams + Bloom2/3 tails)
 *   - `morph.bin`    (AMR1: lossless binary encoding of Zemberek morphology dictionaries)
 *   - `known.tsv`    (known misspellings & contractions list)
 *   - `manifest.json` (uncompressed byte sizes for accurate download progress reporting)
 *
 * Run from repo root:
 *   node scripts/build-browser-models.ts [--out site/public/models]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  encodeBinaryLexicon,
  type BinaryBigramInput,
  type BinaryUnigramInput,
} from "../src/lexicon-binary.ts";
import { encodeBinaryDictionary } from "../src/morphology/binary.ts";
import { parseDictionaries } from "../src/morphology/dictionary.ts";
import { TurkishMorphology } from "../src/morphology/index.ts";
import { buildMorphPriorFromCorpora } from "../src/morphology/prior.ts";
import { JOIN_FIRST, JOIN_SECOND, NEVER_ALONE, QUESTION } from "../src/rules/turkish-rules.ts";

const MORPHOLOGY_FILES = [
  "master-dictionary.dict",
  "non-tdk.dict",
  "informal.dict",
  "proper.dict",
] as const;

// Tuned parameters verified against dev, handwritten neon-v1, conversation/clean, and idempotence:
// - Exact table holds all non-apostrophe words with count >= 4, all apostrophe words with count >= 7,
//   plus every word referenced by a kept bigram.
// - Rare non-apostrophe words with count == 2 and count == 3 are kept in separate low-FP Bloom filters
//   (14 bits/item for count=2, 16 bits/item for count=3) to protect clean rare words without full string cost.
// - Bigrams keep all join-relevant (JOIN_FIRST / JOIN_SECOND), question-particle (QUESTION), and 2-word known.tsv
//   pairs down to count >= 2, and all other valid split-candidate pairs down to count >= 20 (exact CAREFUL threshold).
const CONFIG = {
  unigramExactMin: 4,
  apostropheMin: 7,
  bigramJoinMin: 2,
  bigramSplitMin: 20,
  bloom2BitsPerItem: 14,
  bloom3BitsPerItem: 16,
  blockSize: 64,
  exactCountMax: 80,
  countBuckets: 256,
  countMaxVal: 3_000_000,
  capMax: 50,
} as const;

function parseOutDir(argv: readonly string[]): string {
  const idx = argv.indexOf("--out");
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1]! : "site/public/models";
}

function parseContextPath(argv: readonly string[]): string | null {
  if (argv.includes("--no-context")) return null;
  const idx = argv.indexOf("--context");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1]!;
  return "data/work/context/model/context.onnx";
}

function buildKnownPairMatcher(knownTsv: string): (w1: string, w2: string) => boolean {
  const byFirst = new Map<string, string[]>();
  for (const line of knownTsv.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const wrong = line.split("\t")[0];
    if (!wrong || !wrong.includes(" ")) continue;
    const [w1, w2] = wrong.split(" ");
    if (!w1 || !w2) continue;
    let list = byFirst.get(w1);
    if (!list) {
      list = [];
      byFirst.set(w1, list);
    }
    list.push(w2);
  }
  return (w1, w2) => {
    const seconds = byFirst.get(w1);
    if (!seconds) return false;
    return seconds.some((s) => w2 === s || (w2.startsWith(s) && w2.length - s.length <= 6));
  };
}

function formatSizes(label: string, bytes: Uint8Array): { raw: number; gz: number; br: number } {
  const gz = gzipSync(bytes, { level: 9 }).byteLength;
  const br = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
  }).byteLength;
  const mb = (n: number) => `${(n / 1e6).toFixed(3)} MB`;
  console.log(
    `  ${label.padEnd(16)} raw=${mb(bytes.byteLength).padStart(10)} (${String(bytes.byteLength).padStart(9)} B)  ` +
      `gzip=${mb(gz).padStart(10)}  brotli=${mb(br).padStart(10)}`,
  );
  return { raw: bytes.byteLength, gz, br };
}

function main(): void {
  const started = performance.now();
  const outDir = parseOutDir(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  // Remove legacy raw TSV lexicon files if present in outDir.
  for (const legacy of ["unigrams.tsv", "bigrams.tsv"]) {
    rmSync(join(outDir, legacy), { force: true });
  }

  const knownTsv = readFileSync("data/rules/known.tsv", "utf8");
  const isKnownPair = buildKnownPairMatcher(knownTsv);

  // 1. Filter bigrams first so every referenced unigram is guaranteed to stay in the exact table.
  const rawBigramsText = readFileSync("data/work/bigrams.tsv", "utf8");
  const keptBigrams: BinaryBigramInput[] = [];
  const bigramWords = new Set<string>();
  let totalBigrams = 0;

  for (const line of rawBigramsText.split("\n")) {
    if (!line) continue;
    totalBigrams++;
    const tab = line.lastIndexOf("\t");
    if (tab === -1) continue;
    const pair = line.slice(0, tab);
    const sp = pair.indexOf(" ");
    if (sp === -1) continue;
    const first = pair.slice(0, sp);
    const second = pair.slice(sp + 1);
    const count = Number(line.slice(tab + 1));

    const isJoin = JOIN_FIRST.has(first) || JOIN_SECOND.has(second);
    const isQuestion = QUESTION.test(second);
    const isKnown = isKnownPair(first, second);

    let keep = false;
    if (isJoin) {
      keep = count >= CONFIG.bigramJoinMin;
    } else if (isQuestion || isKnown) {
      keep = count >= 2;
    } else if (
      count >= CONFIG.bigramSplitMin &&
      !first.includes("'") &&
      !second.includes("'") &&
      first.length >= 2 &&
      second.length >= 2 &&
      !NEVER_ALONE.has(second)
    ) {
      keep = true;
    }

    if (keep) {
      keptBigrams.push({
        first,
        second,
        count,
        groupBySecond: JOIN_SECOND.has(second) || isQuestion,
      });
      bigramWords.add(first);
      bigramWords.add(second);
    }
  }

  // 2. Partition unigrams into exact table vs Bloom tail tiers.
  const rawUnigramsText = readFileSync("data/work/unigrams_conv.tsv", "utf8");
  const exactUnigrams: BinaryUnigramInput[] = [];
  const bloom2Words: string[] = [];
  const bloom3Words: string[] = [];
  let totalUnigrams = 0;
  let droppedApos = 0;

  for (const line of rawUnigramsText.split("\n")) {
    if (!line) continue;
    totalUnigrams++;
    const [form, countStr, capsStr] = line.split("\t");
    if (!form) continue;
    const count = Number(countStr);
    const capitalized = Number(capsStr ?? "0");

    if (bigramWords.has(form)) {
      exactUnigrams.push({ form, count, capitalized });
    } else if (form.includes("'")) {
      if (count >= CONFIG.apostropheMin) {
        exactUnigrams.push({ form, count, capitalized });
      } else {
        droppedApos++;
      }
    } else if (count >= CONFIG.unigramExactMin) {
      exactUnigrams.push({ form, count, capitalized });
    } else if (count === 3) {
      bloom3Words.push(form);
    } else if (count === 2) {
      bloom2Words.push(form);
    }
  }

  console.log(
    `Unigrams: ${totalUnigrams.toLocaleString()} total -> ${exactUnigrams.length.toLocaleString()} exact + ` +
      `${bloom3Words.length.toLocaleString()} bloom(3) + ${bloom2Words.length.toLocaleString()} bloom(2) ` +
      `(${droppedApos.toLocaleString()} rare apostrophe forms pruned)`,
  );
  console.log(`Bigrams:  ${totalBigrams.toLocaleString()} total -> ${keptBigrams.length.toLocaleString()} kept`);

  // 3. Encode lexicon.bin (ALX1)
  const lexiconBytes = encodeBinaryLexicon({
    unigrams: exactUnigrams,
    bigrams: keptBigrams,
    bloomTiers: [
      { returnCount: 3, bitsPerItem: CONFIG.bloom3BitsPerItem, words: bloom3Words },
      { returnCount: 2, bitsPerItem: CONFIG.bloom2BitsPerItem, words: bloom2Words },
    ],
    blockSize: CONFIG.blockSize,
    exactCountMax: CONFIG.exactCountMax,
    countBuckets: CONFIG.countBuckets,
    countMaxVal: CONFIG.countMaxVal,
    capMax: CONFIG.capMax,
  });

  // 4. Encode morph.bin (AMR2: lossless dictionary + compact corpus lemma/suffix-chain prior)
  const dictTexts = MORPHOLOGY_FILES.map((name) => readFileSync(`data/morph/${name}`, "utf8"));
  const morphItems = parseDictionaries(dictTexts);
  const morphAnalyzer = TurkishMorphology.fromDictionaries(dictTexts);
  const subtitleTsv = existsSync("data/work/subtitle_counts.tsv")
    ? readFileSync("data/work/subtitle_counts.tsv", "utf8")
    : undefined;
  const morphPrior = buildMorphPriorFromCorpora(morphAnalyzer, rawUnigramsText, subtitleTsv);
  const morphBytes = encodeBinaryDictionary(morphItems, morphPrior);
  console.log(
    `Morphology: ${morphItems.length.toLocaleString()} active dictionary items + prior ` +
      `(${morphPrior.lemmaSize.toLocaleString()} lemmas, ${morphPrior.chainSize.toLocaleString()} chains, ${morphPrior.bigramSize.toLocaleString()} bigrams)`,
  );

  // 5. Write output artifacts + manifest.json
  writeFileSync(join(outDir, "lexicon.bin"), lexiconBytes);
  writeFileSync(join(outDir, "morph.bin"), morphBytes);
  // known.tsv ships with the proper-names list (data/rules/names.tsv, section NAME) appended.
  const namesTsv = existsSync("data/rules/names.tsv") ? readFileSync("data/rules/names.tsv", "utf8") : "";
  const nameRows = namesTsv.split("\n").filter((line) => line && !line.startsWith("#"));
  writeFileSync(
    join(outDir, "known.tsv"),
    readFileSync("data/rules/known.tsv", "utf8").replace(/\n?$/, "\n") + (nameRows.length ? nameRows.join("\n") + "\n" : ""),
  );

  const knownBytes = readFileSync(join(outDir, "known.tsv"));
  const manifest: Record<string, number> = {
    "known.tsv": knownBytes.byteLength,
    "lexicon.bin": lexiconBytes.byteLength,
    "morph.bin": morphBytes.byteLength,
  };

  // Optional context model: copied when present so the site exposes the setting and downloads it only when toggled on.
  const contextSrc = parseContextPath(process.argv.slice(2));
  const contextDst = join(outDir, "context.onnx");
  let contextBytes: Uint8Array | null = null;
  if (contextSrc && existsSync(contextSrc)) {
    copyFileSync(contextSrc, contextDst);
    contextBytes = readFileSync(contextDst);
    manifest["context.onnx"] = contextBytes.byteLength;
  } else {
    rmSync(contextDst, { force: true });
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest));

  console.log(`\nWritten to ${outDir}/ in ${((performance.now() - started) / 1000).toFixed(2)}s:`);
  const sLex = formatSizes("lexicon.bin", lexiconBytes);
  const sMorph = formatSizes("morph.bin", morphBytes);
  const sKnown = formatSizes("known.tsv", knownBytes);
  const totRaw = sLex.raw + sMorph.raw + sKnown.raw;
  const totGz = sLex.gz + sMorph.gz + sKnown.gz;
  const totBr = sLex.br + sMorph.br + sKnown.br;
  console.log(
    `  ${"CORE MODELS".padEnd(16)} raw=${(totRaw / 1e6).toFixed(3).padStart(7)} MB (${String(totRaw).padStart(9)} B)  ` +
      `gzip=${(totGz / 1e6).toFixed(3).padStart(7)} MB  brotli=${(totBr / 1e6).toFixed(3).padStart(7)} MB`,
  );
  if (contextBytes) {
    formatSizes("context.onnx", contextBytes);
  }
}

main();
