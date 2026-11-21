/**
 * Streaming worker for Stage 2 Context Model v3 typo training data generation.
 *
 * Reads TSV lines from stdin:
 *   id \t mode \t typed \t gold \t atStart \t textHasMarks \t questionAhead \t prevWord \t nextWord
 * where mode is "typo" or "oov_clean".
 *
 * Calls the exact browser `Corrector.typoCandidatesFor` and `buildContextFeatures` and emits JSON lines:
 *   {"id":..., "bucket":..., "candidates":[typed, ...alts], "label":idx, "features":[[...26 floats], ...]}
 */
import { createInterface } from "node:readline";
import { loadBrowserCorrector, loadMorphology } from "../bench/setup.ts";
import { buildContextFeatures, type TypoCandidateMeta } from "../src/context.ts";
import type { WordContext } from "../src/corrector.ts";
import { lowerTr, matchCase } from "../src/turkish.ts";

const { corrector, lexicon } = await loadBrowserCorrector("site/public/models");
const morphology = loadMorphology();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line) continue;
  const parts = line.split("\t");
  if (parts.length < 9) continue;
  const id = Number(parts[0]);
  const mode = parts[1]!;
  const typed = parts[2]!;
  const gold = parts[3]!;
  const atSentenceStart = parts[4] === "1";
  const textHasMarks = parts[5] === "1";
  const questionAhead = parts[6] === "1";
  const prevWord = parts[7] || undefined;
  const nextWord = parts[8] || undefined;

  const ctx: WordContext = {
    atSentenceStart,
    textHasMarks,
    questionAhead,
    prevWord,
    nextIsolated: Boolean(nextWord),
  };

  const cands = corrector.typoCandidatesFor(typed, ctx, nextWord, 7);
  if (cands.length === 0) continue;

  const goldLow = lowerTr(gold);
  const alts = cands.map((c) => matchCase(typed, c.text));
  const candidates = [typed, ...alts];
  const meta: TypoCandidateMeta[] = [
    { coreMargin: 0, slipCost: 0, isMarkVariant: false },
    ...cands.map((c) => ({ coreMargin: c.margin, slipCost: c.slipCost, isMarkVariant: c.isMarkVariant })),
  ];
  const asciiContext = !textHasMarks;

  if (mode === "oov_clean") {
    // Only keep OOV clean words whose top candidate could potentially trigger ambiguous/rescue (margin >= -0.5).
    if (cands[0]!.margin < -0.5) continue;
    const features = buildContextFeatures(candidates, "typo", asciiContext, lexicon, morphology, meta);
    process.stdout.write(JSON.stringify({ id, bucket: "neg_oov", candidates, label: 0, features }) + "\n");
    continue;
  }

  const goldIdx = cands.findIndex((c) => c.text === goldLow);
  if (goldIdx === -1) {
    // Negative example: corrupted word whose true target is NOT in 1-edit candidates -> keep typed (label 0).
    if (cands[0]!.margin < -0.5) continue;
    const features = buildContextFeatures(candidates, "typo", asciiContext, lexicon, morphology, meta);
    process.stdout.write(JSON.stringify({ id, bucket: "neg_miss", candidates, label: 0, features }) + "\n");
    continue;
  }

  const top = cands[0]!;
  let bucket: string;
  if (cands.length >= 2 && goldIdx !== 0) {
    bucket = "typo_hard_wrong";
  } else if (cands.length >= 2 && top.margin - cands[1]!.margin < 1.5) {
    bucket = "typo_hard_ambig";
  } else if (top.margin < top.threshold) {
    bucket = cands.length >= 2 ? "typo_below_multi" : "typo_below_single";
  } else if (cands.length >= 2) {
    bucket = "typo_easy_multi";
  } else {
    // Easy single-candidate typo that core already fixes with high confidence: rarely needed for context model.
    bucket = "typo_easy_single";
  }

  const features = buildContextFeatures(candidates, "typo", asciiContext, lexicon, morphology, meta);
  process.stdout.write(JSON.stringify({ id, bucket, candidates, label: goldIdx + 1, features }) + "\n");
}
