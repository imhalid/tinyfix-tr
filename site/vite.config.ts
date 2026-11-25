import { fileURLToPath } from "node:url";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const PREFERRED_ORT_WASM_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];

function resolveOrtDistDir(): string | null {
  // onnxruntime-web does not export its package.json, so it can't be found with require.resolve. It is a dependency
  // of the tinyfix-tr package (../pkg), which the site links to; look for its folder directly.
  const candidates = [
    new URL("./node_modules/onnxruntime-web/dist", import.meta.url),
    new URL("../pkg/node_modules/onnxruntime-web/dist", import.meta.url),
  ];
  for (const candidate of candidates) {
    const distDir = fileURLToPath(candidate);
    if (existsSync(distDir)) return distDir;
  }
  return null;
}

function selectOrtRuntimeFiles(distDir: string): string[] {
  if (PREFERRED_ORT_WASM_FILES.every((file) => existsSync(join(distDir, file)))) {
    return PREFERRED_ORT_WASM_FILES;
  }
  // Farklı bir onnxruntime-web sürümünde dosya adları değiştiyse tüm ort-wasm .wasm/.mjs dosyalarını al.
  return readdirSync(distDir)
    .filter((file) => file.endsWith(".wasm") || (file.startsWith("ort-wasm") && file.endsWith(".mjs")))
    .sort();
}

/**
 * `onnxruntime-web` `.wasm` ve `.mjs` çalışma zamanı dosyalarını:
 * - geliştirme sunucusunda (`vite dev`) `/ort/` yolundan doğrudan sunar,
 * - üretim derlemesinde (`vite build`) `dist/ort/` klasörüne kopyalar.
 */
function ortWasmPlugin(): Plugin {
  let outDir = resolve("dist");

  return {
    name: "autr-ort-wasm",

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },

    configureServer(server) {
      const ortDistDir = resolveOrtDistDir();
      if (!ortDistDir) {
        server.config.logger.warn(
          "[autr-ort-wasm] onnxruntime-web/dist bulunamadı; bağlam modeli dev sunucusunda yüklenemeyebilir.",
        );
        return;
      }
      const allowedFiles = new Set(selectOrtRuntimeFiles(ortDistDir));

      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          next();
          return;
        }
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        const match = pathname.match(/(?:^|\/)ort\/([^/]+)$/);
        const fileName = match?.[1];
        if (!fileName || !allowedFiles.has(fileName)) {
          next();
          return;
        }

        const fullPath = join(ortDistDir, fileName);
        if (!existsSync(fullPath)) {
          next();
          return;
        }

        const contentType = fileName.endsWith(".wasm")
          ? "application/wasm"
          : "text/javascript; charset=utf-8";
        const { size } = statSync(fullPath);

        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", String(size));
        res.setHeader("Cache-Control", "no-cache");

        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(fullPath).pipe(res);
      });
    },

    writeBundle() {
      const ortDistDir = resolveOrtDistDir();
      if (!ortDistDir) {
        this.warn(
          "[autr-ort-wasm] onnxruntime-web/dist bulunamadı; ORT .wasm dosyaları dist/ort/ içine kopyalanamadı.",
        );
        return;
      }
      const files = selectOrtRuntimeFiles(ortDistDir);
      if (files.length === 0) {
        this.warn("[autr-ort-wasm] onnxruntime-web/dist içinde .wasm dosyası bulunamadı.");
        return;
      }

      const targetDir = join(outDir, "ort");
      mkdirSync(targetDir, { recursive: true });
      for (const file of files) {
        copyFileSync(join(ortDistDir, file), join(targetDir, file));
      }
    },

    closeBundle() {
      // ORT paketi wasm'ı `new URL(..., import.meta.url)` ile andığı için Vite onun bir kopyasını assets/ içine de
      // çıkarıyor. Site `wasmPaths: "./ort/"` verdiğinden bu kopya hiç istenmez; yalnızca dist'i ~15 MB büyütür.
      const assetsDir = join(outDir, "assets");
      if (!existsSync(assetsDir)) return;
      for (const file of readdirSync(assetsDir)) {
        if (file.startsWith("ort-wasm") && file.endsWith(".wasm")) rmSync(join(assetsDir, file));
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [solid(), ortWasmPlugin()],
  server: {
    fs: {
      // `../pkg` (tinyfix-tr) geliştirme sunucusundan okunabilsin.
      allow: ["..", "."],
    },
  },
  optimizeDeps: {
    exclude: ["tinyfix-tr", "onnxruntime-web", "onnxruntime-web/wasm"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      output: {
        // İçe aktarma okuyucuları (Word, Markdown) yalnızca dosya açılınca iner: "lazy-" önekiyle service worker'ın
        // önden indirdiği kabuk dosyalarının dışında tutulur (scripts/generate-sw.mjs).
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.includes("/node_modules/mammoth/"))
            ? "assets/lazy-docx-[hash].js"
            : chunk.moduleIds.some((id) => id.includes("/node_modules/markdown-it/"))
              ? "assets/lazy-md-[hash].js"
              : "assets/[name]-[hash].js",
      },
    },
  },
});
