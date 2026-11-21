import type { ContextModel, RunModel } from "../../src/context.ts";
import type { WordValidator } from "../../src/corrector.ts";
import { KnownMisspellings } from "../../src/known.ts";
import { Lexicon } from "../../src/lexicon.ts";
import { TurkishMorphology } from "../../src/morphology/index.ts";
import { createOnnxContextSession, wrapContextModel } from "./context.ts";
import { CONTEXT_MODEL_FILE } from "./types.ts";
import type {
  BinaryData,
  ContextSession,
  ContextSessionLoader,
  DataFileName,
  LoadProgress,
  ProgressCallback,
  RawData,
  WarningCallback,
} from "./types.ts";

/** Zorunlu tarayıcı veri dosyaları (ikili sözlük + biçimbilim + bilinen yanlışlar). */
export const DATA_FILES: readonly ("lexicon.bin" | "morph.bin" | "known.tsv")[] = [
  "lexicon.bin",
  "morph.bin",
  "known.tsv",
];

/** Eski düz metin TSV dosya listesi (geriye dönük uyumluluk için). */
export const LEGACY_DATA_FILES: readonly ("unigrams.tsv" | "bigrams.tsv" | "known.tsv")[] = [
  "unigrams.tsv",
  "bigrams.tsv",
  "known.tsv",
];

export { CONTEXT_MODEL_FILE };

/** Varsayılan sözlük ve model dizini. */
export const DEFAULT_BASE_URL = "/models/";

/** İndirme ilerlemesini tahmin etmek için dosyaların yaklaşık ağırlıkları (Content-Length yoksa). */
const FILE_WEIGHTS: Record<DataFileName, number> = {
  "lexicon.bin": 0.94,
  "morph.bin": 0.05,
  "known.tsv": 0.01,
  "unigrams.tsv": 0.60,
  "bigrams.tsv": 0.26,
  "context.onnx": 0.25,
};

const DOWNLOAD_SHARE = 0.9;
const PROGRESS_THROTTLE_MS = 40;
const DOWNLOAD_ATTEMPTS = 3;

export interface LoadedData {
  lexicon: Lexicon;
  known: KnownMisspellings;
  morphology?: WordValidator;
  contextSession?: ContextSession | null;
}

export interface FetchDataOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

export interface ParseDataOptions {
  minCount?: number;
  minPair?: number;
  yieldToMain?: boolean;
}

export interface LoadDataOptions extends FetchDataOptions, ParseDataOptions {
  baseUrl?: string | URL;
  data?: RawData | BinaryData;
  context?: boolean;
  wasmPaths?: string | URL;
  contextModel?: ContextModel | RunModel;
  loadContextSession?: ContextSessionLoader;
  onWarning?: WarningCallback;
}

interface FileProgressState {
  loaded: number;
  total: number | null;
  done: boolean;
}

interface FetchedBundle {
  binary?: BinaryData;
  raw?: RawData;
  contextBytes: Uint8Array | null;
  contextError: unknown;
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Verilen bellek içi verinin ikili (`BinaryData`) biçimde olup olmadığını söyler. */
export function isBinaryData(data: RawData | BinaryData): data is BinaryData {
  return "lexicon" in data && data.lexicon instanceof Uint8Array;
}

/** Göreli veya mutlak URL/yol değerini sona `/` ekleyerek çözümler. */
export function resolveBaseUrl(baseUrl: string | URL = DEFAULT_BASE_URL): string {
  const raw = String(baseUrl);
  const withSlash = raw.endsWith("/") ? raw : `${raw}/`;
  if (typeof location !== "undefined" && typeof location.href === "string") {
    return new URL(withSlash, location.href).href;
  }
  return withSlash;
}

function buildFileUrl(baseUrl: string, file: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(baseUrl)) {
    return new URL(file, baseUrl).href;
  }
  return `${baseUrl}${file}`;
}

