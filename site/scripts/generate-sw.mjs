// Derleme sonrasında dist/sw.js dosyasını üretir.
// Uygulama kabuğunu, models/ altındaki sözlük + bağlam modelini ve ort/ altındaki ORT .wasm/.mjs dosyalarını ayrı önbelleklerde tutar.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

// models/manifest.json: the real size of each model file. Servers often compress these files, and then the browser
// can't tell how big they are; the package reads this file to show accurate download progress.
const modelsDir = join(distDir, "models");
try {
  const sizes = {};
  for (const name of readdirSync(modelsDir)) {
    if (name === "manifest.json") continue;
    sizes[name] = statSync(join(modelsDir, name)).size;
  }
  writeFileSync(join(modelsDir, "manifest.json"), JSON.stringify(sizes));
} catch {
  // No models/ folder yet: nothing to describe.
}

function collectFiles(directory) {
  const results = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function hashFiles(paths) {
  if (paths.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const rel of paths) {
    hash.update(rel);
    hash.update(readFileSync(join(distDir, rel)));
  }
  return hash.digest("hex").slice(0, 12);
}

const allRelative = collectFiles(distDir)
  .map((full) => relative(distDir, full).replaceAll("\\", "/"))
  .filter((rel) => rel !== "sw.js" && !rel.endsWith(".DS_Store") && !rel.endsWith(".map"))
  .sort();

const isOrtAsset = (rel) =>
  rel.startsWith("ort/") ||
  rel.endsWith(".wasm") ||
  /(?:^|\/)ort\.wasm\.bundle/.test(rel);

const modelFiles = allRelative.filter((rel) => rel.startsWith("models/"));
const ortFiles = allRelative.filter(isOrtAsset);
const shellFiles = allRelative.filter((rel) => !rel.startsWith("models/") && !isOrtAsset(rel));

const shellVersion = hashFiles(shellFiles);
const modelVersion = hashFiles(modelFiles);
const ortVersion = hashFiles(ortFiles);

const shellUrls = shellFiles.map((file) => `./${file}`);
const modelUrls = modelFiles.map((file) => `./${file}`);
const ortUrls = ortFiles.map((file) => `./${file}`);

const swSource = `// scripts/generate-sw.mjs tarafından üretildi. Elle düzenlemeyin.
const SHELL_CACHE = "autr-shell-${shellVersion}";
const MODEL_CACHE = "autr-models-${modelVersion}";
const ORT_CACHE = "autr-ort-${ortVersion}";
const SHELL_FILES = ${JSON.stringify(shellUrls, null, 2)};
const MODEL_FILES = ${JSON.stringify(modelUrls, null, 2)};
const ORT_FILES = ${JSON.stringify(ortUrls, null, 2)};
const MATCH_OPTIONS = { ignoreSearch: true, ignoreVary: true };

async function precacheMissing(cacheName, urls, sequential = false) {
  if (urls.length === 0) return;
  const cache = await caches.open(cacheName);
  if (sequential) {
    // Büyük sözlük, context.onnx ve .wasm dosyalarını sırayla önbelleğe almak
    // ilk ziyarette ana sayfanın indirmeleriyle bağlantı çakışmasını azaltır.
    for (const url of urls) {
      const existing = await cache.match(url, MATCH_OPTIONS);
      if (!existing) {
        await cache.add(url);
      }
    }
    return;
  }
  await Promise.all(
    urls.map(async (url) => {
      const existing = await cache.match(url, MATCH_OPTIONS);
      if (!existing) {
        await cache.add(url);
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  // Only the app shell is cached on install. The lexicon, morphology, and optional ORT files are cached lazily
  // the first time the page requests them (cache-first handler below).
  event.waitUntil(precacheMissing(SHELL_CACHE, SHELL_FILES, false).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                (name.startsWith("autr-shell-") && name !== SHELL_CACHE) ||
                (name.startsWith("autr-models-") && name !== MODEL_CACHE) ||
                (name.startsWith("autr-ort-") && name !== ORT_CACHE),
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function handleNavigation(request) {
  try {
    const network = await fetch(request);
    if (network.ok && !network.redirected) {
      return network;
    }
    const fallback = await caches.match("./index.html", MATCH_OPTIONS);
    return (await cleanResponse(fallback)) ?? network;
  } catch {
    const fallback = await caches.match("./index.html", MATCH_OPTIONS);
    return (await cleanResponse(fallback)) ?? new Response("Çevrimdışı", { status: 503 });
  }
}

async function handleCacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, MATCH_OPTIONS);
  if (cached) return cached;

  const network = await fetch(request);
  if (network.ok && network.type === "basic") {
    cache.put(request, network.clone()).catch(() => {});
  }
  return network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.includes("/models/")) {
    event.respondWith(handleCacheFirst(request, MODEL_CACHE));
    return;
  }

  if (url.pathname.includes("/ort/") || url.pathname.endsWith(".wasm") || url.pathname.includes("/ort.wasm.bundle")) {
    event.respondWith(handleCacheFirst(request, ORT_CACHE));
    return;
  }

  event.respondWith(handleCacheFirst(request, SHELL_CACHE));
});
`;

writeFileSync(join(distDir, "sw.js"), swSource, "utf8");
console.log(
  `dist/sw.js oluşturuldu (${shellFiles.length} uygulama dosyası: ${shellVersion}, ${modelFiles.length} model dosyası: ${modelVersion}, ${ortFiles.length} ORT dosyası: ${ortVersion})`,
);
