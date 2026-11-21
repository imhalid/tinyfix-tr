import type { ContextModel, RunModel } from "../../src/context.ts";
import { KnownMisspellings } from "../../src/known.ts";
import { Lexicon } from "../../src/lexicon.ts";
import { createOnnxContextSession, wrapContextModel } from "./context.ts";
import { CONTEXT_MODEL_FILE } from "./types.ts";
import type {
  ContextSession,
  ContextSessionLoader,
  DataFileName,
  LoadProgress,
  ProgressCallback,
  RawData,
  WarningCallback,
} from "./types.ts";

/** Zorunlu sözlük TSV dosyaları. Sıkıştırılmış ikili biçime geçildiğinde yalnızca bu modül güncellenir. */
export const DATA_FILES: readonly ("unigrams.tsv" | "bigrams.tsv" | "known.tsv")[] = [
  "unigrams.tsv",
  "bigrams.tsv",
  "known.tsv",
];

export { CONTEXT_MODEL_FILE };

/** Varsayılan sözlük ve model dizini. */
export const DEFAULT_BASE_URL = "/models/";

/** İndirme ilerlemesini tahmin etmek için dosyaların yaklaşık ağırlıkları (Content-Length yoksa). */
const FILE_WEIGHTS: Record<DataFileName, number> = {
  "unigrams.tsv": 0.60,
  "bigrams.tsv": 0.26,
  "known.tsv": 0.04,
  "context.onnx": 0.10,
};

const DOWNLOAD_SHARE = 0.9;
const PROGRESS_THROTTLE_MS = 40;
const DOWNLOAD_ATTEMPTS = 3;

export interface LoadedData {
  lexicon: Lexicon;
  known: KnownMisspellings;
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
  data?: RawData;
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
  unigrams?: string;
  bigrams?: string;
  known?: string;
  contextBytes: Uint8Array | null;
  contextError: unknown;
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Göreli veya mutlak URL/yol değerini sona `/` ekleyerek çözümler. */
export function resolveBaseUrl(baseUrl: string | URL = DEFAULT_BASE_URL): string {
  const raw = String(baseUrl);
  const withSlash = raw.endsWith("/") ? raw : `${raw}/`;
  if (typeof location !== "undefined" && typeof location.href === "string") {
    return new URL(withSlash, location.href).href;
  }
  return withSlash;
}

function buildFileUrl(baseUrl: string, file: DataFileName): string {
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

async function fetchBundle(
  baseUrl: string | URL,
  files: readonly DataFileName[],
  options: FetchDataOptions = {},
): Promise<FetchedBundle> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("autr: Bu ortamda fetch işlevi bulunamadı.");
  }

  const resolvedBase = resolveBaseUrl(baseUrl);
  const states: Record<DataFileName, FileProgressState> = {
    "unigrams.tsv": { loaded: 0, total: null, done: false },
    "bigrams.tsv": { loaded: 0, total: null, done: false },
    "known.tsv": { loaded: 0, total: null, done: false },
    "context.onnx": { loaded: 0, total: null, done: false },
  };