function parseContentLength(response: Response): number | null {
  // Sıkıştırılmış yanıtlarda Content-Length aktarım boyutudur, reader ise açılmış baytları verir.
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") return null;
  const header = response.headers.get("content-length");
  if (!header) return null;
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function summarizeDownload(
  states: Record<DataFileName, FileProgressState>,
  files: readonly DataFileName[],
  activeFile?: DataFileName,
): LoadProgress {
  let loaded = 0;
  let totalSum = 0;
  let allTotalsKnown = true;

  for (const file of files) {
    const state = states[file];
    loaded += state.loaded;
    if (state.total !== null && state.loaded <= state.total) {
      totalSum += state.total;
    } else if (state.done && state.loaded > 0) {
      totalSum += state.loaded;
    } else {
      allTotalsKnown = false;
    }
  }

  let downloadRatio: number;
  if (allTotalsKnown && totalSum > 0) {
    downloadRatio = Math.min(1, loaded / totalSum);
  } else {
    downloadRatio = 0;
    const totalWeight = files.reduce((sum, file) => sum + FILE_WEIGHTS[file], 0) || 1;
    for (const file of files) {
      const state = states[file];
      let fileRatio = 0;
      if (state.done) {
        fileRatio = 1;
      } else if (state.total !== null && state.total > 0) {
        fileRatio = Math.min(0.98, state.loaded / state.total);
      } else if (state.loaded > 0) {
        // Boyut bilinmiyorsa yumuşak asimptotik ilerleme (0.9'u aşmaz).
        fileRatio = 0.9 * (1 - Math.exp(-state.loaded / (4 * 1024 * 1024)));
      }
      downloadRatio += (fileRatio * FILE_WEIGHTS[file]) / totalWeight;
    }
  }

  const ratio = Math.min(DOWNLOAD_SHARE, Math.max(0, Math.round(downloadRatio * DOWNLOAD_SHARE * 1000) / 1000));
  return {
    ratio,
    loaded,
    total: allTotalsKnown && totalSum > 0 ? totalSum : null,
    stage: "downloading",
    file: activeFile,
  };
}

async function readResponseText(
  response: Response,
  onChunk: (bytes: number) => void,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    onChunk(new TextEncoder().encode(text).byteLength);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        output += decoder.decode(value, { stream: true });
        onChunk(value.byteLength);
      }
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function readResponseBytes(
  response: Response,
  onChunk: (bytes: number) => void,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onChunk(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.byteLength;
        onChunk(value.byteLength);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createEmptyStates(): Record<DataFileName, FileProgressState> {
  return {
    "lexicon.bin": { loaded: 0, total: null, done: false },
    "morph.bin": { loaded: 0, total: null, done: false },
    "known.tsv": { loaded: 0, total: null, done: false },
    "unigrams.tsv": { loaded: 0, total: null, done: false },
    "bigrams.tsv": { loaded: 0, total: null, done: false },
    "context.onnx": { loaded: 0, total: null, done: false },
  };
}

async function fetchBundle(
  baseUrl: string | URL,
  mode: { wantCore: boolean; forceLegacyTsv?: boolean; wantContext: boolean },
  options: FetchDataOptions = {},
): Promise<FetchedBundle> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("autr: Bu ortamda fetch işlevi bulunamadı.");
  }

  const resolvedBase = resolveBaseUrl(baseUrl);
  const states = createEmptyStates();

  let activeFiles: DataFileName[] = [
    ...(mode.wantCore ? (mode.forceLegacyTsv ? LEGACY_DATA_FILES : DATA_FILES) : []),
    ...(mode.wantContext ? [CONTEXT_MODEL_FILE] : []),
  ];

  let lastEmit = 0;
  let maxRatio = 0;
  const emit = (file?: DataFileName, force = false) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    const summary = summarizeDownload(states, activeFiles, file);
    if (summary.ratio < maxRatio) {
      summary.ratio = maxRatio;
    } else {
      maxRatio = summary.ratio;
    }
    options.onProgress(summary);
  };

  emit(undefined, true);

  // Optional manifest.json next to the files, with each file's real size (written by the site's build).
  // Also tells us immediately whether the host serves the binary bundle (lexicon.bin) or legacy TSVs.
  const manifest: Partial<Record<DataFileName, number>> = await fetchFn(buildFileUrl(resolvedBase, "manifest.json"), {
    signal: options.signal,
  })
    .then((response) => (response.ok ? (response.json() as Promise<Partial<Record<DataFileName, number>>>) : {}))
    .catch(() => ({}));

  const readTracked = async <T>(
    file: DataFileName,
    response: Response,
    readBody: (response: Response, onChunk: (bytes: number) => void) => Promise<T>,
  ): Promise<T> => {
    const size = manifest[file];
    states[file].total = parseContentLength(response) ?? (typeof size === "number" && size > 0 ? size : null);
    emit(file, true);

    const data = await readBody(response, (bytes) => {
      states[file].loaded += bytes;
      emit(file, false);
    });

    states[file].done = true;
    emit(file, true);
    return data;
  };

  const downloadOne = async <T>(
    file: DataFileName,
    readBody: (response: Response, onChunk: (bytes: number) => void) => Promise<T>,
  ): Promise<T> => {
    const url = buildFileUrl(resolvedBase, file);
    const response = await fetchFn(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`autr: ${file} yüklenemedi (${response.status}) — ${url}`);
    }
    return readTracked(file, response, readBody);
  };

  // A download can be cut off, for example while a service worker installs and fetches the same files on the first
  // visit. A network failure (not an HTTP error) is retried a few times before giving up.
  const downloadWithRetry = async <T>(
    file: DataFileName,
    readBody: (response: Response, onChunk: (bytes: number) => void) => Promise<T>,
  ): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await downloadOne(file, readBody);
      } catch (error) {
        const isNetworkFailure = error instanceof TypeError;
        if (!isNetworkFailure || attempt >= DOWNLOAD_ATTEMPTS || options.signal?.aborted) throw error;
        states[file].loaded = 0;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  };

  const downloadOptionalMorph = async (): Promise<Uint8Array | undefined> => {
    const url = buildFileUrl(resolvedBase, "morph.bin");
    const response = await fetchFn(url, { signal: options.signal });
    if (response.status === 404) {
      states["morph.bin"].total = 0;
      states["morph.bin"].done = true;
      emit("morph.bin", true);
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`autr: morph.bin yüklenemedi (${response.status}) — ${url}`);
    }
    return readTracked("morph.bin", response, readResponseBytes);
  };

  const downloadCore = async (): Promise<{ binary?: BinaryData; raw?: RawData }> => {
    if (!mode.wantCore) return {};

    const manifestHasBinary = typeof manifest["lexicon.bin"] === "number";
    const manifestHasLegacy = !manifestHasBinary && typeof manifest["unigrams.tsv"] === "number";

    if (mode.forceLegacyTsv || manifestHasLegacy) {
      activeFiles = [...LEGACY_DATA_FILES, ...(mode.wantContext ? [CONTEXT_MODEL_FILE] : [])];
      const [unigrams, bigrams, known] = await Promise.all([
        downloadWithRetry("unigrams.tsv", readResponseText),
        downloadWithRetry("bigrams.tsv", readResponseText),
        downloadWithRetry("known.tsv", readResponseText),
      ]);
      return { raw: { unigrams, bigrams, known } };
    }

    if (manifestHasBinary) {
      const hasMorph = typeof manifest["morph.bin"] === "number";
      activeFiles = [
        "lexicon.bin",
        ...(hasMorph ? (["morph.bin"] as const) : []),
        "known.tsv",
        ...(mode.wantContext ? [CONTEXT_MODEL_FILE] : []),
      ];
      const [lexicon, morphology, known] = await Promise.all([
        downloadWithRetry("lexicon.bin", readResponseBytes),
        hasMorph ? downloadWithRetry("morph.bin", readResponseBytes) : Promise.resolve(undefined),
        downloadWithRetry("known.tsv", readResponseText),
      ]);
      return { binary: { lexicon, morphology, known } };
    }

    // No manifest.json: try lexicon.bin first; if 404, seamlessly fall back to legacy TSV files.
    const lexUrl = buildFileUrl(resolvedBase, "lexicon.bin");
    let lexResponse: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        lexResponse = await fetchFn(lexUrl, { signal: options.signal });
        break;
      } catch (error) {
        const isNetworkFailure = error instanceof TypeError;
        if (!isNetworkFailure || attempt >= DOWNLOAD_ATTEMPTS || options.signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }

    if (lexResponse.status === 404) {
      activeFiles = [...LEGACY_DATA_FILES, ...(mode.wantContext ? [CONTEXT_MODEL_FILE] : [])];
      const [unigrams, bigrams, known] = await Promise.all([
        downloadWithRetry("unigrams.tsv", readResponseText),
        downloadWithRetry("bigrams.tsv", readResponseText),
        downloadWithRetry("known.tsv", readResponseText),
      ]);
      return { raw: { unigrams, bigrams, known } };
    }

    if (!lexResponse.ok) {
      throw new Error(`autr: lexicon.bin yüklenemedi (${lexResponse.status}) — ${lexUrl}`);
    }

    // Stream lexicon.bin while fetching morph.bin and known.tsv in parallel.
    const [lexicon, morphology, known] = await Promise.all([
      readTracked("lexicon.bin", lexResponse, readResponseBytes),
      downloadOptionalMorph(),
      downloadWithRetry("known.tsv", readResponseText),
    ]);
    return { binary: { lexicon, morphology, known } };
  };

  const contextPromise: Promise<{ bytes: Uint8Array | null; error: unknown }> = mode.wantContext
    ? downloadWithRetry(CONTEXT_MODEL_FILE, readResponseBytes)
        .then((bytes) => ({ bytes, error: null as unknown }))
        .catch((error: unknown) => {
          if (options.signal?.aborted) throw error;
          states[CONTEXT_MODEL_FILE].total = states[CONTEXT_MODEL_FILE].loaded;
          states[CONTEXT_MODEL_FILE].done = true;
          emit(CONTEXT_MODEL_FILE, true);
          return { bytes: null, error };
        })
    : Promise.resolve({ bytes: null, error: null });

  const [core, contextResult] = await Promise.all([downloadCore(), contextPromise]);

  return {
    binary: core.binary,
    raw: core.raw,
    contextBytes: contextResult.bytes,
    contextError: contextResult.error,
  };
}

