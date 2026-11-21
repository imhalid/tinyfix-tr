import { ContextModel, FEATURE_DIM, SEQUENCE, type RunModel } from "../../src/context.ts";
import type { ContextSession } from "./types.ts";

export interface OnnxContextOptions {
  /** `onnxruntime-web` `.wasm`/`.mjs` dosyalarının bulunduğu dizin URL'si. */
  wasmPaths?: string;
}

/** Bir `ContextModel` örneğini veya `RunModel` işlevini `ContextSession` arayüzüne sarar. */
export function wrapContextModel(modelOrRun: ContextModel | RunModel): ContextSession {
  const model = typeof modelOrRun === "function" ? new ContextModel(modelOrRun) : modelOrRun;
  return {
    model,
    dispose: async () => {},
  };
}

/**
 * İndirilen `context.onnx` baytlarından `onnxruntime-web` WASM oturumu açar.
 * `onnxruntime-web/wasm` yalnızca bu işlev çağrıldığında (yani `context: true` iken) dinamik `import()` ile yüklenir.
 */
export async function createOnnxContextSession(
  modelBytes: Uint8Array,
  options: OnnxContextOptions = {},
): Promise<ContextSession> {
  const ort = await import("onnxruntime-web/wasm");

  if (options.wasmPaths !== undefined) {
    ort.env.wasm.wasmPaths = options.wasmPaths;
  }

  // Cross-Origin Isolation (COOP/COEP) olmayan sayfalarda SharedArrayBuffer yoktur; tek iş parçacıklı WASM güvenlidir.
  if (typeof crossOriginIsolated === "boolean" && !crossOriginIsolated) {
    ort.env.wasm.numThreads = 1;
  }

  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
  });

  let released = false;
  // onnxruntime-web WASM oturumu eşzamanlı session.run() çağrılarını desteklemez; çağrıları sıraya koyuyoruz.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  const wantsFeatures = session.inputNames.includes("features");

  const run: RunModel = (tokens, segments, n, features) =>
    enqueue(async () => {
      if (released) {
        throw new Error("autr: Bağlam modeli kapatıldı (dispose edildi).");
      }
      const feeds: Record<string, import("onnxruntime-web/wasm").Tensor> = {
        tokens: new ort.Tensor("int64", tokens, [n, SEQUENCE]),
        segments: new ort.Tensor("int64", segments, [n, SEQUENCE]),
      };
      if (wantsFeatures) {
        feeds["features"] = new ort.Tensor(
          "float32",
          features ?? new Float32Array(n * FEATURE_DIM),
          [n, FEATURE_DIM],
        );
      }
      const result = await session.run(feeds);
      const output = result["scores"] ?? Object.values(result)[0];
      if (!output) {
        throw new Error("autr: Bağlam modeli beklenen 'scores' çıktısını döndürmedi.");
      }
      if (output.data instanceof Float32Array) {
        return output.data;
      }
      throw new Error("autr: Bağlam modeli 'scores' çıktısı beklenen float32 türünde değil.");
    });

  return {
    model: new ContextModel(run),
    dispose: async () => {
      if (released) return;
      released = true;
      await queue.catch(() => {});
      if (typeof session.release === "function") {
        await session.release();
      }
    },
  };
}
