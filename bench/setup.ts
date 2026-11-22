/** Loads the lexicon, listed misspellings and morphology the way the bench tools and tests use them. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { loadData } from "../pkg/src/data.ts";
import { Corrector } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { TurkishMorphology } from "../src/morphology/index.ts";

export const MORPHOLOGY_FILES = ["master-dictionary.dict", "non-tdk.dict", "informal.dict", "proper.dict"];

export function loadMorphology(): TurkishMorphology {
  const binPath = "site/public/models/morph.bin";
  if (existsSync(binPath)) {
    return TurkishMorphology.fromBinary(readFileSync(binPath));
  }
  return TurkishMorphology.fromDictionaries(MORPHOLOGY_FILES.map((name) => readFileSync(`data/morph/${name}`, "utf8")));
}

/** Creates a local file-backed fetch adapter for loading browser models through `pkg/src/data.ts`. */
export function createLocalModelsFetch(modelsDir: string): {
  fetch: typeof globalThis.fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchFn: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.split("/").at(-1) ?? "";
    requested.push(name);
    const fullPath = join(modelsDir, name);
    if (!existsSync(fullPath)) {
      return new Response("Not Found", { status: 404 });
    }
    const bytes = readFileSync(fullPath);
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
  return { fetch: fetchFn, requested };
}

export interface BrowserLoadedCorrector {
  corrector: Corrector;
  lexicon: Lexicon;
  parseMs: number;
  totalMs: number;
  files: Array<{ name: string; raw: number; gzip: number; brotli: number }>;
}

/**
 * Loads the browser engine via the exact `pkg/` loading path (`loadData`), measuring parse/setup time
 * and compressed bundle sizes from `modelsDir` (default: `site/public/models`).
 */
export async function loadBrowserCorrector(
  modelsDir = "site/public/models",
  options: { noMorphology?: boolean; noKnown?: boolean } = {},
): Promise<BrowserLoadedCorrector> {
  const started = performance.now();
  const { fetch, requested } = createLocalModelsFetch(modelsDir);
  let parseStart = started;
  const loaded = await loadData({
    baseUrl: "https://local.bench/models/",
    fetch,
    yieldToMain: false,
    onProgress: (p) => {
      if (p.stage === "parsing") parseStart = performance.now();
    },
  });
  const finished = performance.now();

  const dataNames = [...new Set(requested)].filter((name) => name !== "manifest.json" && existsSync(join(modelsDir, name)));
  const files = dataNames.map((name) => {
    const bytes = readFileSync(join(modelsDir, name));
    return {
      name,
      raw: bytes.byteLength,
      gzip: gzipSync(bytes, { level: 9 }).byteLength,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).byteLength,
    };
  });

  const corrector = new Corrector(
    loaded.lexicon,
    undefined,
    options.noKnown ? undefined : loaded.known,
    options.noMorphology ? undefined : loaded.morphology,
  );
  return {
    corrector,
    lexicon: loaded.lexicon,
    parseMs: finished - parseStart,
    totalMs: finished - started,
    files,
  };
}

export function loadKnownTsv(): string {
  const base = readFileSync("data/rules/known.tsv", "utf8");
  return existsSync("data/rules/names.tsv") ? `${base}\n${readFileSync("data/rules/names.tsv", "utf8")}` : base;
}

/** --lexicon wiki selects the Wikipedia-only lexicon; --no-morphology leaves the morphology layer out. */
export function createCorrector(args: readonly string[] = process.argv, minCount = 1, minPair = 5): Corrector {
  const wiki = args.includes("--lexicon") && args[args.indexOf("--lexicon") + 1] === "wiki";
  const lexicon = Lexicon.fromTsv(
    readFileSync(wiki ? "data/work/unigrams.tsv" : "data/work/unigrams_conv.tsv", "utf8"),
    readFileSync("data/work/bigrams.tsv", "utf8"),
    minCount,
    minPair,
  );
  const known = args.includes("--no-known") ? undefined : KnownMisspellings.fromTsv(loadKnownTsv());
  const morphology = args.includes("--no-morphology") ? undefined : loadMorphology();
  return new Corrector(lexicon, undefined, known, morphology);
}