/** `baseUrl` altından eski ham TSV dosyalarını (`unigrams.tsv`, `bigrams.tsv`, `known.tsv`) indirir. */
export async function fetchRawData(
  baseUrl: string | URL = DEFAULT_BASE_URL,
  options: FetchDataOptions = {},
): Promise<RawData> {
  const bundle = await fetchBundle(baseUrl, { wantCore: true, forceLegacyTsv: true, wantContext: false }, options);
  return bundle.raw!;
}

function parseMorphologyInput(input: Uint8Array | string | readonly string[] | undefined): WordValidator | undefined {
  if (!input) return undefined;
  if (input instanceof Uint8Array) return TurkishMorphology.fromBinary(input);
  if (typeof input === "string") return TurkishMorphology.fromDictionaries([input]);
  return TurkishMorphology.fromDictionaries(input);
}

/** Ham TSV metinlerini motorun kullandığı `Lexicon`, `KnownMisspellings` ve isteğe bağlı `TurkishMorphology` yapılarına dönüştürür. */
export async function parseRawData(raw: RawData, options: ParseDataOptions = {}): Promise<LoadedData> {
  const minCount = options.minCount ?? 1;
  const minPair = options.minPair ?? 1;
  const lexicon = Lexicon.fromTsv(raw.unigrams, raw.bigrams, minCount, minPair);
  if (options.yieldToMain) await nextTask();
  const known = KnownMisspellings.fromTsv(raw.known);
  const morphology = parseMorphologyInput(raw.morphology);
  return { lexicon, known, morphology };
}

