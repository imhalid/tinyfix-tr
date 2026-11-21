import { ContextModel, SEQUENCE, pack, type ContextQuery, type RunModel } from "../../src/context.ts";
import { KnownMisspellings } from "../../src/known.ts";
import { Lexicon } from "../../src/lexicon.ts";
import { createOnnxContextSession, wrapContextModel } from "./context.ts";
import {
  CONTEXT_MODEL_FILE,
  DATA_FILES,
  DEFAULT_BASE_URL,
  fetchRawData,
  loadData,
  parseRawData,
  resolveBaseUrl,
} from "./data.ts";
import { AutrEngine, BALANCED, CAREFUL, applyFixes, mapCorrectionKind, marginToConfidence } from "./engine.ts";
import { ALL_FIX_KINDS, DEFAULT_FIX_KINDS } from "./types.ts";
import type {
  Autr,
  CheckOptions,
  ContextModelFileName,
  ContextSession,
  ContextSessionLoader,
  DataFileName,
  Fix,
  FixKind,
  LoadOptions,
  LoadProgress,
  Mode,
  ProgressCallback,
  RawData,
  WarningCallback,
} from "./types.ts";
import { loadAutrInWorker } from "./workerClient.ts";

export {
  ALL_FIX_KINDS,
  DEFAULT_FIX_KINDS,
  BALANCED,
  CAREFUL,
  CONTEXT_MODEL_FILE,
  ContextModel,
  DATA_FILES,
  DEFAULT_BASE_URL,
  SEQUENCE,
  applyFixes,
  createOnnxContextSession,
  fetchRawData,
  loadData,
  mapCorrectionKind,
  marginToConfidence,
  pack,
  parseRawData,
  resolveBaseUrl,
  wrapContextModel,
};

export type {
  Autr,
  CheckOptions,
  ContextModelFileName,
  ContextQuery,
  ContextSession,
  ContextSessionLoader,
  DataFileName,
  Fix,
  FixKind,
  LoadOptions,
  LoadProgress,
  Mode,
  ProgressCallback,
  RawData,
  RunModel,
  WarningCallback,
};

export interface CreateOptions {
  mode?: Mode;
  minCount?: number;
  minPair?: number;
  ignored?: Iterable<string>;
  /** İsteğe bağlı bağlam modeli veya `RunModel` işlevi (örneğin testler veya özel çalışma zamanları için). */
  contextModel?: ContextModel | RunModel;
}

function wrapEngine(engine: AutrEngine): Autr {
  const autr: Autr = {
    get hasContext(): boolean {
      return engine.hasContext;
    },
    check: (text: string, options?: CheckOptions): Promise<Fix[]> => engine.check(text, options),
    apply: (text: string, fixes: readonly Fix[]): string => applyFixes(text, fixes),
    fix: async (text: string, options?: CheckOptions): Promise<string> => {
      const fixes = await engine.check(text, options);
      return applyFixes(text, fixes);
    },
    ignore: (word: string): void => engine.ignore(word),
    unignore: (word: string): void => engine.unignore(word),
    setMode: (mode: Mode): void => engine.setMode(mode),
    dispose: (): Promise<void> => engine.dispose(),
  };
  return autr;
}

/**
 * Bellekteki ham TSV sözlük verisinden eşzamanlı olarak bir `Autr` örneği oluşturur.
 * Ağ isteği gerektirmeyen testler veya önceden yüklenmiş veriler için kullanışlıdır.
 */
export function createAutr(data: RawData, options: CreateOptions = {}): Autr {
  const lexicon = Lexicon.fromTsv(data.unigrams, data.bigrams, options.minCount ?? 1, options.minPair ?? 1);
  const known = KnownMisspellings.fromTsv(data.known);
  const contextSession = options.contextModel ? wrapContextModel(options.contextModel) : null;
  const engine = new AutrEngine(
    { lexicon, known, contextSession },
    options.mode ?? "careful",
    options.ignored,
    contextSession,
  );
  return wrapEngine(engine);
}

/**
 * Sözlük dosyalarını (ve `context: true` ise `context.onnx` bağlam modelini) indirip Türkçe otomatik düzelticiyi hazırlar.
 * `worker: true` verildiğinde ve ortam desteklediğinde Web Worker içinde çalışır.
 */
export async function loadAutr(options: LoadOptions = {}): Promise<Autr> {
  if (options.worker && (options.createWorker || typeof Worker !== "undefined")) {
    return loadAutrInWorker(options);
  }

  const loaded = await loadData({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    data: options.data,
    context: options.context,
    wasmPaths: options.wasmPaths,
    contextModel: options.contextModel,
    loadContextSession: options.loadContextSession,
    fetch: options.fetch,
    signal: options.signal,
    onProgress: options.onProgress,
    onWarning: (message) => {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(message);
      }
      options.onWarning?.(message);
    },
    minCount: options.minCount,
    minPair: options.minPair,
    yieldToMain: typeof document !== "undefined",
  });

  const engine = new AutrEngine(loaded, options.mode ?? "careful", options.ignored, loaded.contextSession);
  return wrapEngine(engine);
}