  let lastEmit = 0;
  let maxRatio = 0;
  const emit = (file?: DataFileName, force = false) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    const summary = summarizeDownload(states, files, file);
    if (summary.ratio < maxRatio) {
      summary.ratio = maxRatio;
    } else {
      maxRatio = summary.ratio;
    }
    options.onProgress(summary);
  };

  emit(undefined, true);

  const downloadOne = async <T>(
    file: DataFileName,
    readBody: (response: Response, onChunk: (bytes: number) => void) => Promise<T>,
  ): Promise<T> => {
    const url = buildFileUrl(resolvedBase, file);
    const response = await fetchFn(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`autr: ${file} yüklenemedi (${response.status}) — ${url}`);
    }
    states[file].total = parseContentLength(response);
    emit(file, true);

    const data = await readBody(response, (bytes) => {
      states[file].loaded += bytes;
      emit(file, false);
    });

    states[file].done = true;
    emit(file, true);
    return data;
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

  const wantTsv = files.includes("unigrams.tsv");
  const wantContext = files.includes(CONTEXT_MODEL_FILE);

  const tsvPromise = wantTsv
    ? Promise.all([
        downloadWithRetry("unigrams.tsv", readResponseText),
        downloadWithRetry("bigrams.tsv", readResponseText),
        downloadWithRetry("known.tsv", readResponseText),
      ])
    : Promise.resolve(null);

  const contextPromise: Promise<{ bytes: Uint8Array | null; error: unknown }> = wantContext
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

  const [tsv, contextResult] = await Promise.all([tsvPromise, contextPromise]);

  return {
    unigrams: tsv?.[0],
    bigrams: tsv?.[1],
    known: tsv?.[2],
    contextBytes: contextResult.bytes,
    contextError: contextResult.error,
  };
}

/** `baseUrl` altından `unigrams.tsv`, `bigrams.tsv` ve `known.tsv` dosyalarını indirir. */
export async function fetchRawData(
  baseUrl: string | URL = DEFAULT_BASE_URL,
  options: FetchDataOptions = {},
): Promise<RawData> {
  const bundle = await fetchBundle(baseUrl, DATA_FILES, options);
  return {
    unigrams: bundle.unigrams!,
    bigrams: bundle.bigrams!,
    known: bundle.known!,
  };
}

/** Ham TSV metinlerini motorun kullandığı `Lexicon` ve `KnownMisspellings` yapılarına dönüştürür. */
export async function parseRawData(raw: RawData, options: ParseDataOptions = {}): Promise<LoadedData> {
  const minCount = options.minCount ?? 1;
  const minPair = options.minPair ?? 1;
  const lexicon = Lexicon.fromTsv(raw.unigrams, raw.bigrams, minCount, minPair);
  if (options.yieldToMain) await nextTask();
  const known = KnownMisspellings.fromTsv(raw.known);
  return { lexicon, known };
}

/** Sözlüğü (ve istenirse bağlam modelini) indirir, ayrıştırır ve yükleme ilerlemesini bildirir. */
export async function loadData(options: LoadDataOptions = {}): Promise<LoadedData> {
  const wantContext = Boolean(options.context);
  const prebuiltContext =
    options.contextModel && options.context !== false ? wrapContextModel(options.contextModel) : null;
  const shouldFetchContext = wantContext && !prebuiltContext;
  const shouldFetchTsv = !options.data;

  let raw: RawData;
  let contextBytes: Uint8Array | null = null;
  let contextDownloadError: unknown = null;
  let totalBytes: number | null = null;
  let loadedBytes = 0;

  if (!shouldFetchTsv && !shouldFetchContext) {
    raw = options.data!;
    const encoder = new TextEncoder();
    loadedBytes =
      encoder.encode(raw.unigrams).byteLength +
      encoder.encode(raw.bigrams).byteLength +
      encoder.encode(raw.known).byteLength;
    totalBytes = loadedBytes;
  } else {
    const filesToDownload: DataFileName[] = [
      ...(shouldFetchTsv ? DATA_FILES : []),
      ...(shouldFetchContext ? [CONTEXT_MODEL_FILE] : []),
    ];
    const downloadState: { last: LoadProgress | null } = { last: null };
    const bundle = await fetchBundle(options.baseUrl ?? DEFAULT_BASE_URL, filesToDownload, {
      fetch: options.fetch,
      signal: options.signal,
      onProgress: (progress) => {
        downloadState.last = progress;
        options.onProgress?.(progress);
      },
    });
    raw = options.data ?? {
      unigrams: bundle.unigrams!,
      bigrams: bundle.bigrams!,
      known: bundle.known!,
    };
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

  const parsed = await parseRawData(raw, {
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
