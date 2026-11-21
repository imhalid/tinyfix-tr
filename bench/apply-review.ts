/**
 * Checks reviewed misspelling candidates (wrong, correct, category, note) and appends the ones that pass to
 * data/rules/known.tsv under the section MINED. A row passes when:
 *   - its category is one of --categories (default: yazim),
 *   - the correct form is seen at least --min-right times (a single word in the lexicon, two words as a pair),
 *   - a single-word correct form is a real word by the morphology layer, and the wrong form is not,
 *   - the wrong form is not already listed.
 * Rejected rows and the reason go to data/rules/mined-rejected.tsv.
 *   node bench/apply-review.ts <review.tsv> [--categories yazim,kisaltma] [--section MINED|CONTRACTION] [--min-right 20] [--dry-run]
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Lexicon } from "../src/lexicon.ts";
import { lowerTr } from "../src/turkish.ts";
import { loadMorphology } from "./setup.ts";

const args = process.argv.slice(2);
const reviewPath = args.find((arg, index) => !arg.startsWith("--") && !["--categories", "--min-right", "--section"].includes(args[index - 1] ?? ""));
if (!reviewPath) throw new Error("usage: node bench/apply-review.ts <review.tsv>");
const categories = new Set((args.includes("--categories") ? args[args.indexOf("--categories") + 1]! : "yazim").split(","));
const minRight = args.includes("--min-right") ? Number(args[args.indexOf("--min-right") + 1]) : 20;
const dryRun = args.includes("--dry-run");
/** Section written in known.tsv: MINED for misspellings, CONTRACTION for spoken-style contractions ("noldu"). */
const section = args.includes("--section") ? args[args.indexOf("--section") + 1]! : "MINED";

const lexicon = Lexicon.fromTsv(readFileSync("data/work/unigrams_conv.tsv", "utf8"), readFileSync("data/work/bigrams.tsv", "utf8"));
const morphology = loadMorphology();
const knownText = readFileSync("data/rules/known.tsv", "utf8");
const listed = new Set(knownText.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split("\t")[0]));

const accepted: string[] = [];
const rejected: string[] = [];
const seen = new Set<string>();
for (const line of readFileSync(reviewPath, "utf8").split("\n")) {
  const [rawWrong, rawCorrect, category = "", note = ""] = line.split("\t");
  if (!rawWrong || !rawCorrect || rawWrong.startsWith("#") || rawWrong === "wrong") continue;
  const wrong = lowerTr(rawWrong.trim());
  const correct = lowerTr(rawCorrect.trim());
  const reject = (reason: string) => rejected.push([wrong, correct, category, reason, note].join("\t"));
  if (seen.has(wrong)) continue;
  seen.add(wrong);
  if (!categories.has(category.trim())) continue;
  if (wrong === correct) {
    reject("same as correct");
    continue;
  }
  if (listed.has(wrong)) {
    reject("already listed");
    continue;
  }
  const words = correct.split(" ");
  // Two words with a separate particle ("senin de", "gitti mi", "değil ki") are common in speech but rare as pairs in
  // Wikipedia; for those, each word must be common and real on its own.
  const particlePair = words.length === 2 && /^(d[ae]|ki|m[ıiuü]\S*)$/.test(words[1]!);
  const rightCount =
    words.length === 1
      ? lexicon.count(correct)
      : particlePair || (section === "CONTRACTION" && words.length === 2)
        ? // Spelled-out contractions ("ne yapıyorsun", "sağ ol") are rare as pairs in Wikipedia; each word must be
          // common and real on its own.
          Math.min(
            lexicon.count(words[0]!),
            particlePair ? Infinity : lexicon.count(words[1]!),
            morphology.isWord(words[0]!) ? Infinity : 0,
            particlePair || morphology.isWord(words[1]!) ? Infinity : 0,
          )
        : words.length === 2
          ? lexicon.pair(words[0]!, words[1]!)
          : 0;
  if (rightCount < minRight) {
    reject(`correct form seen ${rightCount} times`);
    continue;
  }
  if (words.length === 1 && !morphology.isWord(correct)) {
    reject("correct form not a word by morphology");
    continue;
  }
  if (morphology.isWord(wrong)) {
    reject("wrong form is a real word by morphology");
    continue;
  }
  accepted.push([wrong, correct, lexicon.count(wrong), rightCount, section].join("\t"));
}

console.log(`${accepted.length} accepted, ${rejected.length} rejected (categories: ${[...categories].join(", ")})`);
writeFileSync("data/rules/mined-rejected.tsv", "# wrong\tcorrect\tcategory\treason\tnote\n" + rejected.join("\n") + "\n");
if (dryRun) {
  console.log(accepted.slice(0, 40).join("\n"));
} else if (accepted.length > 0) {
  appendFileSync("data/rules/known.tsv", (knownText.endsWith("\n") ? "" : "\n") + accepted.join("\n") + "\n");
  console.log("appended to data/rules/known.tsv");
}
