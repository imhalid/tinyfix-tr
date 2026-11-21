# Görev 6 — Tarayıcı Boyutu Küçültme ve Biçimbilim Entegrasyonu Notları

Bu belge, `autr` tarayıcı motorunun çekirdek indirme boyutunu **~24,2 MB gzip → ~3,97 MB gzip** düzeyine indirmek ve Zemberek tabanlı biçimbilim katmanını (`src/morphology/`) npm paketi (`pkg/`) ile siteye (`site/`) taşımak için yapılan tasarım kararlarını, dosya boyutlarını, tüm doğruluk/hız ölçümlerini ve açık riskleri özetler.

---

## 1. Ne Yapıldı ve Neden?

### A. Tekrarlanabilir İkili Model Üretimi (`scripts/build-browser-models.ts`)
- Kök `package.json` içine `npm run build:models` (`node scripts/build-browser-models.ts`) eklendi.
- Betik, `data/work/unigrams_conv.tsv`, `data/work/bigrams.tsv`, `data/rules/known.tsv` ve `data/morph/*.dict` dosyalarından `site/public/models/` altına `lexicon.bin`, `morph.bin`, `known.tsv` ve `manifest.json` üretir; eski 58 MB'lık ham `unigrams.tsv` ve `bigrams.tsv` dosyalarını kaldırır.
- Kodlayıcı ve çözücü aynı TypeScript modüllerini (`src/lexicon-binary.ts`, `src/morphology/binary.ts`, `src/rules/turkish-rules.ts`) paylaştığı için biçim kayması riski yoktur; çalışma zamanında sıfır yeni dış bağımlılık eklendi.

### B. İkili Sözlük Biçimi (`ALX1` — `src/lexicon-binary.ts`, `src/lexicon.ts`)
1. **Akıllı kelime çifti (bigram) elemesi + Bölünmüş CSR (Split-CSR) kodlama:**
   - `src/corrector.ts` içinde `lexicon.pair()` yalnızca dört yerde çağrılır: `joinCandidate` (`JOIN_FIRST` veya `JOIN_SECOND`), `addQuestionHarmony` (`QUESTION`), `knownFix` (iki kelimeli `known.tsv` kuralları) ve `addSplits`.
   - `joinCandidate`, `QUESTION` ve iki kelimeli `known.tsv` çiftlerinin **tamamı (`count >= 2`)** korundu; diğer bölme adayları ise `CAREFUL` bölme eşiğinin (`log(pair + 1) - 0.5 >= 2.5 ⇒ pair >= 20`) altındaki kayıtları elemek üzere **`count >= 20`** ile filtrelendi.
   - Çift sayısı **2.460.499 → 274.223**'e (9× azalma) indi. Çiftler metin yerine sıralı unigram kimlikleriyle (`id1`, `id2`), son kelimesi `JOIN_SECOND`/`QUESTION` olanlar `bySecond`, diğerleri `byFirst` CSR bölümlerinde fark-varint kodlamasıyla saklandı. Boyut **38,8 MB ham / 16,19 MB gzip → ~0,57 MB gzip**'e düştü; doğruluk kaybı **sıfır**.
2. **Sütunlu 1-Bayt Türkçe Alfabe Ön-Ek Kodlaması (Columnar Front-Coding):**
   - `unigrams_conv.tsv` içindeki 1,24M biçimin tamamı yalnızca **36 benzersiz karakter** (`'a-zâçîöûüğış`) kullanır. Her karakteri 1 baytlık koda eşleyip 64 kelimelik bloklarda (`blockSize = 64`) `prefixLens[]`, `suffixLens[]` ve `chars[]` dizilerini ayrı sütunlar halinde saklamak hem UTF-8'in Türkçe karakterlerdeki 2-bayt maliyetini ortadan kaldırdı hem de gzip'in Türkçe ek zincirlerini kesintisiz sıkıştırmasını sağladı.
   - Çalışma zamanında JS `Map<string, number>` kurmak yerine doğrudan `Uint8Array` üzerinde 2-baytlık önek kova dizini (`37 × 37 = 1.369` kova) + ikili arama yapılır. Bu sayede `lexicon.bin` yükleme/dizinleme süresi **~6.000 ms → 2,4 ms**'ye, bellek tüketimi ~500 MB'tan ~15 MB'a düştü.
