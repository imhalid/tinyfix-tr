import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Lexicon } from "./lexicon.ts";
import { encodeBinaryLexicon } from "./lexicon-binary.ts";

describe("BinaryLexicon (ALX1)", () => {
  test("encodes and decodes unigrams, capitalShare, split-CSR bigrams, and Bloom tiers", () => {
    const bytes = encodeBinaryLexicon({
      unigrams: [
        { form: "ankara", count: 50000, capitalized: 49000 },
        { form: "ankara'ya", count: 4000, capitalized: 3900 },
        { form: "bir", count: 2_500_000, capitalized: 10000 },
        { form: "çok", count: 10000, capitalized: 100 },
        { form: "de", count: 500000, capitalized: 1000 },
        { form: "ev", count: 10000, capitalized: 100 },
        { form: "evde", count: 8000, capitalized: 50 },
        { form: "hiç", count: 40000, capitalized: 100 },
        { form: "hiçbir", count: 20772, capitalized: 100 },
        { form: "şey", count: 50000, capitalized: 100 },
        { form: "şöför", count: 17, capitalized: 0 },
        { form: "zeytin", count: 4, capitalized: 2 },
        { form: "a", count: 79, capitalized: 0 },
      ],
      bigrams: [
        { first: "bir", second: "şey", count: 5325, groupBySecond: false },
        { first: "hiç", second: "bir", count: 45, groupBySecond: false },
        { first: "ev", second: "de", count: 10, groupBySecond: true },
        { first: "çok", second: "de", count: 3, groupBySecond: true },
      ],
      bloomTiers: [
        { returnCount: 3, bitsPerItem: 16, words: ["nadirüç", "üçüncüform"] },
        { returnCount: 2, bitsPerItem: 14, words: ["nadiriki", "ikinciform"] },
      ],
      blockSize: 4,
      exactCountMax: 80,
      countBuckets: 256,
      countMaxVal: 3_000_000,
      capMax: 50,
    });

    const lex = Lexicon.fromBinary(bytes);
    assert.equal(lex.size, 17); // 13 exact + 4 Bloom tail
    assert.equal(lex.pairCount, 4);

    // Exact small counts (< 80)
    assert.equal(lex.count("zeytin"), 4);
    assert.equal(lex.count("şöför"), 17);
    assert.equal(lex.count("a"), 79);

    // Quantized large counts (within 5% relative tolerance)
    assert.ok(Math.abs(lex.count("ankara") - 50000) / 50000 < 0.05);
    assert.ok(Math.abs(lex.count("bir") - 2_500_000) / 2_500_000 < 0.05);
    assert.ok(Math.abs(lex.count("ankara'ya") - 4000) / 4000 < 0.05);

    // Capital share (step 0.02)
    assert.ok(Math.abs(lex.capitalShare("ankara") - 0.98) <= 0.02);
    assert.ok(Math.abs(lex.capitalShare("zeytin") - 0.5) <= 0.02);
    assert.equal(lex.capitalShare("şöför"), 0);
    assert.equal(lex.capitalShare("yokboylekelime"), 0);

    // Bigrams (both byFirst and bySecond partitions)
    assert.ok(Math.abs(lex.pair("bir", "şey") - 5325) / 5325 < 0.05);
    assert.equal(lex.pair("hiç", "bir"), 45);
    assert.equal(lex.pair("ev", "de"), 10);
    assert.equal(lex.pair("çok", "de"), 3);
    assert.equal(lex.pair("ev", "şey"), 0);
    assert.equal(lex.pair("bilinmeyen", "de"), 0);

    // Bloom tail tiers
    assert.equal(lex.count("nadirüç"), 3);
    assert.equal(lex.count("üçüncüform"), 3);
    assert.equal(lex.count("nadiriki"), 2);
    assert.equal(lex.count("ikinciform"), 2);
    assert.equal(lex.count("kesinlikleyoktur123"), 0);
    assert.equal(lex.count(""), 0);

    // exactCount skips Bloom tail tiers (used for typo target lookups)
    assert.equal(lex.exactCount("zeytin"), 4);
    assert.ok(Math.abs(lex.exactCount("ankara'ya") - 4000) / 4000 < 0.05);
    assert.equal(lex.exactCount("nadirüç"), 0);
    assert.equal(lex.exactCount("nadiriki"), 0);

    // Apostrophe forms skip Bloom tail probes (only matched in exact table)
    assert.equal(lex.count("nadir'üç"), 0);
    assert.ok(Math.abs(lex.count("ankara'ya") - 4000) / 4000 < 0.05);

    // Non-alphabet characters safely return 0
    assert.equal(lex.count("hello123"), 0);
    assert.equal(lex.count("test@example"), 0);

    // toTsv() round-trip includes exact entries
    const tsv = lex.toTsv();
    assert.ok(tsv.unigrams.includes("ankara'ya\t"));
    assert.ok(tsv.bigrams.includes("ev de\t10"));
    assert.ok(tsv.bigrams.includes("hiç bir\t45"));
  });

  test("handles empty lexicon and rejects corrupted headers", () => {
    const empty = Lexicon.fromBinary(encodeBinaryLexicon({ unigrams: [], bigrams: [] }));
    assert.equal(empty.size, 0);
    assert.equal(empty.pairCount, 0);
    assert.equal(empty.count("ev"), 0);
    assert.equal(empty.pair("ev", "de"), 0);

    assert.throws(() => Lexicon.fromBinary(new Uint8Array([0, 1, 2, 3, 4])), /ALX1/);
  });
});
