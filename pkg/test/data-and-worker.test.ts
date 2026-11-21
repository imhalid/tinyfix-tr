import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeBinaryLexicon } from "../../src/lexicon-binary.ts";
import { encodeBinaryDictionary } from "../../src/morphology/binary.ts";
import { parseDictionaries } from "../../src/morphology/dictionary.ts";
import { createTdkai, loadTdkai, type BinaryData, type LoadProgress, type RawData } from "../src/index.ts";
import type { WorkerRequest, WorkerResponse } from "../src/protocol.ts";
import { createWorkerMessageHandler } from "../src/worker.ts";

const SMALL_DATA: RawData = {
  unigrams: [
    "bugün\t8000\t100",
    "çok\t10000\t100",
    "herkes\t3709\t50",
    "geldi\t20000\t100",
    "soz\t5\t0",
    "söz\t80\t0",
  ].join("\n"),
  bigrams: "bir şey\t5325\n",
  known: "herkez\therkes\t0\t3709\tMISSPELLINGS\n",
};

function makeChunkedStream(text: string, chunks = 2): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
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
  files: Record<string, string>,
  options: { gzipHeader?: boolean } = {},
): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.split("/").at(-1) ?? "";
    const content = files[name];
    if (content === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    const bytes = new TextEncoder().encode(content);
    const headers = new Headers({
      "content-type": "text/tab-separated-values; charset=utf-8",
      "content-length": String(options.gzipHeader ? Math.max(1, Math.floor(bytes.byteLength / 2)) : bytes.byteLength),
    });
    if (options.gzipHeader) {
      headers.set("content-encoding", "gzip");
    }
    return new Response(makeChunkedStream(content, 3), { status: 200, headers });
  };
}

/** Node ortamında Worker arayüzünü gerçek mesaj işleyiciye bağlayan sahte Worker. */
function createFakeWorker(mockFetch: typeof globalThis.fetch): Worker {
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
    { fetch: mockFetch },
  );

  return fake as unknown as Worker;
}

describe("veri yükleme ve ilerleme bildirimi", () => {
  it("baseUrl altından TSV dosyalarını indirir ve ilerleme bildirir", async () => {
    const events: LoadProgress[] = [];
    const mockFetch = createMockFetch({
      "unigrams.tsv": SMALL_DATA.unigrams,
      "bigrams.tsv": SMALL_DATA.bigrams,
      "known.tsv": SMALL_DATA.known,
    });

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      fetch: mockFetch,
      onProgress: (progress) => events.push({ ...progress }),
    });

    try {
      assert.equal(await autr.fix("Bugün cok herkez geldi."), "Bugün çok herkes geldi.");
      assert.ok(events.length >= 3, "en az üç ilerleme olayı bekleniyor");
      assert.equal(events[0]!.stage, "downloading");
      assert.ok(events.some((event) => event.stage === "parsing"));
      assert.equal(events.at(-1)!.stage, "ready");
      assert.equal(events.at(-1)!.ratio, 1);

      for (let i = 1; i < events.length; i++) {
        assert.ok(events[i]!.ratio >= events[i - 1]!.ratio, "ilerleme oranı geriye gitmemeli");
        assert.ok(events[i]!.ratio >= 0 && events[i]!.ratio <= 1, "ilerleme oranı 0..1 arasında olmalı");
      }
    } finally {
      await autr.dispose();
    }
  });

  it("sıkıştırılmış yanıtlarda ilerleme oranını 1 üzerinde taşırmaz", async () => {
    const events: LoadProgress[] = [];
    const mockFetch = createMockFetch(
      {
        "unigrams.tsv": SMALL_DATA.unigrams,
        "bigrams.tsv": SMALL_DATA.bigrams,
        "known.tsv": SMALL_DATA.known,
      },
      { gzipHeader: true },
    );

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      fetch: mockFetch,
      onProgress: (progress) => events.push({ ...progress }),
    });

    try {
      assert.equal(events.at(-1)!.ratio, 1);
      for (const event of events) {
        assert.ok(event.ratio >= 0 && event.ratio <= 1);
      }
    } finally {
      await autr.dispose();
    }
  });

  it("eksik dosyada anlaşılır hata fırlatır", async () => {
    const mockFetch = createMockFetch({
      "unigrams.tsv": SMALL_DATA.unigrams,
    });

    await assert.rejects(
      () => loadTdkai({ baseUrl: "https://example.test/models/", fetch: mockFetch }),
      /404/,
    );
  });
});

describe("Web Worker protokolü", () => {
  it("worker modunda yükleme, ilerleme, check, ignore, setMode ve dispose çalışır", async () => {
    const progressStages: string[] = [];
    const mockFetch = createMockFetch({
      "unigrams.tsv": SMALL_DATA.unigrams,
      "bigrams.tsv": SMALL_DATA.bigrams,
      "known.tsv": SMALL_DATA.known,
    });

    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      worker: true,
      createWorker: () => createFakeWorker(mockFetch),
      onProgress: (progress) => progressStages.push(progress.stage),
    });

    assert.ok(progressStages.includes("downloading"));
    assert.ok(progressStages.includes("parsing"));
    assert.equal(progressStages.at(-1), "ready");

    const fixes = await autr.check("Bugün cok herkez geldi.");
    assert.equal(fixes.length, 2);
    assert.equal(autr.apply("Bugün cok herkez geldi.", fixes), "Bugün çok herkes geldi.");

    autr.ignore("herkez");
    assert.equal(await autr.fix("Bugün cok herkez geldi."), "Bugün çok herkez geldi.");

    autr.unignore("herkez");
    assert.equal(await autr.fix("Herkez geldi."), "Herkes geldi.");

    assert.equal(await autr.fix("soz"), "soz");
    autr.setMode("balanced");
    assert.equal(await autr.fix("soz"), "söz");

    await autr.dispose();
    await assert.rejects(() => autr.check("cok"));
  });
});

