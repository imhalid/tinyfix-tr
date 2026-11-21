import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FIX_KINDS, createAutr, type RawData } from "../src/index.ts";

const DATA: RawData = {
  unigrams: ["burada\t5000\t10", "ne\t90000\t100", "oldu\t5000\t0", "bilmiyorum\t2000\t0", "herkes\t3709\t50"].join("\n"),
  bigrams: "ne oldu\t800\n",
  known: [
    "herkez\therkes\t0\t3709\tMISSPELLINGS",
    "burda\tburada\t0\t5000\tCONTRACTION",
    "noldu\tne oldu\t0\t800\tCONTRACTION",
  ].join("\n"),
};

describe("konuşma dili kısaltmaları", () => {
  it("varsayılan türlerde kısaltmalara dokunmaz, yazım yanlışlarını düzeltir", async () => {
    assert.ok(!DEFAULT_FIX_KINDS.includes("kisaltma"));
    const autr = createAutr(DATA);
    try {
      assert.equal(await autr.fix("Burda noldu, herkez bilmiyorum."), "Burda noldu, herkes bilmiyorum.");
    } finally {
      await autr.dispose();
    }
  });

  it("kisaltma türü istenince açar ve türünü kisaltma olarak bildirir", async () => {
    const autr = createAutr(DATA);
    try {
      const fixes = await autr.check("Burda noldu?", { kinds: [...DEFAULT_FIX_KINDS, "kisaltma"] });
      assert.deepEqual(
        fixes.map((fix) => [fix.original, fix.replacement, fix.kind]),
        [
          ["Burda", "Burada", "kisaltma"],
          ["noldu", "ne oldu", "kisaltma"],
        ],
      );
    } finally {
      await autr.dispose();
    }
  });
});