3. **1-Bayt Logaritmik Sıklık Nicemlemesi + 51 Seviyeli Büyük Harf Payı:**
   - Sıklıklar: `0..79` **tam tamsayı** (motorun `3`, `5`, `7`, `10`, `20`, `50`, `70` gibi tüm küçük eşikleri bire bir korunur), `80..3.000.000` arası 176 logaritmik kova (doğal logaritma hatası ≤ ±0,03).
   - `capitalShare`: `0..50` (adım `0,02`); `0,50`, `0,58`, `0,70` gibi eşikler yüksek kesinlikle korunur.
4. **Nadir Kesmeli Biçimlerin Ayıklanması + `count = 2, 3` İçin Bloom Kuyruk Katmanları:**
   - Kesmeli biçimlerde (`ankara'ya`) `count < 7` olan **133.419** kayıt elendi: `addApostrophes` kuralları `CAREFUL` için `seen >= 20` (veya `seenCaps >= 10`), `BALANCED` için `seen >= 12` ve kesmeli ek işaretlemesi `count >= 7` ister; dolayısıyla `< 7` kayıtları hiçbir kuralı tetikleyemez.
   - Kesmesiz nadir biçimlerde doğrudan eleme yapmak (`count < 3` veya `< 5`) `dev clean` yanlış alarmlarını `1,28 → 1,44` (+0,16, bütçe aşımı) ve `conv clean` oranını `6,56 → 6,66` düzeyine çıkardı; çünkü sözlük dışı yabancı adlar ve özel terimler biçimbilimce tanınmadığından `typedCount = 0` olup `typoInvalidThreshold = 1,5` kuralına düşüyordu.
   - Çözüm: `count >= 4` tüm kelimeler, `count >= 7` tüm kesmeli biçimler ve korunan bigramların kullandığı her kelime **tam metin tablosunda** (`726.864` biçim) tutulurken, yalnızca koruma amaçlı (`count = 2` ve `count = 3`, hiçbir düzeltme kuralında hedef aday olamayan) **265.513 + 120.322** nadir biçim iki ayrı düşük yanlış-pozitifli Bloom filtresinde (`count = 2` için 14 bit/öğe ≈ %0,12 FP; `count = 3` için 16 bit/öğe ≈ %0,046 FP) saklandı. Böylece hem nadir temiz kelimeler eksiksiz korundu hem ~0,55 MB gzip tasarruf edildi.