function createBinaryMockFetch(
  files: Record<string, string | Uint8Array>,
  requested?: string[],
): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.split("/").at(-1) ?? "";
    requested?.push(name);
    const content = files[name];
    if (content === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": name.endsWith(".json")
          ? "application/json"
          : name.endsWith(".tsv")
            ? "text/tab-separated-values; charset=utf-8"
            : "application/octet-stream",
      },
    });
  };
}

function buildMiniBinaryBundle(): BinaryData {
  const lexicon = encodeBinaryLexicon({
    unigrams: [
      { form: "bugün", count: 8000, capitalized: 100 },
      { form: "çok", count: 10000, capitalized: 100 },
      { form: "getirmek", count: 5000, capitalized: 10 },
      { form: "boyun", count: 2000, capitalized: 10 },
      { form: "boyunu", count: 300, capitalized: 0 },
      { form: "boyunda", count: 2000, capitalized: 0 },
      { form: "yüklemek", count: 3000, capitalized: 0 },
      { form: "yüklediniz", count: 50, capitalized: 0 },
      { form: "herkes", count: 3709, capitalized: 50 },
      { form: "geldi", count: 20000, capitalized: 100 },
    ],
    bigrams: [{ first: "bir", second: "şey", count: 5325 }],
  });
  const morphItems = parseDictionaries(["getirmek [A:Aorist_I]\nboy\nyüklemek\n"]);
  const morphology = encodeBinaryDictionary(morphItems);
  const known = "herkez\therkes\t0\t3709\tMISSPELLINGS\n";
  return { lexicon, morphology, known };
}

describe("ikili sözlük ve biçimbilim yükleme", () => {
  it("manifest.json ile lexicon.bin + morph.bin + known.tsv yükler ve biçimbilimi kullanır", async () => {
    const bundle = buildMiniBinaryBundle();
    const requested: string[] = [];
    const manifest = JSON.stringify({
      "lexicon.bin": bundle.lexicon.byteLength,
      "morph.bin": bundle.morphology!.byteLength,
      "known.tsv": new TextEncoder().encode(bundle.known).byteLength,
    });
    const mockFetch = createBinaryMockFetch(
      {
        "manifest.json": manifest,
        "lexicon.bin": bundle.lexicon,
        "morph.bin": bundle.morphology!,
        "known.tsv": bundle.known,
      },
      requested,
    );

    const events: LoadProgress[] = [];
    const autr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      fetch: mockFetch,
      onProgress: (progress) => events.push({ ...progress }),
    });

    try {
      // Eski TSV dosyaları hiç istenmemeli
      assert.ok(!requested.includes("unigrams.tsv"));
      assert.ok(!requested.includes("bigrams.tsv"));
      assert.ok(requested.includes("lexicon.bin"));
      assert.ok(requested.includes("morph.bin"));

      // Biçimbilim: nadir ama geçerli "getirsek" korunur (getirmek yapılmaz), "boyunuda" -> "boyunu da", "yükledinizmi?" -> "yüklediniz mi?"
      assert.equal(await autr.fix("Bugün getirsek olur."), "Bugün getirsek olur.");
      assert.equal(await autr.fix("Boyunuda aldım, yükledinizmi?"), "Boyunu da aldım, yüklediniz mi?");
      assert.equal(await autr.fix("Herkez cok geldi."), "Herkes çok geldi.");
      assert.equal(events.at(-1)?.stage, "ready");
      assert.equal(events.at(-1)?.ratio, 1);
    } finally {
      await autr.dispose();
    }
  });

  it("createTdkai ve Web Worker ikili sözlük + biçimbilim ile çalışır", async () => {
    const bundle = buildMiniBinaryBundle();
    const direct = createTdkai(bundle);
    try {
      assert.equal(await direct.fix("Getirsek boyunuda yükledinizmi?"), "Getirsek boyunu da yüklediniz mi?");
    } finally {
      await direct.dispose();
    }

    const mockFetch = createBinaryMockFetch({
      "lexicon.bin": bundle.lexicon,
      "morph.bin": bundle.morphology!,
      "known.tsv": bundle.known,
    });
    const workerAutr = await loadTdkai({
      baseUrl: "https://example.test/models/",
      worker: true,
      createWorker: () => createFakeWorker(mockFetch),
    });
    try {
      assert.equal(await workerAutr.fix("Getirsek boyunuda yükledinizmi?"), "Getirsek boyunu da yüklediniz mi?");
    } finally {
      await workerAutr.dispose();
    }
  });
});
