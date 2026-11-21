import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeBinaryLexicon } from "../../src/lexicon-binary.ts";
import { encodeBinaryDictionary } from "../../src/morphology/binary.ts";
import { parseDictionaries } from "../../src/morphology/dictionary.ts";
import { MorphPrior } from "../../src/morphology/prior.ts";
import { ALPHABET, SEQUENCE } from "../../src/context.ts";
import {
  createTdkai,
  loadTdkai,
  type BinaryData,
  type RunModel,
} from "../src/index.ts";
import type { WorkerRequest, WorkerResponse } from "../src/protocol.ts";
import { createWorkerMessageHandler } from "../src/worker.ts";

const ALPHABET_CHARS = [...ALPHABET];

function buildInspectBundle(): BinaryData {
  const lexicon = encodeBinaryLexicon({
    unigrams: [
      { form: "bugün", count: 8000, capitalized: 100 },
      { form: "çok", count: 10000, capitalized: 100 },
      { form: "metinleri", count: 500, capitalized: 0 },
      { form: "hatalarını", count: 400, capitalized: 0 },
      { form: "düzenlemek", count: 1200, capitalized: 10 },
      { form: "düzenle", count: 120, capitalized: 5 },
      { form: "düzenleniyor", count: 150, capitalized: 0 },
      { form: "bak", count: 800, capitalized: 10 },
      { form: "bka", count: 20, capitalized: 0 },
      { form: "burada", count: 30000, capitalized: 100 },
      { form: "ankara", count: 50000, capitalized: 49000 },
      { form: "ankara'ya", count: 4000, capitalized: 3900 },
      { form: "herkes", count: 3709, capitalized: 50 },
      { form: "geldi", count: 20000, capitalized: 100 },
    ],
    bigrams: [{ first: "bir", second: "şey", count: 5325 }],
  });
  const morphItems = parseDictionaries([
    "düzenlemek\n",
    "bakmak\n",
    "metin [A:LastVowelDrop]\n",
    "hata\n",
    "burada [P:Adv]\n",
    "bugün [P:Adv]\n",
    "çok [P:Adv]\n",
    "herkes [P:Pron]\n",
    "gelmek [A:Aorist_I]\n",
  ]);
  const prior = new MorphPrior({
    lemmaCounts: new Map([
      ["düzenle|Verb", 75000],
      ["bak|Verb", 50000],
    ]),
    chainProbs: new Map([
      ["Verb|Neg+Prog1+A3sg", 0.002],
      ["Verb|Pass+Verb+Prog1+A3sg", 0.0007],
      ["Verb|Imp+A2sg", 0.02],
    ]),
    bigramProbs: new Map([
      ["^Verb>Neg", 0.08],
      ["Neg>Prog1", 0.12],
      ["Prog1>A3sg", 0.45],
      ["A3sg>$", 0.8],
    ]),
  });
  const morphology = encodeBinaryDictionary(morphItems, prior);
  const known = "herkez\therkes\t0\t3709\tMISSPELLINGS\n";
  return { lexicon, morphology, known };
}

function decodeCandidate(tokens: BigInt64Array, segments: BigInt64Array, row: number): string {
  let out = "";
  const base = row * SEQUENCE;
  for (let i = 0; i < SEQUENCE; i++) {
    if (segments[base + i] === 2n) {
      const id = Number(tokens[base + i]);
      if (id >= 2) out += ALPHABET_CHARS[id - 2] ?? "";
    }
  }
  return out;
}

function createScoreRunModel(scores: Record<string, number>): RunModel {
  return async (tokens, segments, n) => {
    const out = new Float32Array(n);
    for (let row = 0; row < n; row++) {
      out[row] = scores[decodeCandidate(tokens, segments, row)] ?? 0;
    }
    return out;
  };
}

function createFakeWorker(bundle: BinaryData, contextModel?: RunModel): Worker {
  const listeners = new Set<(event: MessageEvent<WorkerResponse>) => void>();
  let terminated = false;
  const fake = {
    onmessage: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: WorkerRequest) {
      if (terminated) return;
      queueMicrotask(() => {
        if (!terminated) void handle(message);
      });
    },
    addEventListener(type: string, listener: (event: MessageEvent<WorkerResponse>) => void) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MessageEvent<WorkerResponse>) => void) {
      if (type === "message") listeners.delete(listener);
    },
    terminate() {
      terminated = true;
      listeners.clear();
    },
  };

  const mockFetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.split("/").at(-1) ?? "";
    if (name === "context.onnx" && contextModel) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  };

  const handle = createWorkerMessageHandler(
    (response) => {
      if (terminated) return;
      const event = { data: response } as MessageEvent<WorkerResponse>;
      fake.onmessage?.(event);
      for (const listener of listeners) listener(event);
    },
    {
      fetch: mockFetch,
      loadContextSession: contextModel
        ? async () => {
            const { wrapContextModel } = await import("../src/context.ts");
            return wrapContextModel(contextModel);
          }
        : undefined,
    },
  );
  return fake as unknown as Worker;
}

