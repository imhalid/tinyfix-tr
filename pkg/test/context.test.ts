import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALPHABET, FEATURE_DIM } from "../../src/context.ts";
import {
  CONTEXT_MODEL_FILE,
  ContextModel,
  SEQUENCE,
  createTdkai,
  loadTdkai,
  type ContextSessionLoader,
  type LoadProgress,
  type RawData,
  type RunModel,
} from "../src/index.ts";
import type { WorkerRequest, WorkerResponse } from "../src/protocol.ts";
import { createWorkerMessageHandler } from "../src/worker.ts";

const ALPHABET_CHARS = [...ALPHABET];

const CONTEXT_TEST_DATA: RawData = {
  unigrams: [
    "bugün\t8000\t100",
    "çok\t10000\t100",
    "adam\t5000\t100",
    "oldu\t5000\t0",
    "öldü\t2000\t0",
    "ben\t50000\t200",
    "de\t500000\t1000",
    "bende\t10000\t50",
    "geliyorum\t3000\t0",
    "herkes\t3709\t50",
  ].join("\n"),
  bigrams: "bir şey\t5325\n",
  known: "herkez\therkes\t0\t3709\tMISSPELLINGS\n",
};

/** Paketlenmiş tensör satırındaki aday (segment = 2) metnini geri çözer. */
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

/** Gerçek ONNX oturumu yerine aday metnine göre sabit puan döndüren sahte `RunModel`. */
function createFakeRunModel(
  scoreTable: Record<string, number>,
  calls?: Array<{ n: number; candidates: string[]; featuresLength: number }>,
): RunModel {
  return async (tokens, segments, n, features) => {
    assert.equal(tokens.length, n * SEQUENCE, "tokens uzunluğu n * SEQUENCE olmalı");
    assert.equal(segments.length, n * SEQUENCE, "segments uzunluğu n * SEQUENCE olmalı");
    if (features !== undefined) {
      assert.equal(features.length, n * FEATURE_DIM, "features uzunluğu n * FEATURE_DIM olmalı");
    }
    const scores = new Float32Array(n);
    const candidates: string[] = [];
    for (let row = 0; row < n; row++) {
      const candidate = decodeCandidate(tokens, segments, row);
      candidates.push(candidate);
      scores[row] = scoreTable[candidate] ?? 0;
    }
    calls?.push({ n, candidates, featuresLength: features?.length ?? 0 });
    return scores;
  };
}

function makeBinaryStream(bytes: Uint8Array, chunks = 2): ReadableStream<Uint8Array> {
  const size = Math.max(1, Math.ceil(bytes.byteLength / chunks));
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
      offset += size;
    },
  });
}

function createMockFetch(
  files: Record<string, string | Uint8Array>,
  requestedFiles?: string[],
): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.split("/").at(-1) ?? "";
    requestedFiles?.push(name);
    const content = files[name];
    if (content === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const headers = new Headers({
      "content-type": typeof content === "string" ? "text/tab-separated-values; charset=utf-8" : "application/octet-stream",
      "content-length": String(bytes.byteLength),
    });
    return new Response(makeBinaryStream(bytes, 3), { status: 200, headers });
  };
}

function createFakeWorker(
  mockFetch: typeof globalThis.fetch,
  loadContextSession?: ContextSessionLoader,
): Worker {
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

  const handle = createWorkerMessageHandler(
    (response) => {
      if (terminated) return;
      const event = { data: response } as MessageEvent<WorkerResponse>;
      fake.onmessage?.(event);
      for (const listener of listeners) listener(event);
    },
    { fetch: mockFetch, loadContextSession },
  );

  return fake as unknown as Worker;
}

