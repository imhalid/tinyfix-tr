import { loadData } from "./data.ts";
import { TdkaiEngine } from "./engine.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import type { ContextSessionLoader } from "./types.ts";

export interface WorkerHandlerOptions {
  fetch?: typeof globalThis.fetch;
  loadContextSession?: ContextSessionLoader;
}

interface DedicatedWorkerLike {
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse): void;
}

/**
 * Worker mesajlarını işleyen bağımsız işleyici üretir.
 * Tarayıcıda doğrudan Worker içinde bağlanır; testlerde ise sahte kanal üzerinden çağrılabilir.
 */
export function createWorkerMessageHandler(
  post: (message: WorkerResponse) => void,
  options: WorkerHandlerOptions = {},
): (request: WorkerRequest) => Promise<void> {
  let engine: TdkaiEngine | null = null;

  return async (request: WorkerRequest): Promise<void> => {
    switch (request.type) {
      case "load": {
        try {
          if (engine) {
            await engine.dispose();
            engine = null;
          }
          const loaded = await loadData({
            baseUrl: request.baseUrl,
            data: request.data,
            minCount: request.minCount,
            minPair: request.minPair,
            context: request.context,
            wasmPaths: request.wasmPaths,
            fetch: options.fetch,
            loadContextSession: options.loadContextSession,
            yieldToMain: false,
            onProgress: (progress) => {
              post({ type: "progress", id: request.id, progress });
            },
            onWarning: (message) => {
              post({ type: "warning", id: request.id, message });
            },
          });
          engine = new TdkaiEngine(loaded, request.mode, request.ignored, loaded.contextSession);
          post({ type: "loaded", id: request.id, hasContext: engine.hasContext });
        } catch (error) {
          post({
            type: "error",
            id: request.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "check": {
        try {
          if (!engine) {
            throw new Error("autr: Sözlük henüz yüklenmedi.");
          }
          const fixes = await engine.check(request.text, request.options);
          post({ type: "result", id: request.id, fixes });
        } catch (error) {
          post({
            type: "error",
            id: request.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "inspect": {
        try {
          if (!engine) {
            throw new Error("autr: Sözlük henüz yüklenmedi.");
          }
          const { fixes, flags } = await engine.inspect(request.text, request.options);
          post({ type: "inspectResult", id: request.id, fixes, flags });
        } catch (error) {
          post({
            type: "error",
            id: request.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      case "ignore": {
        engine?.ignore(request.word);
        return;
      }

      case "unignore": {
        engine?.unignore(request.word);
        return;
      }

      case "setMode": {
        engine?.setMode(request.mode);
        return;
      }

      case "dispose": {
        await engine?.dispose();
        engine = null;
        post({ type: "disposed", id: request.id });
        return;
      }
    }
  };
}

const isDedicatedWorker =
  typeof globalThis !== "undefined" &&
  !("document" in globalThis) &&
  typeof (globalThis as { postMessage?: unknown }).postMessage === "function" &&
  typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function";

if (isDedicatedWorker) {
  const scope = globalThis as unknown as DedicatedWorkerLike;
  const handle = createWorkerMessageHandler((message) => scope.postMessage(message));
  scope.addEventListener("message", (event) => {
    void handle(event.data);
  });
}