### C. Biçimbilim Katmanının Sıkıştırılması ve Tarayıcıya Taşınması (`AMR1`)
- `src/morphology/binary.ts` ile `parseDictionaries()` çıktısındaki **31.228** etkin `DictionaryItem` (atlanan `non-tdk`/`informal`/`Punc` satırları temizlenmiş halde) ön-ek kodlu, özellik-paletli (38 benzersiz bitmask) kayıpsız `AMR1` biçimine (`morph.bin`) kodlandı.
- Boyut: **480 KB ham / 138 KB gzip (4 `.dict` dosyası) → 254 KB ham / 103 KB gzip** (`morph.bin`).
- Yükleme süresi: **25,9 ms** (medyan).
- Eşdeğerlik doğrulaması: `src/morphology/morphology.test.ts` içinde `sample-valid.txt` (3.000 kelime) + `sample-wrong.txt` (483 kelime) + şapkalı/bileşik kenar durumlarında, ayrıca `unigrams_conv.tsv` içindeki en sık **20.000** kelimede `isWord()` **0/20.000 fark**, `analyze()` çözümleme kümesi **0/20.000 fark** ile doğrulandı (yalnızca 15 eşsesli kelimede çözümleme dizisinin sırası kök sıralamasına bağlı olarak yer değiştirdi; küme bire bir aynıdır).
- `pkg/src/data.ts`, `pkg/src/engine.ts`, `pkg/src/index.ts`, `pkg/src/types.ts`, `pkg/src/protocol.ts` güncellendi:
  - `DATA_FILES = ["lexicon.bin", "morph.bin", "known.tsv"]` ve güncel `FILE_WEIGHTS` (`0.94 / 0.05 / 0.01`).
  - `AutrEngine`, `loaded.morphology` doğrulayıcısını `new Corrector(data.lexicon, ..., data.known, data.morphology)` ile çekirdek motora bağlıyor (hem ana iş parçacığı hem Web Worker).
  - Mevcut TSV testleri ve eski sunucular için tam geriye dönük uyumluluk korundu (`manifest.json` `lexicon.bin` içeriyorsa doğrudan ikili indirir; `manifest.json` yoksa `lexicon.bin` 404 döndüğünde otomatik TSV'ye düşer).

### D. İsteğe Bağlı Bağlam Modeli (ORT) Tembel Yükleme Denetimi ve Service Worker Düzeltmesi
- `site/dist/` denetiminde kritik bir sızıntı yakalandı: Vite'ın dinamik `import("onnxruntime-web/wasm")` çağrıları için ürettiği `assets/ort.wasm.bundle.min-*.js` (2 kopya: 153 KB ham / 51 KB gzip) eski `site/scripts/generate-sw.mjs` filtresinden kaçıp `SHELL_FILES` içine giriyor ve service worker kurulumunda ilk ziyarette önbelleğe indiriliyordu.
- `site/scripts/generate-sw.mjs` düzeltildi: `ort/`, `*.wasm` ve `ort.wasm.bundle*` dosyalarının tamamı `ORT_FILES` / `ORT_CACHE` altına alındı, `SHELL_FILES` dışında bırakıldı.
- Doğrulama:
  - `site/dist/assets/index-*.js` ve `worker-*.js` içinde ORT yalnızca `createOnnxContextSession` içindeki dinamik `import()` üzerinden yükleniyor.
  - `site/dist/sw.js` `SHELL_FILES` listesinde hiçbir `.wasm`, `ort/` veya `ort.wasm.bundle` dosyası yok.
  - Gerçek `site/dist/models/` üzerinde `loadAutr({ baseUrl })` (`context: false`) yalnızca `manifest.json`, `lexicon.bin`, `morph.bin`, `known.tsv` dosyalarını istedi (`hasContext === false`).

### E. Ölçüm Araçları (`bench/`)
- `bench/setup.ts`, `bench/run.ts`, `bench/idempotence.ts` ve `bench/typing.ts` dosyalarına `--browser` (ve isteğe bağlı `--models <dizin>`) seçeneği eklendi. Bu seçenek, paketin gerçek `loadData()` yükleme yolundan `site/public/models/` klasörünü okur; ayrıştırma süresini ve ham/gzip/brotli boyutlarını raporlar.

---

## 2. Dosya Dosya Boyut Tablosu

### Önceki Durum vs. Yeni Durum (Çekirdek İlk Ziyaret)

| Bileşen | Önce (Ham) | Önce (gzip-9) | Şimdi (Ham) | Şimdi (gzip-6) | Şimdi (gzip-9) | Şimdi (brotli-6) |
|---|---:|---:|---:|---:|---:|---:|
| `bigrams.tsv` | 38,827 MB | 16,193 MB | *(kaldırıldı)* | — | — | — |
| `unigrams.tsv` | 19,242 MB | 7,797 MB | *(kaldırıldı)* | — | — | — |
| `models/lexicon.bin` | — | — | 6,167 MB | 3,673 MB | 3,654 MB | 3,555 MB |
| `models/morph.bin` | *(yoktu; 0,480 MB `.dict`)* | *(yoktu; 0,138 MB)* | 0,254 MB | 0,104 MB | 0,103 MB | 0,101 MB |
| `models/known.tsv` | 0,030 MB | 0,010 MB | 0,030 MB | 0,010 MB | 0,010 MB | 0,010 MB |
| `models/manifest.json` | <0,001 MB | <0,001 MB | <0,001 MB | <0,001 MB | <0,001 MB | <0,001 MB |
| **Çekirdek Veri Toplamı (`models/*`)** | **58,100 MB** | **24,001 MB** | **6,451 MB** | **3,787 MB** | **3,767 MB** | **3,667 MB** |
| `assets/worker-*.js` (motor + biçimbilim) | 0,036 MB | 0,013 MB | 0,098 MB | 0,034 MB | 0,034 MB | 0,032 MB |
| `assets/index-*.js` (uygulama + paket) | 0,421 MB | 0,138 MB | 0,483 MB | 0,158 MB | 0,158 MB | 0,150 MB |
| `assets/index-*.css` + `index.html` + `sw.js` + `favicon` + `manifest` | 0,028 MB | 0,008 MB | 0,028 MB | 0,008 MB | 0,008 MB | 0,008 MB |
| `ort.wasm.bundle.min-*.js` (SW sızıntısı) | 0,153 MB | 0,051 MB | *(ORT önbelleğine taşındı)* | **0 MB** | **0 MB** | **0 MB** |
| **Çekirdek Toplam (Veri + Motor/Uygulama JS/CSS)** | **58,738 MB** | **24,211 MB** | **7,061 MB** | **3,987 MB** | **3,967 MB** | **3,856 MB** |
| Gömülü yazı tipleri (`.woff2` + `.woff`, 12 dosya) | 0,243 MB | 0,243 MB | 0,243 MB | 0,243 MB | 0,243 MB | 0,243 MB |
| **İlk Ziyaret Genel Toplam (Yazı Tipleri Dahil)** | **58,981 MB** | **24,454 MB** | **7,304 MB** | **4,230 MB** | **4,210 MB** | **4,099 MB** |

> **İsteğe bağlı bağlam modeli (sınır dışı, varsayılan indirilmez):**
> `ort/ort-wasm-simd-threaded.wasm` (14,849 MB ham / 3,792 MB gzip-9), `ort/ort-wasm-simd-threaded.mjs` (24,7 KB ham / 9,2 KB gzip), `assets/ort.wasm.bundle.min-*.js` (2× 76,4 KB ham / 2× 25,5 KB gzip) ve Vite'ın `assets/` kopyası `ort-wasm-simd-threaded-*.wasm`. Kullanıcı ayarlardan bağlam modelini açmadıkça hiçbiri indirilmez ve SW tarafından önbelleğe alınmaz.

---

## 3. Ölçüm Tablosu

### A. Ana Karşılaştırma: Tam Motor → Biçimbilimsiz Paket → Yeni Tarayıcı Motoru (`--browser`)

| Ölçüm / Sınıf | Tam Motor (TSV + Biçimbilim) | Eski Paket (TSV, Biçimbilimsiz) | **Yeni Tarayıcı (`--browser`)** | Fark (Yeni − Tam) | Hedef / Bütçe |
|---|---:|---:|---:|---:|---|
| **Çekirdek veri (gzip-6 / gzip-9)** | 24,14 MB (TSV+dict) | 24,00 MB (TSV) | **3,79 / 3,77 MB** | **-84,3%** | ≤ 5 MB (hedef 3–4 MB) |
| **Çekirdek + Motor/Site JS/CSS (gzip-6 / gzip-9)** | — | 24,21 MB | **3,99 / 3,97 MB** | **-83,6%** | ≤ 5 MB (hedef 3–4 MB) |
| **Yükleme / ayrıştırma süresi** | ~5.965 ms | ~5.878 ms | **29 ms ayrıştırma** (~77 ms yerel fetch dahil) | **~200× hızlı** | < 1.000 ms |
| **Hız (`dev`, µs/kelime)** | 40 µs | 34 µs | **46 µs** (`conv`: 22 µs, `v1`: 60 µs) | +6 µs | < 100 µs |
| `dev / apostrophe` (fixed) | 57,0% | 56,0% | **57,3%** | **+0,3 puan** | ≥ -1,0 puan |
| `dev / ascii_sentence` (fixed) | 66,5% | 59,0% | **66,5%** | **0,0 puan** | ≥ -1,0 puan |
| `dev / ascii_word` (fixed) | 85,8% | 84,8% | **86,0%** | **+0,2 puan** | ≥ -1,0 puan |
| `dev / de_da_join` (fixed) | 75,0% | 58,0% | **75,0%** | **0,0 puan** | ≥ -1,0 puan |
| `dev / de_da_split` (fixed) | 85,7% | 83,7% | **85,7%** | **0,0 puan** | ≥ -1,0 puan |
| `dev / ki` (fixed) | 87,1% | 77,9% | **87,1%** | **0,0 puan** | ≥ -1,0 puan |
| `dev / mi` (fixed) | 62,1% | 34,5% | **62,1%** | **0,0 puan** | ≥ -1,0 puan |
| `dev / split_join` (fixed) | 98,7% | 99,0% | **98,7%** | **0,0 puan** | ≥ -1,0 puan |
| `dev / typo` (fixed) | 71,3% | 63,8% | **71,3%** | **0,0 puan** | ≥ -1,0 puan |
| **`dev / clean` (değişiklik / 1.000 kelime)** | **1,28** | 1,24 | **1,28** | **0,00** | ≤ +0,10 |
| **`conversation/clean` (değişiklik / 1.000 kelime)** | **6,56** | 6,80 | **6,56** | **0,00** | artmasın (≤ 6,56) |
| **`handwritten/neon-v1` (fixed / clean chg)** | **82,0% / 0** | 72,7% / 0 | **82,0% / 0** | **0,0 puan / 0** | — |
| **`idempotence` (`dev`, 2. geçiş)** | **1 / 4.398 (%0,02)** | 2 / 4.398 (%0,05) | **1 / 4.398 (%0,02)** | **0** | bozulmasın |
| **`typing` (`dev --lag 0 --auto-marked`)** | **78,4% / 99,4% eş** | 72,5% / 99,5% eş | **78,5% / 99,4% eş** | **+0,1 puan** | — |

### B. Adım Adım Küçültme Etkisi (Ablasyon Özeti)

| Adım | Unigram | Bigram | Veri (gzip-9) | `dev clean` | `conv clean` | `neon-v1` | Not |
|---|---:|---:|---:|---:|---:|---:|---|
| 0. Tam motor (TSV + biçimbilim) | 1.246.118 | 2.460.499 | 24,14 MB | 1,28 | 6,56 | 82,0% / 0 | Ölçüt |
| 1. Eski paket (TSV, biçimbilimsiz) | 1.246.118 | 2.460.499 | 24,00 MB | 1,24 | 6,80 | 72,7% / 0 | `mi` -27,6, `de_da_join` -17,0 puan |
| 2. + 1-bayt nicemleme (`80` tam + log, `u8` cap) | 1.246.118 | 2.460.499 | — | 1,28 | 6,56 | 82,0% / 0 | Nicemleme hatası ihmal edilebilir |
| 3. + Akıllı bigram eleme (`j≥2, s≥20`) + Split-CSR | 1.246.118 | 274.223 | 4,71 MB | 1,28 | 6,56 | 82,0% / 0 | Bigramlar 16,19 → 0,57 MB gzip |
| 4. + Sütunlu 1B ön-ek kodlama (`blk=64`) + `capMax=50` + `apos≥7` | 1.112.699 | 274.223 | 4,27 MB | 1,28 | 6,56 | 82,0% / 0 | Kesmeli `<7` elendi (133K kayıt) |
| 5. **(Seçilen)** + `count=2,3` Bloom kuyrukları (`14b`/`16b`) + `morph.bin` | 726.864 tam + 385.835 Bloom | 274.223 | **3,77 MB** | **1,28** | **6,56** | **82,0% / 0** | 0 puan düşüş, 29 ms ayrıştırma |
| *(Reddedilen)* `count >= 3` doğrudan eleme (Bloom'suz) | 910.680 | 274.223 | 3,85 MB | **1,44** | **6,66** | 82,4% / 0 | `dev clean` +0,16 ve `conv` +0,10 bütçeyi aştı |
| *(Reddedilen)* `count >= 5` + Bloom(2,3,4) | 652.390 + 460K | 274.223 | 3,62 MB | 1,28 | **6,61** | 82,0% / 0 | `conv clean` +0,05 arttı (`count=4` `capitalShare` kaybı) |

---

## 4. Açık Kalan Riskler ve Notlar

1. **Bloom filtresi yanlış pozitif (FP) olasılığı (görülmemiş setlerde):**
   - `count = 2` filtresi (`14 bit/öğe`, FP ≈ `%0,12`) ve `count = 3` filtresi (`16 bit/öğe`, FP ≈ `%0,046`) yalnızca `2` veya `3` döndürür; hiçbir kural bu değerle rastgele/anlamsız bir kelimeyi düzeltme adayı olarak seçemez.
   - Tek olası yan etki, ~2.175 yazım hatasından 1'inin `Bloom3` ile çakışıp `typedCount = 3 >= knownWord` nedeniyle `oneEdit` düzeltmesini atlamasıdır (yanlış alarm üretmez, yalnızca çok nadir kaçırma riski taşır).
   - `count = 2, 3` biçimlerinin `capitalShare` değeri saklanmaz (`0` döner). Ölçülen tüm setlerde (`dev`, `neon-v1`, `conv`) hiçbir etki görülmedi; ancak görülmemiş setlerde tam olarak 2 veya 3 kez geçen ve yüksek büyük-harf oranına sahip bir özel adın `typedCaps` karşılaştırmasında sınırda fark oluşma ihtimali sıfır değildir.
2. **`BALANCED` kipinde düşük sıklıklı bölme çiftleri:**
   - `bigramSplitMin = 20`, `CAREFUL` kipindeki bölme eşiğine (`log(20 + 1) - 0,5 = 2,54 >= 2,5`) bire bir uyar. `BALANCED` kipinde (`threshold.split = 2,0, cost = 0,4`) `11..19` aralığındaki çok nadir genel bölme çiftleri (ek/bağlaç dışındakiler) artık tetiklenmez; buna karşılık `JOIN_FIRST`/`JOIN_SECOND`, soru eki ve bilinen yanlış çiftleri `count >= 2`'ye kadar eksiksizdir.
3. **Vite derlemesinde `dist/assets/` içindeki yinelenen ORT `.wasm` dosyası:**
   - `onnxruntime-web/wasm` paketinin kendi `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)` ifadesi nedeniyle Vite, `dist/ort/` klasörüne ek olarak `dist/assets/` altına da bir `.wasm` kopyası koyuyor. Bu dosya `sw.js` içinde `ORT_FILES` olarak ayrıldığı ve dinamik `import()` arkasında kaldığı için **asla indirilmiyor**; ancak statik barındırma depo boyutunu (diskte) 15 MB büyütüyor.
4. **Ana paket (`index-*.js`) içinde `Corrector` + `TurkishMorphology` kopyası:**
   - `site/src/App.tsx` `loadAutr({ worker: true })` çağırsa da `pkg/src/index.ts` ana iş parçacığı yedeğini (`worker: false`) doğrudan dışa aktardığı için Vite motor kodunu hem `worker-*.js` (34 KB gzip) hem `index-*.js` (+20 KB gzip) içine paketliyor. Toplam 20 KB gzip etkiliyor; istenirse ileride `loadAutrInWorker` için ayrı bir alt giriş (`autr/client`) eklenerek ana paket ~20 KB daha küçültülebilir.
5. **Yazı tipleri (`@fontsource/instrument-serif` `.woff` yedeği):**
   - Modern tarayıcılar yalnızca `.woff2` indirir; ancak `sw.js` kabuk listesinde 4 eski `.woff` dosyası (58 KB) hâlâ önbelleğe alınıyor. Çekirdek toplamı zaten hedefin içinde olduğu için site tipografi CSS'ine dokunulmadı.
6. **Geliştirme/Dağıtım notu:**
   - `site/public/models/` içindeki ikili dosyalar `npm run build:models` ile her zaman `data/work/`, `data/rules/known.tsv` ve `data/morph/` kaynaklarından bire bir yeniden üretilebilir.
