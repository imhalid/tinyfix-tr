# tinyfix-tr

Tarayıcıda ve Node.js üzerinde **internetsiz** çalışan Türkçe otomatik düzeltme paketi. Sözlük ve kurallar cihazda çalışır; isteğe bağlı bağlam modeli (`context: true`) yalnızca istendiğinde dinamik `import()` ile `onnxruntime-web` yükler.

## Kurulum

```bash
npm install tinyfix-tr
```

Ek bir ayar gerekmez: sözlük dosyaları ilk kullanımda [Hugging Face](https://huggingface.co/imhalid/tdk-ai) üzerinden indirilir (yaklaşık 6 MB; bağlam modeli istenirse 3 MB daha). Her paket sürümü depodaki belirli bir revizyonu yükler.

Dosyaları kendi sunucunuzdan vermek isterseniz `lexicon.bin`, `morph.bin`, `known.tsv` (ve bağlam modeli için `context.onnx`) dosyalarını Hugging Face deposundan indirip bir klasöre (örneğin `public/models/`) koyun ve `baseUrl` verin. Eski düz metin TSV dosyaları (`unigrams.tsv`, `bigrams.tsv`, `known.tsv`) geriye dönük uyumluluk için hâlâ desteklenir.

## Hızlı Başlangıç

```ts
import { loadTdkai } from "tinyfix-tr";

const tdkai = await loadTdkai({
  worker: true,
  context: true, // isteğe bağlı: context.onnx + onnxruntime-web
  wasmPaths: "/ort/", // isteğe bağlı: ORT .wasm/.mjs dosyalarının konumu
  onProgress: ({ ratio, stage, file }) => {
    console.log(stage, file ?? "", Math.round(ratio * 100) + "%");
  },
  onWarning: (warning) => {
    console.warn(warning);
  },
});

const duzeltilmis = await tdkai.fix("Bugün cok yorgunum, Ankaraya herkez geldi.");
// "Bugün çok yorgunum, Ankara'ya herkes geldi."

await tdkai.dispose();
```

`context: false` (varsayılan) iken `context.onnx` indirilmez ve `onnxruntime-web` hiç yüklenmez. `context: true` verildiğinde `context.onnx` bulunamazsa veya ONNX oturumu açılamazsa paket uyarı verir (`console.warn` ve `onWarning`) ve bağlam modeli olmadan sözlük kurallarıyla çalışmaya devam eder (`tdkai.hasContext === false`).

## Düzeltmeleri İnceleme ve Uygulama

`check` metodu, metinde yapılacak düzeltmeleri sıralı ve çakışmayan bir liste olarak döndürür:

```ts
const metin = "Birşey söylemek istiyorum ama hiç bir fikrim yok.";
const duzeltmeler = await tdkai.check(metin);
/*
[
  { from: 0, to: 6, original: "Birşey", replacement: "Bir şey", kind: "bitisik-ayri", confidence: 0.986 },
  { from: 30, to: 37, original: "hiç bir", replacement: "hiçbir", kind: "bitisik-ayri", confidence: 0.955 },
]
*/

const sonuc = tdkai.apply(metin, duzeltmeler);
```

## Yazarken Düzeltme (`range`)

Kullanıcı bir kelimeyi bitirdiğinde (boşluk veya noktalama girildiğinde) tüm belgeyi yeniden denetlemek yerine yalnızca ilgili aralığı kontrol edebilirsiniz. Metnin geri kalanı bağlam (cümle başı, soru işareti, Türkçe harf kullanımı ve bağlam modeli penceresi) olarak okunur:

```ts
const paragraf = "Sen geldinmi?";
const fixes = await tdkai.check(paragraf, {
  range: [4, 12], // yalnızca "geldinmi" aralığı; "?" bağlam olarak okunur
  kinds: ["turkce-karakter", "kesme", "bitisik-ayri", "yazim"],
});
```

Kullanıcı bir düzeltmeyi geri aldığında aynı kelimeyi tekrar değiştirmemek için `ignore` çağırın:

```ts
tdkai.ignore(fix.original);
```

## Düzeltme Türleri (`FixKind`)

| Dış tür | Açıklama | Örnekler | İç motor karşılığı |
|---|---|---|---|
| `"turkce-karakter"` | Eksik Türkçe karakterler | `cok → çok`, `nasil → nasıl`, `oldu → öldü` | `marks`, harf değiştiren `context`/`known` |
| `"kesme"` | Özel adlara gelen eklerde eksik kesme işareti | `Ankaraya → Ankara'ya` | `apostrophe` |
| `"bitisik-ayri"` | Bitişik/ayrı yazım, soru eki, `de/da`, `ki` | `birşey → bir şey`, `hiç bir → hiçbir`, `bende → ben de` | `split`, `join`, boşluk değiştiren `context`/`known` |
| `"yazim"` | Klavye hataları ve bilinen yazım yanlışları | `herkez → herkes`, `malesef → maalesef`, `yapabiliur → yapabilir` | `typo`, tek kelimelik `known` |

## API

| Çağrı | Açıklama |
|---|---|
| `loadTdkai(options?)` | Sözlük (ve istenirse `context.onnx`) dosyalarını indirir ve bir `Tdkai` örneği döndürür. |
| `createTdkai(data, options?)` | Bellekteki ham TSV verisinden (isteğe bağlı `contextModel` ile) eşzamanlı olarak `Tdkai` oluşturur. |
| `tdkai.hasContext` | Bağlam modelinin etkin olarak yüklenip yüklenmediğini belirtir. |
| `tdkai.check(text, options?)` | Çakışmayan, sıralı `Fix[]` listesi döndürür. |
| `tdkai.apply(text, fixes)` | Düzeltmeleri metne uygular; konum veya metin uyuşmazsa hata fırlatır. |
| `tdkai.fix(text, options?)` | `check` ve `apply` adımlarını birlikte çalıştırır. |
| `tdkai.ignore(word)` | Belirtilen kelime veya ifadeyi bir daha değiştirmez (Türkçe büyük/küçük harf duyarsız). |
| `tdkai.unignore(word)` | Yoksayılan kelimeyi yeniden denetime açar. |
| `tdkai.setMode(mode)` | Hassasiyet kipini (`"careful"` veya `"balanced"`) günceller. |
| `tdkai.dispose()` | Kaynakları, varsa ONNX oturumunu ve Web Worker'ı sonlandırır. |

### `LoadOptions`

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `baseUrl` | Hugging Face `imhalid/tdk-ai` (sürüme sabit) | `lexicon.bin`, `morph.bin`, `known.tsv` (veya geriye dönük `unigrams.tsv`/`bigrams.tsv`) ve isteğe bağlı `context.onnx` dosyalarının bulunduğu adres. |
| `data` | — | Ağ isteği yerine bellekteki ikili (`BinaryData`) veya ham TSV (`RawData`) verisini kullanır. |
| `mode` | `"careful"` | `"careful"` motorun temkinli varsayılan ayarını, `"balanced"` biraz daha cesur eşikleri kullanır. |
| `worker` | `false` | `true` verilirse sözlük yükleme, bağlam modeli ve denetim ayrı bir Web Worker içinde çalışır. |
| `createWorker` | — | Özel `Worker` örneği sağlamak için isteğe bağlı kurucu işlev. |
| `context` | `false` | `true` verilirse `context.onnx` indirilir ve `onnxruntime-web` ile bağlam modeli açılır. |
| `wasmPaths` | ORT varsayılanı | `onnxruntime-web` `.wasm`/`.mjs` dosyalarının bulunduğu dizin URL'si. |
| `contextModel` | — | Testler veya özel çalışma zamanları için bellekteki `ContextModel` ya da `RunModel` işlevi. |
| `loadContextSession` | `createOnnxContextSession` | İndirilen `context.onnx` baytlarından oturum açan özel yükleyici. |
| `onProgress` | — | `{ ratio, loaded, total, stage, file }` ile yükleme ilerlemesini bildirir (`context.onnx` dahil). |
| `onWarning` | — | Bağlam modeli yüklenemediğinde oluşan uyarı metnini bildirir. |
| `fetch` | `globalThis.fetch` | İsteğe bağlı özel `fetch` işlevi. |
| `signal` | — | İndirmeyi iptal etmek için `AbortSignal`. |
| `ignored` | — | Başlangıçta yoksayılacak kelimeler listesi. |

### `CheckOptions`

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `range` | Tüm metin | `[from, to)` aralığıyla kesişen düzeltmeler döndürülür; metnin kalanı bağlam olarak okunur. |
| `kinds` | Tüm türler | Yalnızca belirtilen `FixKind` türlerini döndürür. |
| `mode` | Örnek kipi | Yalnızca bu çağrı için geçici kip (`"careful"` / `"balanced"`). |

### Web Worker Girişi (`tdkai/worker`)

`loadTdkai({ worker: true })` modern paketleyicilerle (Vite, webpack) paketin kendi worker dosyasını otomatik başlatır. Worker dosyasını kendiniz bağlamak isterseniz `tdkai/worker` girişini doğrudan kullanabilirsiniz:

```ts
const worker = new Worker(new URL("tdkai/worker", import.meta.url), { type: "module" });
```

## Geliştirme

```bash
npm run check   # TypeScript tür denetimi
npm test        # Birim testleri (node --test)
npm run build   # dist/ klasörüne derleme
```