/** Sıkıştırılmış ikili sözlük (`lexicon.bin` + `morph.bin` + `known.tsv`) verisini motorun yapılarına dönüştürür. */
export async function parseBinaryData(binary: BinaryData, options: ParseDataOptions = {}): Promise<LoadedData> {
  const lexicon = Lexicon.fromBinary(binary.lexicon);
  if (options.yieldToMain) await nextTask();
  const known = KnownMisspellings.fromTsv(binary.known);
  const morphology = binary.morphology ? TurkishMorphology.fromBinary(binary.morphology) : undefined;
  return { lexicon, known, morphology };
}

/** Sözlüğü, biçimbilimi (ve istenirse bağlam modelini) indirir, ayrıştırır ve yükleme ilerlemesini bildirir. */
export async function loadData(options: LoadDataOptions = {}): Promise<LoadedData> {
  const wantContext = Boolean(options.context);
  const prebuiltContext =
    options.contextModel && options.context !== false ? wrapContextModel(options.contextModel) : null;
  const shouldFetchContext = wantContext && !prebuiltContext;
  const shouldFetchCore = !options.data;

  let binaryData: BinaryData | undefined;
  let rawData: RawData | undefined;
  let contextBytes: Uint8Array | null = null;
  let contextDownloadError: unknown = null;
  let totalBytes: number | null = null;
  let loadedBytes = 0;

  if (options.data) {
    if (isBinaryData(options.data)) binaryData = options.data;
    else rawData = options.data;
  }

  if (!shouldFetchCore && !shouldFetchContext) {
    const encoder = new TextEncoder();
    if (binaryData) {
      loadedBytes =
        binaryData.lexicon.byteLength +
        (binaryData.morphology?.byteLength ?? 0) +
        encoder.encode(binaryData.known).byteLength;
    } else if (rawData) {
      loadedBytes =
        encoder.encode(rawData.unigrams).byteLength +
        encoder.encode(rawData.bigrams).byteLength +
        encoder.encode(rawData.known).byteLength;
    }
    totalBytes = loadedBytes;
  } else {
    const downloadState: { last: LoadProgress | null } = { last: null };
    const bundle = await fetchBundle(
      options.baseUrl ?? DEFAULT_BASE_URL,
      { wantCore: shouldFetchCore, wantContext: shouldFetchContext },
      {
        fetch: options.fetch,
        signal: options.signal,
        onProgress: (progress) => {
          downloadState.last = progress;
          options.onProgress?.(progress);
        },
      },
    );
    if (shouldFetchCore) {
      binaryData = bundle.binary;
      rawData = bundle.raw;
    }
    contextBytes = bundle.contextBytes;
    contextDownloadError = bundle.contextError;
    if (downloadState.last) {
      loadedBytes = downloadState.last.loaded;
      totalBytes = downloadState.last.total;
    }
  }

  options.onProgress?.({
    ratio: 0.92,
    loaded: loadedBytes,
    total: totalBytes,
    stage: "parsing",
  });

  if (options.yieldToMain) await nextTask();

  const parsed = binaryData
    ? await parseBinaryData(binaryData, { yieldToMain: options.yieldToMain })
    : await parseRawData(rawData!, {
        minCount: options.minCount,
        minPair: options.minPair,
        yieldToMain: options.yieldToMain,
      });

  let contextSession: ContextSession | null = prebuiltContext;

  if (contextDownloadError !== null) {
    const reason =
      contextDownloadError instanceof Error ? contextDownloadError.message : String(contextDownloadError);
    options.onWarning?.(
      `autr: Bağlam modeli (${CONTEXT_MODEL_FILE}) indirilemedi (${reason}); bağlam modeli olmadan devam ediliyor.`,
    );
  } else if (contextBytes) {
    options.onProgress?.({
      ratio: 0.96,
      loaded: loadedBytes,
      total: totalBytes,
      stage: "parsing",
      file: CONTEXT_MODEL_FILE,
    });
    if (options.yieldToMain) await nextTask();
    try {
      const loader = options.loadContextSession ?? createOnnxContextSession;
      const resolvedWasmPaths =
        options.wasmPaths !== undefined ? resolveBaseUrl(options.wasmPaths) : undefined;
      contextSession = await loader(contextBytes, { wasmPaths: resolvedWasmPaths });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      options.onWarning?.(
        `autr: Bağlam modeli başlatılamadı (${reason}); bağlam modeli olmadan devam ediliyor.`,
      );
    }
  }

  options.onProgress?.({
    ratio: 1,
    loaded: loadedBytes,
    total: totalBytes,
    stage: "ready",
  });

  return {
    ...parsed,
    contextSession,
  };
}