describe("inspect() paket API ve Worker desteği", () => {
  it("düzeltmeleri ve işaretleri ayrı döndürür, range/kinds/autoMarked/ignore/kod kurallarına uyar", async () => {
    const bundle = buildInspectBundle();
    const autr = createTdkai(bundle);
    try {
      const text = "Bugün cok herkez hatalarını duzenlemniyor bka Ankara'ya `duzenlemniyor` geldi.";
      const res = await autr.inspect(text);

      // Otomatik düzeltmeler: cok -> çok, herkez -> herkes
      assert.deepEqual(
        res.fixes.map((f) => [f.original, f.replacement]),
        [
          ["cok", "çok"],
          ["herkez", "herkes"],
        ],
      );

      // İşaretler: duzenlemniyor (invalid) ve bka (rare); Ankara'ya ve kod içi `duzenlemniyor` işaretlenmez
      assert.equal(res.flags.length, 2);
      const duzen = res.flags.find((f) => f.original === "duzenlemniyor");
      const bka = res.flags.find((f) => f.original === "bka");
      assert.ok(duzen);
      assert.equal(text.slice(duzen.from, duzen.to), "duzenlemniyor");
      assert.equal(duzen.reason, "invalid");
      assert.ok(duzen.suggestions.includes("düzenlemiyor"));
      assert.ok(duzen.suggestions.length <= 5);

      assert.ok(bka);
      assert.equal(text.slice(bka.from, bka.to), "bka");
      assert.equal(bka.reason, "rare");
      assert.equal(bka.suggestions[0], "bak");

      // range filtresi yalnızca ilgili aralıktaki işaretleri ve düzeltmeleri döndürür
      const bkaRange: readonly [number, number] = [bka.from, bka.to];
      const inRange = await autr.inspect(text, { range: bkaRange });
      assert.deepEqual(inRange.fixes, []);
      assert.deepEqual(
        inRange.flags.map((f) => f.original),
        ["bka"],
      );

      // kinds filtresi: "yazim" yoksa işaretler döndürülmez; "yazim" varsa döndürülür
      const onlyMarks = await autr.inspect(text, { kinds: ["turkce-karakter"] });
      assert.deepEqual(
        onlyMarks.fixes.map((f) => f.original),
        ["cok"],
      );
      assert.deepEqual(onlyMarks.flags, []);

      const onlySpelling = await autr.inspect(text, { kinds: ["yazim"] });
      assert.deepEqual(
        onlySpelling.fixes.map((f) => f.original),
        ["herkez"],
      );
      assert.equal(onlySpelling.flags.length, 2);

      // ignore() edilen kelimeler işaretlenmez; unignore() sonrası geri gelir
      autr.ignore("DUZENLEMNİYOR");
      const afterIgnore = await autr.inspect(text);
      assert.deepEqual(
        afterIgnore.flags.map((f) => f.original),
        ["bka"],
      );
      autr.unignore("duzenlemniyor");
      const afterUnignore = await autr.inspect(text);
      assert.equal(afterUnignore.flags.length, 2);

      // autoMarked seçeneği inspect ile de check gibi çalışır
      const autoText = "Bugün cok geldi.";
      const autoRes = await autr.inspect(autoText, { autoMarked: [[0, 5]] });
      assert.equal(autoRes.fixes[0]?.replacement, "çok");
    } finally {
      await autr.dispose();
    }
  });

  it("bağlam modeli yüklüyse inspect() önerileri cümleye göre yeniden sıralar", async () => {
    const bundle = buildInspectBundle();
    const fakeRun = createScoreRunModel({
      düzenleniyor: 1.1,
      düzenlemiyor: -0.1,
    });
    const autr = createTdkai(bundle, { contextModel: fakeRun });
    try {
      const res = await autr.inspect("Bugün hatalarını duzenlemniyor.");
      const flag = res.flags.find((f) => f.original === "duzenlemniyor");
      assert.ok(flag);
      assert.equal(flag.suggestions[0], "düzenleniyor");
    } finally {
      await autr.dispose();
    }
  });

  it("Web Worker protokolü inspect() ve ignore() ile uçtan uca çalışır", async () => {
    const bundle = buildInspectBundle();
    const autr = await loadTdkai({
      data: bundle,
      worker: true,
      createWorker: () => createFakeWorker(bundle),
    });
    try {
      const text = "Bugün cok hatalarını duzenlemniyor bka geldi.";
      const res = await autr.inspect(text);
      assert.deepEqual(
        res.fixes.map((f) => [f.original, f.replacement]),
        [["cok", "çok"]],
      );
      assert.deepEqual(
        res.flags.map((f) => [f.original, f.reason]),
        [
          ["duzenlemniyor", "invalid"],
          ["bka", "rare"],
        ],
      );

      autr.ignore("bka");
      const res2 = await autr.inspect(text);
      assert.deepEqual(
        res2.flags.map((f) => f.original),
        ["duzenlemniyor"],
      );
    } finally {
      await autr.dispose();
    }
    await assert.rejects(() => autr.inspect("duzenlemniyor"));
  });
});