describe("bağlam modeli (sahte RunModel ile)", () => {
  it("bağlam modeli olmadan belirsiz gerçek kelimelere dokunmaz, model ile düzeltir", async () => {
    const withoutContext = createTdkai(CONTEXT_TEST_DATA);
    const calls: Array<{ n: number; candidates: string[]; featuresLength: number }> = [];
    const fakeRun = createFakeRunModel(
      {
        oldu: 0,
        öldü: 4.2,
        bende: 0,
        "ben de": 4.5,
      },
      calls,
    );
    const withContext = createTdkai(CONTEXT_TEST_DATA, { contextModel: fakeRun });

    try {
      assert.equal(withoutContext.hasContext, false);
      assert.equal(withContext.hasContext, true);

      // Model yalnızca eğitimdeki gibi küçük harfli kelimelere sorulur (src/corrector.ts › contestedSpans).
      const text = "Yarın bende geliyorum, adam oldu.";
      assert.equal(await withoutContext.fix(text), text);

      const fixes = await withContext.check(text);
      assert.equal(fixes.length, 2);
      assert.deepEqual(
        fixes.map((fix) => [fix.original, fix.replacement, fix.kind]),
        [
          ["bende", "ben de", "bitisik-ayri"],
          ["oldu", "öldü", "turkce-karakter"],
        ],
      );
      assert.equal(await withContext.fix(text), "Yarın ben de geliyorum, adam öldü.");
      assert.ok(calls.length >= 2);
      assert.ok(calls[0]!.candidates.includes("ben de"));
      assert.ok(calls[0]!.candidates.includes("öldü"));
      assert.equal(calls[0]!.featuresLength, calls[0]!.n * FEATURE_DIM);

      // kinds ve range filtreleri bağlam düzeltmeleri için de çalışır
      const onlySpacing = await withContext.check(text, { kinds: ["bitisik-ayri"] });
      assert.deepEqual(
        onlySpacing.map((fix) => fix.replacement),
        ["ben de"],
      );

      const olduStart = text.indexOf("oldu");
      const onlyRange = await withContext.check(text, { range: [olduStart, olduStart + 4] });
      assert.deepEqual(
        onlyRange.map((fix) => fix.replacement),
        ["öldü"],
      );

      // ignore ve satır içi kod koruması bağlam düzeltmelerinde de geçerlidir
      assert.equal(await withContext.fix("Yarın `bende` geliyorum."), "Yarın `bende` geliyorum.");
      withContext.ignore("oldu");
      assert.equal(await withContext.fix(text), "Yarın ben de geliyorum, adam oldu.");
    } finally {
      await withoutContext.dispose();
      await withContext.dispose();
    }
  });

  it("careful (3.0) ve balanced (2.5) bağlam eşik farkını uygular", async () => {
    const fakeRun = createFakeRunModel({
      oldu: 0,
      öldü: 2.7,
    });
    const autr = createTdkai(CONTEXT_TEST_DATA, { mode: "careful", contextModel: fakeRun });
    try {
      assert.equal(await autr.fix("Adam oldu."), "Adam oldu.");
      assert.equal(await autr.fix("Adam oldu.", { mode: "balanced" }), "Adam öldü.");
      autr.setMode("balanced");
      assert.equal(await autr.fix("Adam oldu."), "Adam öldü.");
    } finally {
      await autr.dispose();
    }
  });

  it("context: false (varsayılan) iken context.onnx dosyasını indirmez", async () => {
    const requested: string[] = [];
    const mockFetch = createMockFetch(
      {
        "unigrams.tsv": CONTEXT_TEST_DATA.unigrams,
        "bigrams.tsv": CONTEXT_TEST_DATA.bigrams,
        "known.tsv": CONTEXT_TEST_DATA.known,
        [CONTEXT_MODEL_FILE]: new Uint8Array([1, 2, 3, 4]),
      },
      requested,
    );

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      fetch: mockFetch,
    });

    try {
      assert.equal(autr.hasContext, false);
      assert.ok(!requested.includes(CONTEXT_MODEL_FILE), "context: false iken context.onnx istenmemeli");
    } finally {
      await autr.dispose();
    }
  });

  it("context: true iken context.onnx dosyasını ilerlemeyle indirir, wasmPaths iletir ve dispose eder", async () => {
    const fakeOnnxBytes = new Uint8Array([0x08, 0x09, 0x10, 0x11, 0x12, 0x13]);
    const events: LoadProgress[] = [];
    const warnings: string[] = [];
    let receivedBytes: Uint8Array | null = null;
    let receivedWasmPaths: string | undefined;
    let disposedCount = 0;

    const mockFetch = createMockFetch({
      "unigrams.tsv": CONTEXT_TEST_DATA.unigrams,
      "bigrams.tsv": CONTEXT_TEST_DATA.bigrams,
      "known.tsv": CONTEXT_TEST_DATA.known,
      [CONTEXT_MODEL_FILE]: fakeOnnxBytes,
    });

    const loader: ContextSessionLoader = async (bytes, options) => {
      receivedBytes = bytes;
      receivedWasmPaths = options.wasmPaths;
      return {
        model: new ContextModel(createFakeRunModel({ oldu: 0, öldü: 4.0 })),
        dispose: async () => {
          disposedCount++;
        },
      };
    };

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      context: true,
      wasmPaths: "https://example.test/ort",
      fetch: mockFetch,
      loadContextSession: loader,
      onProgress: (progress) => events.push({ ...progress }),
      onWarning: (warning) => warnings.push(warning),
    });

    assert.equal(autr.hasContext, true);
    assert.deepEqual(warnings, []);
    assert.deepEqual(receivedBytes, fakeOnnxBytes);
    assert.equal(receivedWasmPaths, "https://example.test/ort/");
    assert.ok(
      events.some((event) => event.stage === "downloading" && event.file === CONTEXT_MODEL_FILE),
      "indirme ilerlemesi context.onnx dosyasını kapsamalı",
    );
    assert.equal(events.at(-1)?.stage, "ready");
    assert.equal(events.at(-1)?.ratio, 1);

    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i]!.ratio >= events[i - 1]!.ratio, "ilerleme oranı geriye gitmemeli");
      assert.ok(events[i]!.ratio >= 0 && events[i]!.ratio <= 1);
    }

    assert.equal(await autr.fix("Adam oldu."), "Adam öldü.");

    await autr.dispose();
    assert.equal(disposedCount, 1);
  });

  it("context.onnx eksikse uyarı verir ve bağlam modeli olmadan çalışmaya devam eder", async () => {
    const warnings: string[] = [];
    const events: LoadProgress[] = [];
    const mockFetch = createMockFetch({
      "unigrams.tsv": CONTEXT_TEST_DATA.unigrams,
      "bigrams.tsv": CONTEXT_TEST_DATA.bigrams,
      "known.tsv": CONTEXT_TEST_DATA.known,
    });

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      context: true,
      fetch: mockFetch,
      onProgress: (progress) => events.push({ ...progress }),
      onWarning: (warning) => warnings.push(warning),
    });

    try {
      assert.equal(autr.hasContext, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /context\.onnx/);
      assert.equal(events.at(-1)?.stage, "ready");
      assert.equal(events.at(-1)?.ratio, 1);
      assert.equal(await autr.fix("Bugün cok herkez geldi."), "Bugün çok herkes geldi.");
      assert.equal(await autr.fix("Adam oldu."), "Adam oldu.");
    } finally {
      await autr.dispose();
    }
  });

  it("bağlam oturumu başlatılamazsa uyarı verir ve sözlükle devam eder", async () => {
    const warnings: string[] = [];
    const mockFetch = createMockFetch({
      "unigrams.tsv": CONTEXT_TEST_DATA.unigrams,
      "bigrams.tsv": CONTEXT_TEST_DATA.bigrams,
      "known.tsv": CONTEXT_TEST_DATA.known,
      [CONTEXT_MODEL_FILE]: new Uint8Array([1, 2, 3]),
    });

    const failingLoader: ContextSessionLoader = async () => {
      throw new Error("WASM başlatılamadı");
    };

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      context: true,
      fetch: mockFetch,
      loadContextSession: failingLoader,
      onWarning: (warning) => warnings.push(warning),
    });

    try {
      assert.equal(autr.hasContext, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /WASM başlatılamadı/);
      assert.equal(await autr.fix("Bugün cok."), "Bugün çok.");
    } finally {
      await autr.dispose();
    }
  });

  it("worker modunda bağlam modelini worker içinde yükler, çalıştırır ve eksik dosyada uyarır", async () => {
    const fakeOnnxBytes = new Uint8Array([9, 8, 7, 6]);
    let workerWasmPaths: string | undefined;
    const progressFiles = new Set<string>();

    const mockFetchOk = createMockFetch({
      "unigrams.tsv": CONTEXT_TEST_DATA.unigrams,
      "bigrams.tsv": CONTEXT_TEST_DATA.bigrams,
      "known.tsv": CONTEXT_TEST_DATA.known,
      [CONTEXT_MODEL_FILE]: fakeOnnxBytes,
    });

    const workerLoader: ContextSessionLoader = async (bytes, options) => {
      assert.deepEqual(bytes, fakeOnnxBytes);
      workerWasmPaths = options.wasmPaths;
      return {
        model: new ContextModel(createFakeRunModel({ bende: 0, "ben de": 4.2 })),
        dispose: async () => {},
      };
    };

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      worker: true,
      context: true,
      wasmPaths: "https://example.test/ort/",
      createWorker: () => createFakeWorker(mockFetchOk, workerLoader),
      onProgress: (progress) => {
        if (progress.file) progressFiles.add(progress.file);
      },
    });

    try {
      assert.equal(autr.hasContext, true);
      assert.equal(workerWasmPaths, "https://example.test/ort/");
      assert.ok(progressFiles.has(CONTEXT_MODEL_FILE));
      assert.equal(await autr.fix("Yarın bende geliyorum."), "Yarın ben de geliyorum.");
    } finally {
      await autr.dispose();
    }

    // Worker modunda context.onnx eksikse uyarı ana iş parçacığına iletilir ve sözlük çalışır
    const workerWarnings: string[] = [];
    const mockFetchMissing = createMockFetch({
      "unigrams.tsv": CONTEXT_TEST_DATA.unigrams,
      "bigrams.tsv": CONTEXT_TEST_DATA.bigrams,
      "known.tsv": CONTEXT_TEST_DATA.known,
    });

    const fallbackAutr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      worker: true,
      context: true,
      createWorker: () => createFakeWorker(mockFetchMissing),
      onWarning: (warning) => workerWarnings.push(warning),
    });

    try {
      assert.equal(fallbackAutr.hasContext, false);
      assert.equal(workerWarnings.length, 1);
      assert.match(workerWarnings[0]!, /context\.onnx/);
      assert.equal(await fallbackAutr.fix("Herkez geldi."), "Herkes geldi.");
    } finally {
      await fallbackAutr.dispose();
    }
  });
});
