/**
 * Sözlük, biçimbilim, bağlam modeli ve ORT dosyaları service worker önbelleğinde ("autr-models-*", "autr-ort-*")
 * durur. Belgeler IndexedDB'de olduğu için buradaki işlemler onlara dokunmaz.
 */
const DATA_CACHE_PREFIXES = ["autr-models-", "autr-ort-"];

async function dataCacheNames(): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  const names = await caches.keys();
  return names.filter((name) => DATA_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

/** Önbellekteki indirilmiş verinin bayt cinsinden toplamı; önbellek yoksa null. */
export async function storedDataSize(): Promise<number | null> {
  if (typeof caches === "undefined") return null;
  let total = 0;
  for (const name of await dataCacheNames()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (!response) continue;
      const length = Number(response.headers.get("content-length"));
      total += Number.isFinite(length) && length > 0 ? length : (await response.blob()).size;
    }
  }
  return total;
}

/** İndirilmiş verinin hepsini siler. Çalışan motor bellekte kalır; sayfa bir sonraki açılışta yeniden indirir. */
export async function deleteStoredData(): Promise<void> {
  await Promise.all((await dataCacheNames()).map((name) => caches.delete(name)));
}

/**
 * Önbelleği silip dosyaları tarayıcının HTTP önbelleğini atlayarak yeniden indirir. İstekler service worker'dan
 * geçtiği için yeni kopyalar önbelleğe de yazılır.
 */
export async function redownloadData(urls: readonly string[]): Promise<void> {
  await deleteStoredData();
  for (const url of urls) {
    const response = await fetch(url, { cache: "reload" });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    await response.arrayBuffer();
  }
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
}
