import { DEFAULT_BASE_URL, resolveBaseUrl } from "./data.ts";
import { applyFixes } from "./engine.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import type { Autr, CheckOptions, Fix, InspectResult, LoadOptions, Mode } from "./types.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function createDefaultWorker(): Worker {
  // Derlenmiş çıktıdaki `worker.js` dosyasını hedefler (Vite ve webpack bunu ayrı chunk olarak paketler).
  return new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: "autr",
  });
}

/** Sözlüğü, bağlam modelini ve düzelticiyi ayrı bir Web Worker içinde başlatır. */
export function loadAutrInWorker(options: LoadOptions): Promise<Autr> {
  return new Promise<Autr>((resolveLoad, rejectLoad) => {
    if (options.signal?.aborted) {
      rejectLoad(new Error("autr: Yükleme iptal edildi."));
      return;
    }

    let worker: Worker;
    try {
      worker = options.createWorker ? options.createWorker() : createDefaultWorker();
    } catch (error) {
      rejectLoad(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    const loadId = nextId++;
    let settled = false;
    let disposed = false;
    let hasContext = false;

    const cleanupSignal = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const failAll = (error: Error) => {
      cleanupSignal();
      if (!settled) {
        settled = true;
        rejectLoad(error);
      }
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
      disposed = true;
      worker.terminate();
    };

    const onAbort = () => {
      failAll(new Error("autr: Yükleme iptal edildi."));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const send = (message: WorkerRequest) => {
      worker.postMessage(message);
    };

    const assertActive = () => {
      if (disposed) {
        throw new Error("autr: Örnek kapatıldı (dispose edildi) ve artık kullanılamaz.");
      }
    };

    const autr: Autr = {
      get hasContext(): boolean {
        return hasContext;
      },
      check: (text: string, checkOptions?: CheckOptions): Promise<Fix[]> => {
        if (disposed) {
          return Promise.reject(new Error("autr: Örnek kapatıldı (dispose edildi) ve artık kullanılamaz."));
        }
        return new Promise<Fix[]>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, {
            resolve: (value) => resolve(value as Fix[]),
            reject,
          });
          send({ type: "check", id, text, options: checkOptions });
        });
      },
      inspect: (text: string, checkOptions?: CheckOptions): Promise<InspectResult> => {
        if (disposed) {
          return Promise.reject(new Error("autr: Örnek kapatıldı (dispose edildi) ve artık kullanılamaz."));
        }
        return new Promise<InspectResult>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, {
            resolve: (value) => resolve(value as InspectResult),
            reject,
          });
          send({ type: "inspect", id, text, options: checkOptions });
        });
      },
      apply: (text: string, fixes: readonly Fix[]): string => applyFixes(text, fixes),
      fix: async (text: string, checkOptions?: CheckOptions): Promise<string> => {
        const fixes = await autr.check(text, checkOptions);
        return applyFixes(text, fixes);
      },
      ignore: (word: string): void => {
        assertActive();
        send({ type: "ignore", word });
      },
      unignore: (word: string): void => {
        assertActive();
        send({ type: "unignore", word });
      },
      setMode: (mode: Mode): void => {
        assertActive();
        send({ type: "setMode", mode });
      },
      dispose: async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        cleanupSignal();
        const error = new Error("autr: Örnek kapatıldı (dispose edildi).");
        for (const entry of pending.values()) {
          entry.reject(error);
        }
        pending.clear();
        worker.terminate();
      },
    };

    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      failAll(new Error(`autr: Worker beklenmedik biçimde durdu (${event.message || "başlatılamadı"}).`));
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress": {
          options.onProgress?.(message.progress);
          return;
        }
        case "warning": {
          if (typeof console !== "undefined" && typeof console.warn === "function") {
            console.warn(message.message);
          }
          options.onWarning?.(message.message);
          return;
        }
        case "loaded": {
          hasContext = message.hasContext;
          cleanupSignal();
          pending.delete(message.id);
          if (!settled) {
            settled = true;
            resolveLoad(autr);
          }
          return;
        }
        case "result": {
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            entry.resolve(message.fixes);
          }
          return;
        }
        case "inspectResult": {
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            entry.resolve({ fixes: message.fixes, flags: message.flags });
          }
          return;
        }
        case "disposed": {
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            entry.resolve(undefined);
          }
          return;
        }
        case "error": {
          const error = new Error(message.message);
          if (!settled && message.id === loadId) {
            failAll(error);
            return;
          }
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            entry.reject(error);
          }
          return;
        }
      }
    };

    const needsBaseUrl = !options.data || Boolean(options.context);
    const resolvedBaseUrl = needsBaseUrl ? resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL) : undefined;
    const resolvedWasmPaths =
      options.wasmPaths !== undefined ? resolveBaseUrl(options.wasmPaths) : undefined;

    send({
      type: "load",
      id: loadId,
      baseUrl: resolvedBaseUrl,
      data: options.data,
      mode: options.mode ?? "careful",
      minCount: options.minCount,
      minPair: options.minPair,
      ignored: options.ignored ? [...options.ignored] : undefined,
      context: Boolean(options.context),
      wasmPaths: resolvedWasmPaths,
    });
  });
}
