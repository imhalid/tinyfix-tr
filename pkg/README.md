# autr

Tarayıcıda ve Node.js üzerinde **internetsiz** çalışan Türkçe otomatik düzeltme paketi. Sözlük ve kurallar cihazda çalışır; isteğe bağlı bağlam modeli (`context: true`) yalnızca istendiğinde dinamik `import()` ile `onnxruntime-web` yükler.

## Kurulum

```bash
npm install autr
```

Sıkıştırılmış tarayıcı veri dosyalarını (`lexicon.bin`, `morph.bin`, `known.tsv`, isteğe bağlı `manifest.json`) ve bağlam modelini kullanacaksanız `context.onnx` dosyasını uygulamanızda sunacağınız bir klasöre (örneğin `public/models/`) yerleştirin. Eski düz metin TSV dosyaları (`unigrams.tsv`, `bigrams.tsv`, `known.tsv`) geriye dönük uyumluluk için hâlâ desteklenir.

## Hızlı Başlangıç

```ts
import { loadAutr } from "autr";

const autr = await loadAutr({
  baseUrl: "/models/",
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

const duzeltilmis = await autr.fix("Bugün cok yorgunum, Ankaraya herkez geldi.");
// "Bugün çok yorgunum, Ankara'ya herkes geldi."

await autr.dispose();
```

`context: false` (varsayılan) iken `context.onnx` indirilmez ve `onnxruntime-web` hiç yüklenmez. `context: true` verildiğinde `context.onnx` bulunamazsa veya ONNX oturumu açılamazsa paket uyarı verir (`console.warn` ve `onWarning`) ve bağlam modeli olmadan sözlük kurallarıyla çalışmaya devam eder (`autr.hasContext === false`).

## Düzeltmeleri İnceleme ve Uygulama

`check` metodu, metinde yapılacak düzeltmeleri sıralı ve çakışmayan bir liste olarak döndürür:

```ts
const metin = "Birşey söylemek istiyorum ama hiç bir fikrim yok.";
const duzeltmeler = await autr.check(metin);
/*
[
  { from: 0, to: 6, original: "Birşey", replacement: "Bir şey", kind: "bitisik-ayri", confidence: 0.986 },
  { from: 30, to: 37, original: "hiç bir", replacement: "hiçbir", kind: "bitisik-ayri", confidence: 0.955 },
]
*/

const sonuc = autr.apply(metin, duzeltmeler);
```

## Yazarken Düzeltme (`range`)

Kullanıcı bir kelimeyi bitirdiğinde (boşluk veya noktalama girildiğinde) tüm belgeyi yeniden denetlemek yerine yalnızca ilgili aralığı kontrol edebilirsiniz. Metnin geri kalanı bağlam (cümle başı, soru işareti, Türkçe harf kullanımı ve bağlam modeli penceresi) olarak okunur:

```ts
const paragraf = "Sen geldinmi?";
const fixes = await autr.check(paragraf, {
  range: [4, 12], // yalnızca "geldinmi" aralığı; "?" bağlam olarak okunur
  kinds: ["turkce-karakter", "kesme", "bitisik-ayri", "yazim"],
});
```

Kullanıcı bir düzeltmeyi geri aldığında aynı kelimeyi tekrar değiştirmemek için `ignore` çağırın:

```ts
autr.ignore(fix.original);
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
| `loadAutr(options?)` | Sözlük (ve istenirse `context.onnx`) dosyalarını indirir ve bir `Autr` örneği döndürür. |
| `createAutr(data, options?)` | Bellekteki ham TSV verisinden (isteğe bağlı `contextModel` ile) eşzamanlı olarak `Autr` oluşturur. |
| `autr.hasContext` | Bağlam modelinin etkin olarak yüklenip yüklenmediğini belirtir. |
| `autr.check(text, options?)` | Çakışmayan, sıralı `Fix[]` listesi döndürür. |
| `autr.apply(text, fixes)` | Düzeltmeleri metne uygular; konum veya metin uyuşmazsa hata fırlatır. |
| `autr.fix(text, options?)` | `check` ve `apply` adımlarını birlikte çalıştırır. |
| `autr.ignore(word)` | Belirtilen kelime veya ifadeyi bir daha değiştirmez (Türkçe büyük/küçük harf duyarsız). |
| `autr.unignore(word)` | Yoksayılan kelimeyi yeniden denetime açar. |
| `autr.setMode(mode)` | Hassasiyet kipini (`"careful"` veya `"balanced"`) günceller. |
| `autr.dispose()` | Kaynakları, varsa ONNX oturumunu ve Web Worker'ı sonlandırır. |

### `LoadOptions`

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `baseUrl` | `"/models/"` | `lexicon.bin`, `morph.bin`, `known.tsv` (veya geriye dönük `unigrams.tsv`/`bigrams.tsv`) ve isteğe bağlı `context.onnx` dosyalarının bulunduğu adres. |
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

### Web Worker Girişi (`autr/worker`)

`loadAutr({ worker: true })` modern paketleyicilerle (Vite, webpack) paketin kendi worker dosyasını otomatik başlatır. Worker dosyasını kendiniz bağlamak isterseniz `autr/worker` girişini doğrudan kullanabilirsiniz:

```ts
const worker = new Worker(new URL("autr/worker", import.meta.url), { type: "module" });
```

## Geliştirme

```bash
npm run check   # TypeScript tür denetimi
npm test        # Birim testleri (node --test)
npm run build   # dist/ klasörüne derleme
```
