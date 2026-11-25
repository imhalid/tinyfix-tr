<p align="center">
  <img src="https://raw.githubusercontent.com/imhalid/tinyfix-tr/main/hf/banner.png" alt="tinyfix-tr: Türkçe yazım, internetsiz. Yazarken bende → ben de, hber → haber düzeltiliyor; düzeltilemeyen kelimenin altı çiziliyor ve öneri sunuluyor." width="880">
</p>

Türkçe yazım hatalarını TDK kurallarına göre düzelten, tarayıcıda ve Node.js'te **internetsiz** çalışan küçük bir paket. Emin olduğu hatayı düzeltir, emin olamadığı kelimeyi işaretleyip öneri sunar. Yazdığınız metin cihazdan çıkmaz.

```bash
npm install tinyfix-tr
```

```ts
import { loadTdkai } from "tinyfix-tr";

const tdkai = await loadTdkai();
await tdkai.fix("Bugün cok yorgunum, Ankaraya herkez geldi.");
// "Bugün çok yorgunum, Ankara'ya herkes geldi."
```

**[Tarayıcıda deneyin](https://tdkai.halid.dev)**

## Ne düzeltir

| Tür | Örnekler |
|---|---|
| `turkce-karakter` | `cok → çok`, `nasil → nasıl`, `oldu → öldü` |
| `kesme` | `Ankaraya → Ankara'ya` |
| `bitisik-ayri` | `birşey → bir şey`, `hiç bir → hiçbir`, `bende → ben de` |
| `yazim` | `herkez → herkes`, `malesef → maalesef` |

Kod parçalarına, adreslere, sayılara ve emin olamadığı özel adlara dokunmaz.

## Nasıl çalışır

1. **Sözlük ve kurallar:** Kelime ve kelime çifti sıklıklarına dayanan bir düzeltici, Zemberek tabanlı Türkçe biçimbilimle denetlenir. Bir kelimeyi yalnızca yazılan biçime göre farkı açıksa değiştirir.
2. **İşaretleme:** Biçimbilimin reddettiği ve sözlükte olmayan kelimeyi en fazla beş sıralı öneriyle işaretler.
3. **Bağlam modeli (isteğe bağlı):** `context: true` ile açılan 3 MB'lık küçük bir Transformer, belirsiz durumlarda (`oldu/öldü`, `de/da`, `ki`, `mi`) cümlenin tamamına bakarak seçim yapar.

## Hangi veriyle hazırlandı

- **Sıklıklar:** Türkçe Vikipedi ve OpenSubtitles (OPUS) altyazılarından çıkarılan kelime sayımları. Metinlerin kendisi dağıtılmaz, yalnızca sayımlar.
- **Biçimbilim:** [Zemberek-NLP](https://github.com/ahmetaa/zemberek-nlp) sözlüğünden türetildi.
- **Bağlam modeli:** Aynı Vikipedi ve altyazı metinlerinden üretilen, gerçekten belirsiz örneklerle eğitilmiş 2,8 milyon parametreli, int8 sıkıştırılmış bir model.

Dosyalar ilk kullanımda [Hugging Face](https://huggingface.co/imhalid/tdk-ai) üzerinden indirilir (yaklaşık 6 MB, bağlam modeliyle 9 MB). Her paket sürümü depodaki belirli bir revizyonu yükler. Kendi sunucunuzdan vermek için `loadTdkai({ baseUrl: "/models/" })` yeterli.

## Ne kadar iyi çalışıyor

Hiç ayarlanmadığı, ayrı tutulmuş kümelerde ölçüldü. *Düzeltilen*, otomatik düzeltilen; *bulunan* ise düzeltilen veya öneriyle işaretlenen hatalardır.

| Küme | Düzeltilen | Bağlamla | Bulunan |
|---|---|---|---|
| Hatalı Vikipedi cümleleri (400) | %84,0 | %89,3 | %98,3 |
| Sohbet yazısı, eksik harfler (811 kelime) | %69,7 | %83,6 | %99,4 |
| Sohbet yazısı, karışık hatalar (602 kelime) | %68,8 | %75,2 | %99,5 |

Doğru metinde yanlış alarm: Vikipedi cümlelerinde 1.000 kelimede yaklaşık 2, temiz sohbet cümlelerinde 0,1.

## API

| Çağrı | Ne yapar |
|---|---|
| `loadTdkai(options?)` | Sözlüğü indirir, bir `Tdkai` örneği döndürür. |
| `tdkai.check(text, options?)` | Düzeltmeleri `{ from, to, original, replacement, kind, confidence }` listesi olarak döndürür. |
| `tdkai.apply(text, fixes)` | Düzeltmeleri metne uygular. |
| `tdkai.fix(text, options?)` | `check` ve `apply` birlikte. |
| `tdkai.ignore(word)` / `unignore(word)` | Kelimeyi bir daha değiştirmez / yeniden denetime açar. |
| `tdkai.dispose()` | Kaynakları ve Worker'ı kapatır. |

**`loadTdkai` seçenekleri:** `baseUrl` (varsayılan: Hugging Face), `context` (bağlam modeli, varsayılan `false`), `mode` (`"careful"` veya `"balanced"`), `worker` (Web Worker'da çalıştır), `wasmPaths`, `onProgress`, `onWarning`.

**`check` seçenekleri:** `range` (yalnızca `[from, to)` aralığını denetle, kalanı bağlam olarak oku), `kinds` (yalnızca belirli türler).

Yazarken tüm metni yeniden denetlemek yerine `range` ile yalnızca yeni yazılan kelimeyi kontrol edin; kullanıcı bir düzeltmeyi geri alırsa `ignore` çağırın:

```ts
const fixes = await tdkai.check("Sen geldinmi?", { range: [4, 12] }); // yalnızca "geldinmi"
```

## Nerede çalışır

Tarayıcılar, Web Worker'lar ve Node.js 22 veya üstü. Yalnızca Türkçe. `from` ve `to` değerleri UTF-16 kod birimi sırasıdır.

## Lisans

Kod MIT. Hugging Face'teki veri dosyaları, Vikipedi'den türetildiği için CC BY-SA 4.0 ile yayınlanır.
