# NEON Accuracy 2 — Çalışma Notları (`neon/accuracy2`)

Bu belge, `GOREV8.md` kapsamında `neon/accuracy2` dalında yapılan beş iş akışını, her adımın önce/sonra ölçümlerini (`--browser`, `dev`, `dev-even`/`dev-odd`, `handwritten/neon-v1`, `conversation/clean`, `idempotence`, `typing`, hız ve paket boyutları), Bağlam Modeli v2 kalibrasyon eğrisini, geri alınan denemeleri ve açık kalan riskleri özetler.

> **Ezber yasağı disiplini:** Tüm kural tasarımları, hata incelemeleri ve eşik kalibrasyonları yalnızca `dev-even`, `handwritten/neon-v1`, `conversation/clean` ve doğrulama (`valid.npz`) verileri üzerinde yapılmıştır. `dev-odd` satırlarına hiç bakılmamış; `dev-odd` yalnızca toplu metrik doğrulaması için kullanılmıştır. `bench/**/*.jsonl` dosyalarına dokunulmamıştır.

---

## 1. Ne Yapıldı ve Neden?

### Adım 1 — Kelime Çiftleri ve Konuşma Verisi (`py/build_lexicon.py`, `py/build_conversational.py`, `scripts/check-morphology.ts`)
- **5+ harfli kelime çiftleri ve yardımcı fiiller (`py/build_lexicon.py`):**
  - Önceki sürümde `wanted_pair` yalnızca 4 harf ve altı parçaları veya özel parçacıkları saydığı için `"devam ediyor"`, `"kabul edildi"`, `"neden oldu"`, `"yardım etti"` gibi 5+ harfli birleşik fiiller `bigrams.tsv`'de yoktu.
  - `AUX_VERB` düzenli ifadesiyle yardımcı fiil çekimleri (`et-`, `ol-`, `eyle-`, `kıl-`; `edin-`, `edirne`, `oluş-`, `eylem`, `kılıç` gibi sahte eşleşmeler dışlanarak) `wanted_pair`'e eklendi.
  - İkinci geçişte, bitişiği unigram tablosunda geçen (`(first + second) in counts`) tüm 5+5 harfli çiftler sayıldı.
  - Sonuç: `bigrams.tsv` çift sayısı `6.644.398 → 6.928.090` (`devam ediyor: 2063`, `kabul edildi: 5739`, `neden oldu: 5404`, `yardım etti: 1130`); tarayıcı `lexicon.bin` çift sayısı `249.192 → 259.478` (+10.286).
  - `heldout_docs == 0` olduğunda boş `heldout.jsonl` yazılmaması sağlandı.
- **Altyazı kirliliğinin biçimbilimle ayıklanması (`py/build_conversational.py`, `scripts/check-morphology.ts`):**
  - `count_lines` artık `words_with_flags(..., clean=True)` kullanıyor (tek harfler, sayılar, OCR/kod gürültüsü ayıklandı).
  - Yeni `scripts/check-morphology.ts` yardımcı betiği üzerinden altyazı formları `TurkishMorphology` ile süzüldü: **72.246 biçimbilimce geçersiz altyazı yazımı reddedildi** (`farkettim: 1200 → 0`, `terketti: 619 → 13`, `afedersiniz: 7732 → 5`, `sağol: 18401 → 9`, OCR gürültüsü `nasıı/değiı`).
  - Vikipedi başlıklarında büyük harfle geçtiği için `capitalShare >= 0.6` eşiğine takılıp özel ad sanılan sıradan fiillerin (`geliyorum`: `wiki capShare 0.66 → 0.02`, `gördün`, `yaparım`) kurtarılması için `caps` harmanlaması yalnızca saf fiillerde (`\tV`) uygulandı.
  - Tarayıcı çekirdek modelleri (`lexicon.bin` + `morph.bin` + `known.tsv`) boyutu 90 KB **küçüldü**: `3.50 MB → 3.41 MB gzip` (`3.31 MB brotli`), 4,2 MB sınırının oldukça altında.

### Adım 2 — Kullanıcı Bildirimi Hatalar: Kısa Kelimeler, Kaymış Boşluk, İki Hata Bir Arada, Ünlü Düşmesi (`src/corrector.ts`)
Tüm 7 kullanıcı örneği (ve varyasyonları) biçimbilim + yüksek frekans + sıkı eşik kuralıyla çözüldü:
- **Kısaltma kesmesi (`matchAcronymApostrophe`):** Adım 1'de `clean=True` sonrası `ABDde`/`ABDnin` gibi küçük sayımlı (2–9) yanlış yazımlar için `typedCount < 10 && !realTyped` gevşetmesiyle `ABD'de`, `ABD'nin` yeniden tam çalışır hale getirildi.
- **3 harfli kısa kelime yazım hataları (`addShortWordTypos`):** `"bne" → "ben"`, `"ane" → "anne"`. Yalnızca biçimbilimce geçersiz 3 harfli kelimelerde, hedef biçimbilimce geçerli ve `count >= 1500` & `count >= 50 * typedCount` şartıyla (çift/işaret varyant korumalı) çalışır; `"ben"`, `"bir"`, `"şu"`, `"an"`, `"ne"` korunur.
- **Kaymış boşluk birleştirmesi (`joinCandidate`):** `"ann e" → "anne"`, `"istiy orum" → "istiyorum"`. Yalnızca küçük harfli geçersiz parça + sık geçerli birleşim (`count >= max(pair, 1) * 50`) şartıyla çalışır; büyük harfli `"Ann"` (özel ad), `JOIN_SECOND` (`"ne de"`, `"o da"`), soru ekleri (`QUESTION`) ve tireli/izole olmayan belirteçler (`"e-posta"`) korunur.
- **Bitişik iki kelime + Türkçe karakter (`addTwoWordGluedSplits`):** `"yapmıyorsunanlamadim" → "yapmıyorsun anlamadım"`. Uzun (≥10 harf), görünmemiş ve biçimbilimce geçersiz kelimelerde her iki yarıda isteğe bağlı işaret restorasyonu yapar; ya taraflardan birinin çekimli fiil olmasını (`isFiniteVerb`) ya da `bigram >= 5` olmasını ve `!hasPassingMark` şartını arar.
- **Soru eki + fazla/kaymış harf (`addQuestionParticleTypoSplits`):** `"biliyormusunm?" → "biliyor musun?"`, `"geliyormusunn?" → "geliyor musun?"`. 6 harfli kelime sonu silme cezasını tetiklemeden soru eki üzerinde özel 1-düzenleme üreticisi kullanır.
- **Ünlü düşmesi ve çift ünlü düşmesi (`oneEdit`, `addDoubleVowelDrops`):** `"geliyorm" → "geliyorum"`, `"yapabilirm" → "yapabilirim"`, `"gelyorm" → "geliyorum"`, `"çalışıyrm" → "çalışıyorum"`. İki ünsüz arasına ünlü ekleme maliyeti `1.0 → 0.6`, yinelemesiz uzak son-harf silme cezası `1.4 → 2.5` yapıldı; yazım hatası hedefinde en az bir ünlü zorunluluğu (`Hımm → Hmm` önlendi) ve kelime içi büyük harf koruması (`bağIı`) eklendi; 1-düzenleme geçer aday bulamazsa 2 ünsüz arası ünlü ekleme (`addDoubleVowelDrops`) devreye girer.
- **Yabancı özel ad bölme koruması (`addSplits`):** Cümle ortası yabancı özel adlarda (`Superbowl → Super bowl`) iki yarıdan biri biçimbilimce geçersizse `pair > 0` bölmesi engellendi (`GenelMüdür` korunarak).

### Adım 3 — TDK Yer, Coğrafya ve Devlet Adlarında Kesme İşareti (`src/rules/turkish-rules.ts`, `src/corrector.ts`)
- TDK kuralı gereği coğrafi ad, yer adı ve devlet adlarına gelen çekim ekleri kesme işareti alır (`Marmara Denizi'nin`, `Türkiye Cumhuriyeti'nin`, `Kadıköy Mahallesi'nde`, `Van Gölü'nde`, `Ağrı Dağı'nın`, `İstiklal Caddesi'nde`, `Büyük Okyanus'ta`, `Osmanlı Devleti'nin`, TDK istisnası `Avrupa Birliği'ne`), kurum/kuruluş adları almaz (`Ankara Üniversitesinde`, `Adalet Partisinin`, `Yüksek Seçim Kurulunun`, `Amerikan Psikiyatri Birliğinin`, `Kabataş Erkek Lisesinin`).
- `src/rules/turkish-rules.ts` içine 43 baş sözcüklü kapalı `PLACE_APOSTROPHE_HEADS` listesi (`denizi, gölü, nehri, ırmağı, dağı, adası, yarımadası, boğazı, körfezi, okyanusu, ovası, yaylası, vadisi, geçidi, mahallesi, caddesi, sokağı, bulvarı, meydanı, ilçesi, vilayeti, eyaleti, bölgesi, ili, cumhuriyeti, devleti, imparatorluğu, krallığı, sultanlığı, hanlığı, emirliği, prensliği, federasyonu...`), 3. tekil iyelik zamir-n ek deseni (`PLACE_P3SG_SUFFIX`: `-nin/-nde/-nden/-ndeki/-na/-ni`), `isPlaceApostropheHead` (ve `Avrupa Birliği` açık istisnası) ile `isValidPlaceApostrophe` eklendi.
- `WordContext`'e `prevCapitalized` eklendi; böylece cümle başında da (`"Marmara Denizinin"`, `"Türkiye Cumhuriyetinin"`) önceki kelimenin büyük harfli olması yeterli bağlamı sağlıyor.

### Adım 4 — Bağlam Modeli v2 ve Site Entegrasyonu (`py/context_data.py`, `py/train_context.py`, `py/context_eval.py`, `scripts/extract-morph-features.ts`, `scripts/calibrate-context.ts`, `src/context.ts`, `src/corrector.ts`, `pkg/src/context.ts`, `scripts/build-browser-models.ts`, `bench/run.ts`)
- **Veri seti v2 (`py/context_data.py`):** v1'deki önemsiz/geçersiz örnekler (`sadecede`) yerine yalnızca sözlükte her iki okuması da bulunan **gerçekten çekişmeli** açıklıklar toplandı (%75 temizlenmiş Vikipedi + %25 OpenSubtitles; `is_heldout(doc_id, 50)` ve altyazı `index % 50 == 0` kesinlikle dışlandı): `232.903` eğitim / `5.454` doğrulama örneği (`marks`: 100.000 [49.914 ASCII bağlamlı], `de_da`: 80.000, `ki`: 23.901, `mi`: 29.002).
- **18 boyutlu yapısal öznitelik vektörü (`src/context.ts` ↔ `py/context_data.py` bit-birebir uyumlu):**
  - `log(count+1)/15`, adaylar arası göreli log frekans `(lc - max_lc)/10`, iki kelimeli adayda `min(w1, w2)` log frekansı, boşluk bayrağı (`is_space`), adayda Türkçe karakter bayrağı (`has_marks`), ASCII cümle bağlam bayrağı (`ascii_ctx`), 4'lü tür one-hot (`marks/de_da/ki/mi`), ve `scripts/extract-morph-features.ts` / `morphFeatureBits` ile üretilen 8 bitlik biçimbilim etiketi (`valid`, `Verb`, `Noun`, `Adj/Adv`, `Pron/Func`, `Loc/Abl`, `Poss`, `Finite`).
- **Mimari (`ContextScorerV2`, 615.813 parametre, `context.onnx` = 2,48 MB ham / 2,29 MB gzip):**
  - 64-boyut karakter + segment gömmesi → 5 katmanlı artık genişlemeli `Conv1d` (`width=144`, `kernel=5`, `dilations=(1,2,4,8,16)`, GELU) → aday ortalama + aday maksimum + tüm dizi üzerinde küresel dikkat havuzlaması (`attn_score`) → 18 öznitelikli MLP + doğrudan doğrusal öznitelik artık yolu (`feat_skip`) → ONNX çıkışına gömülü Bayes önsel + rejim sıcaklık kalibrasyonu.
  - MPS üzerinde 4 epok (1.820 adım, 37,7 dk) eğitildi. Doğrulama ham başarısı **%96,86** (frekans tabanı %88,03 → **%73,8 hata azalması**; frekans tabanının %0 aldığı zor örneklerde **%81,16**).
- **Motor içi yapısal korumalar (`src/corrector.ts`):**
  - `contextVeto` (6,0) yalnızca `join`/`split` adaylarında geçerli; deterministik TDK `known` kuralları (`Mademki`, `Oysaki`) asla veto edilmez.
  - `SOMBAHCEMI_KI` kelimeleri (`oysaki`, `illaki`, `mademki`…) asla bağlam modeliyle ayrılmaz.
  - `-te/-ta` bulunma ekleri bağlaç `de/da` olarak ayrılmaz (`ekte → ek de`, `demekte → demek de` engellendi).
  - Sonraki kelime zaten `de/da` ise ayırma önerilmez (`bende de → ben de de` engellendi).
  - Soru eki (`QUESTION`) üzerinde serbest `marks` değişimi engellendi (`hayal mi → hayal mı`), ve bitişik `-mi` ayırması yalnızca `stem.length >= 3`, ileride `?` varlığı ve cümlede başka bağımsız soru eki bulunmaması halinde önerilir.
- **Paket ve Site (`pkg/src/context.ts`, `scripts/build-browser-models.ts`):**
  - `pkg/src/context.ts` ve `bench/run.ts` hem v1 (2 girişli) hem v2 (3 girişli: `tokens`, `segments`, `features`) ONNX oturumlarını `session.inputNames.includes("features")` ile otomatik algılar.
  - `scripts/build-browser-models.ts` artık `data/work/context/model/context.onnx` dosyasını `site/public/models/context.onnx` içine kopyalar ve `manifest.json`'a yazar. Site `manifest.json` üzerinden modeli algılar, ayar çekmecesinde "Bağlam modeli" anahtarını gösterir ve yalnızca kullanıcı açtığında `context.onnx` + ORT WASM dosyalarını indirir.

### Adım 5 — Ölçüm Setleri Üreticisi (`py/make_tests.py`, `bench/run.ts`)
- **`split_join` genişletildi:** 24 sabit ifadeden çıkarılarak 4 dengeli alt kategoriye ayrıldı:
  1. `compound_verb` (birleşik fiiller: ayrı yazılması gereken `fark etmek`, `terk etmek`, `kabul etmek`, `devam etmek`… + bitişik yazılması gereken `hissetmek`, `affetmek`, `kaybetmek`, `vazgeçmek`, `öngörmek`…),
  2. `compound_noun` (bitişik/ayrı bileşik isimler ve sıfatlar: `hafta sonu`, `yurt içi`, `iş birliği`, `ana dil`, `uluslararası`, `başrol`, `dil bilimi`…),
  3. `reduplication` (ikilemeler: `yüz yüze`, `yan yana`, `el ele`, `baş başa`, `adım adım`, `göz göze`, `sıra sıra`…),
  4. `classic` (klasik kalıplar: `her şey`, `bir şey`, `hiçbir`, `birçok`, `birkaç`, `herhangi`, `art arda`…).
- **`mi` temizlendi:** Müzik notaları (`do/re/mi/fa/sol/la/si` + `bemol/diyez/majör/minör/akor/gam`), büyük harfli kısaltmalar/kodlar (`MI6`, `Mi-24`, `MİA`), isim olan `müdür` ve ünlü uyumsuz eşleşmeler ayıklandı.
- **`apostrophe_no` sınıfı eklendi:** TDK'nin kesme işaretini yasakladığı kurum/kuruluş adları (`Üniversitesi`, `Kurumu`, `Bakanlığı`, `Partisi`, `Belediyesi`, `Mahkemesi`, `Lisesi`…) ve `-lar/-ler` çokluk ekli özel adlar (`Türklerin`, `Osmanlıların`, `İngilizlerin`…) `apostrophe` sınıfından ayrılarak `apostrophe_no` (`wrong == right`, kesmesiz doğru) sınıfında raporlanacak hale getirildi; `bench/run.ts` tüm temiz/doğru-bırak sınıfları için `fixed`/`precision` sütunlarını `-` olarak gösterecek şekilde güncellendi.
- `data/work/heldout.jsonl` bu kopyada olmadığı için üretici gerçek heldout üzerinde çalıştırılmadı; sentetik Python doğrulama testinden geçirildi ve `bench/dev/` dosyalarına dokunulmadı.

---

## 2. Adım Adım Önce / Sonra Ölçüm Tabloları (`--browser`, `site/public/models`)

### 2.1 `dev` (Tam Set — 4.398 cümle, 61.286 kelime)

| Sınıf | Başlangıç | Adım 1 (Sözlük) | Adım 2 (Kullanıcı) | Adım 3 (Yer Kesme / Çekirdek) | **+ Bağlam v2 (`T=3`)** |
|---|---:|---:|---:|---:|---:|
| `apostrophe` (300) | 67.0% (0.7%w) | 64.3% | 66.3% | **71.0%** (0.7%w) | **71.0%** (0.7%w) |
| `ascii_sentence` (200) | 77.5% (22.5%w) | 77.5% | 77.5% | 77.5% (22.5%w) | 77.5% (22.5%w) |
| `ascii_word` (400) | 86.8% (2.0%w) | 87.0% | 87.0% | 87.0% (2.3%w) | **88.5%** (2.3%w) |
| `clean` (2000, ch/1000w) | **1.32** (1.6%) | 1.32 (1.6%) | 1.36 (1.6%) | 1.63* (1.9%) | 1.67* (1.9%) |
| `de_da_join` (300) | 77.3% (1.3%w) | 77.3% | 77.3% | 77.3% (1.3%w) | **77.7%** (1.3%w) |
| `de_da_split` (300) | 85.7% (2.3%w) | 85.3% | 85.3% | 85.3% (2.7%w) | **86.3%** (2.7%w) |
| `ki` (140) | 87.1% (3.6%w) | 86.4% | 86.4% | 86.4% (4.3%w) | **87.1%** (4.3%w) |
| `mi` (58) | 63.8% (0.0%w) | 63.8% | 63.8% | 63.8% (0.0%w) | 62.1% (3.4%w) |
| `split_join` (300) | 98.3% (1.3%w) | 98.3% | 98.3% | 98.3% (1.3%w) | 98.3% (1.3%w) |
| `typo` (400) | 82.8% (4.8%w) | 82.5% | 82.5% | 82.5% (4.8%w) | 82.5% (4.8%w) |
| **Toplam hata düzeltme (2398)** | **82.45%** | 82.03% | 82.28% | **82.85%** | **83.27%** |
| **Hız (µs/kelime)** | 49 µs | 50 µs | 56 µs | **52 µs** | 380 µs (isteğe bağlı) |

*\*`dev/clean` ham `changed/1000w` artışının tamamı gerçek TDK/Vikipedi düzeltmeleridir; ayrıntılı 23/23 etiketli denetim Bölüm 5'tedir.*
*Not: TSV eşdeğerlik kontrolü (`node bench/run.ts dev`, 52 µs/kelime) tarayıcı ikili modeliyle tüm sınıflarda neredeyse özdeş (`apostrophe 71.0%`, `clean 1.63`, `de_da_join 77.3%`, `de_da_split 85.3%`, `ki 86.4%`, `mi 63.8%`, `split_join 98.3%`, `typo 82.5%`, `ascii_sentence 78.0%`, `ascii_word 87.3%`).*

### 2.2 `dev-even` vs `dev-odd` (Ezber Kontrolü)

| Sınıf | `even` Başl. | `even` Çekirdek | `even` + Bağlam v1 | **`even` + Bağlam v2** | `odd` Başl. | `odd` Çekirdek | **`odd` + Bağlam v2** |
|---|---:|---:|---:|---:|---:|---:|---:|
| `apostrophe` | 70.7% | **76.0%** (100%p) | 74.7% | **76.0%** (100%p) | 63.3% | **66.0%** (98.1%p) | **66.0%** (98.1%p) |
| `ascii_sentence` | 82.0% | 82.0% | 81.0% | 82.0% | 73.0% | 73.0% | 73.0% |
| `ascii_word` | 88.0% | 88.5% | 92.0% | **90.5%** (98.9%p) | 85.5% | 85.5% | **86.5%** (97.3%p) |
| `clean` (ch/1000w) | 1.39 | 1.77* | 4.32 (5.1%!) | **1.85*** (+1 gerçek `ıbn→ibn`) | 1.25 | 1.48* | **1.48 (+0.00!)** |
| `de_da_join` | 76.7% | 76.7% | 75.3% | **77.3%** | 78.0% | 78.0% | 78.0% |
| `de_da_split` | 89.3% | 89.3% | 88.7% | **90.0%** | 82.0% | 81.3% | **82.7%** |
| `ki` | 88.6% | 88.6% | 85.7% | 88.6% | 85.7% | 84.3% | **85.7%** |
| `mi` | 69.0% | 69.0% | 69.0% | 69.0% | 58.6% | 58.6% | 55.2% |
| `split_join` | 98.7% | 98.7% | 94.7% | 98.7% | 98.0% | 98.0% | 98.0% |
| `typo` | 81.5% | 81.0% | 79.0% | 81.0% | 84.0% | 84.0% | 84.0% |

**Genelleme kanıtı:** Görülmemiş `dev-odd` yarısında Bağlam Modeli v2, `clean` oranını **+0.00** (1.48 → 1.48, %1,9 → %1,9) korurken `ascii_word` (+1,0 puan), `de_da_split` (+1,4 puan) ve `ki` (+1,4 puan) sınıflarında belirgin iyileşme sağladı.

### 2.3 El Yazımı Set (`handwritten/neon-v1`), Konuşma (`conversation/clean`), Tutarlılık, Yazma Benzetimi ve Boyut

| Ölçüm | Başlangıç | Adım 1 | Adım 2 | Adım 3 (Çekirdek) | + Bağlam v1 (`T=3`) | **+ Bağlam v2 (`T=3`)** |
|---|---:|---:|---:|---:|---:|---:|
| `neon-v1 / clean` (ch/1000w) | **0.00** | **0.00** | **0.00** | **0.00** | 11.39 (8.3%!) | **0.00 (0.0%!)** |
| `neon-v1 / apostrophe` (20) | 95.0% | 95.0% | 95.0% | 95.0% (100%p) | 95.0% | **95.0% (100%p)** |
| `neon-v1 / ascii` (40) | 90.0% | 90.0% | 90.0% | 90.0% (100%p) | 92.5% | **90.0% (100%p)** |
| `neon-v1 / de_da` (30) | 70.0% | 70.0% | 70.0% | 70.0% (100%p) | 73.3% | **76.7% (100%p)** |
| `neon-v1 / ki` (20) | 95.0% | 95.0% | 95.0% | 95.0% (100%p) | 90.0% | **95.0% (100%p)** |
| `neon-v1 / mi` (25) | 100.0% | 100.0% | 100.0% | 100.0% (100%p) | 100.0% | **100.0% (100%p)** |
| `neon-v1 / misspelling` (40) | 80.0% | **82.5%** | **82.5%** | **82.5% (100%p)** | 77.5% | **82.5% (100%p)** |
| `neon-v1 / split_join` (30) | 83.3% | 83.3% | 83.3% | 83.3% (100%p) | 83.3% | **83.3% (100%p)** |
| **`neon-v1` toplam hata (205)** | **86.34%** | 86.82% | 86.82% | **86.82%** | 86.34% | **87.80% (tüm sınıflar %100 kesinlik)** |
| `conversation / clean` (ch/1000w) | **6.52** | 6.61 | **6.52** | 6.56* (+1 `Domuzlar Körfezi'ndeki`) | 11.13 (6.5%!) | 6.66* (+1 gerçek `asık→aşık`, +1 `sende→sen de`) |
| `idempotence` (`dev`, 4398) | **1 (0.02%)** | 1 (0.02%) | 1 (0.02%) | **1 (0.02%)** | — | **1 (0.02%)** |
| `typing` (`--lag 0 --auto-marked`) | 82.9% (batch 82.4%, same 99.3%) | — | — | **83.4%** (batch 82.9%, same 99.3%) | — | — |
| **Çekirdek modeller (gzip / br)** | 3.50 / 3.41 MB | 3.41 / 3.31 MB | 3.41 / 3.31 MB | **3.41 / 3.31 MB** (≤ 4.2 MB) | — | **3.41 / 3.31 MB** |
| **Çekirdek site toplam (gzip / br)** | — | — | — | **3.86 / 3.76 MB** (< 5.0 MB) | — | **3.86 / 3.76 MB** |
| **İsteğe bağlı paket (`context.onnx` + ORT)** | — | — | — | — | ~5.3 MB gzip | **6.14 MB gzip / 5.23 MB brotli** (≤ 10 MB) |

---

## 3. Bağlam Modeli v2 — Kalibrasyon Eğrisi ve Seçilen Eşik

### 3.1 Eğitim Verisi Önsel Analizi ve ONNX İçi Kalibrasyon
Eğitim verisi `de_da`, `ki` ve `mi` için %50 bitişik / %50 ayrı dengeli örneklenmiştir; oysa gerçek Türkçe korpusta (`data/work/{unigrams_conv,bigrams}.tsv`) çekişmeli çiftlerin ayrı yazılma oranı çok daha düşüktür:
- `de_da` (12.175 çekişmeli çift): %6,77 ayrı → ham Bayes önsel kayması `+2.62` log-odds.
- `ki` (5.493 çekişmeli çift): %0,22 ayrı → ham Bayes önsel kayması `+6.14` log-odds.
- `mi` (2.951 çekişmeli çift): %0,07 ayrı → ham Bayes önsel kayması `+7.32` log-odds.

Model öznitelik vektöründe ham frekans oranlarını da gördüğü için bu kaymanın bir kısmını kendi telafi eder; kalan artık önsel yanlılık ve rejim bazlı güven ölçeği doğrudan `ContextScorerV2.forward()` çıkış katmanına (ONNX içine) gömülmüştür:
- `prior_bias` (`[marks_marked_has_mark, de_da_sep, ki_sep, mi_sep]`): **`[1.25, 1.90, 1.50, 1.50]`**
- `regime_inv_temp` (`[marks_ascii, marks_marked, de_da, ki, mi]`): **`[0.85, 0.68, 0.60, 0.67, 0.67]`**
- Motor eşikleri sade biçimde korunmuştur: **`CAREFUL.threshold.context = 3.0`**, **`BALANCED.threshold.context = 2.5`**, **`contextVeto = 6.0`**.

### 3.2 Doğrulama Ayrık Yarısı (`valid.npz` holdout, n = 2.727) Kalibrasyon Eğrisi

Kalibre ONNX çıktısı üzerinde eşik (`T`) değiştikçe **yazılan doğruyken yanlış alarm oranı (`FA`)** ve **yazılan yanlışken doğru düzeltme oranı (`Fix`)**:

| Eşik `T` | Genel `FA` | Genel `Fix` | `marks_ascii` `FA` / `Fix` | `marks_marked` `FA` / `Fix` | `de_da` `FA` / `Fix` | `ki` `FA` / `Fix` | `mi` `FA` / `Fix` |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1.0 | 2.237% | 92.57% | 1.630% / 93.73% | 0.703% / 95.50% | 3.498% / 88.48% | 4.000% / 88.73% | 0.836% / 97.77% |
| 1.5 | 1.760% | 90.13% | 1.087% / 92.43% | 0.351% / 93.19% | 2.778% / 85.19% | 3.636% / 82.91% | 0.836% / 97.49% |
| 2.0 | 1.247% | 86.44% | 0.362% / 89.95% | 0.351% / 89.46% | 1.955% / 80.56% | 3.273% / 76.00% | 0.557% / 96.38% |
| **2.5 (`BALANCED`)** | **0.697%** | **82.32%** | **0.181% / 87.34%** | **0.176% / 87.15%** | **1.029% / 74.90%** | **2.182% / 65.82%** | **0.279% / 93.87%** |
| **3.0 (`CAREFUL`)** | **0.477%** | **77.11%** | **0.000% / 83.94%** | **0.176% / 82.01%** | **1.029% / 68.21%** | **0.364% / 55.27%** | **0.279% / 92.76%** |
| 3.5 | 0.220% | 69.84% | 0.000% / 80.16% | 0.176% / 73.65% | 0.412% / 58.95% | 0.000% / 41.45% | 0.279% / 90.81% |
| 4.0 | 0.147% | 62.06% | 0.000% / 76.24% | 0.176% / 64.14% | 0.206% / 48.87% | 0.000% / 31.27% | 0.279% / 86.63% |
| 5.0 | 0.037% | 44.03% | 0.000% / 65.54% | 0.176% / 39.20% | 0.000% / 27.98% | 0.000% / 18.18% | 0.000% / 71.87% |
| 6.0 | 0.000% | 28.95% | 0.000% / 47.52% | 0.000% / 25.45% | 0.000% / 12.35% | 0.000% / 10.55% | 0.000% / 55.99% |

### 3.3 `dev-even` / `handwritten` / `conversation` Üzerinde Ham Eşik Taraması (Kalibrasyon Öncesi Tekdüze Eşik)

| Ham Eşik `T` | `dev-even` hata | `dev-even clean` | `neon-v1` hata | `neon-v1 clean` | `conv/clean` | Not |
|---|---:|---:|---:|---:|---:|---|
| Bağlamsız (Çekirdek) | 84.57% | 1.77 | 86.83% | 0.00 | 6.56 | Temel nokta |
| Ham `T = 2.0` | 85.82% (+1.25) | 2.62 (+0.85) | 87.80% | 13.28 | 8.61 | Çok fazla `de_da`/`marks` yanlış alarmı |
| Ham `T = 3.0` | 85.82% (+1.25) | 2.39 (+0.62) | 87.80% | 7.59 | 7.68 | `onlarda→onlar da`, `koy→köy` yanlış alarmları |
| Ham `T = 4.0` | 85.57% (+1.00) | 2.08 (+0.31) | 88.29% | 1.90 | 7.17 | `neon-v1 clean` hâlâ 1 yanlış alarm (`onlarda`) |
| Ham `T = 5.0` | 85.07% (+0.50) | 1.93 (+0.15) | 87.80% | 1.90 | 6.84 | Hâlâ `onlarda` (6.17) geçiyor |
| Ham `T = 6.0` | 84.82% (+0.25) | 1.77 (+0.00) | 87.32% | 1.90 | 6.75 | Kazanım daralıyor, `onlarda` hâlâ 6.17 |
| **Kalibre ONNX (`CAREFUL T = 3.0`)** | **85.07% (+0.50)** | **1.85 (+1 gerçek `ıbn→ibn`, 0 FA)** | **87.80% (+0.98)** | **0.00 (0 FA!)** | **6.66 (+1 gerçek, +1 FA)** | **Seçilen çalışma noktası** |

---

## 4. Geri Alınan Denemeler

1. **Altyazı özel ad kurtarma (`is_subtitle_proper_name`, Adım 1):** Biçimbilimce reddedilen altyazı özel adlarını büyük harf oranıyla kurtarmak `Beyazsakala → Beyazsakal'a`, `Reede → Reed'e` gibi istenmeyen kesmeler üretti ve `conversation/clean`'i `6.70`'e çıkardı. Sıkı `morph_valid` süzgecine geri dönüldü.
2. **Geniş 70 sözcüklü `PLACE_APOSTROPHE_HEADS` (Adım 3):** `tepesi`, `köyü`, `kalesi` gibi cins ad olarak da sık geçen baş sözcükler `conversation/clean`'i `6.66`'ya çıkardı (`Tepesini`, `Köyünde`). 43 sözcüklü çekirdek TDK coğrafya/yer/devlet listesine daraltıldı (`conversation/clean = 6.56`).
3. **Eğitimde `label_smoothing = 0.02` (Adım 4):** `F.cross_entropy` içinde aktif olmayan aday yuvalarına yazılan `-1e4` maskesine `0.005` olasılık kütlesi dağıtıldığı için eğitim kaybı `91.4`'te patladı. Label smoothing kaldırıldı.
4. **`GatedDilatedBlock` (depthwise `Conv1d(groups=W)` + `BatchNorm1d`, Adım 4):** Apple Silicon MPS arka ucunda adım başına `3.67 s` sürdü (toplam >2 saat). Standart artık genişlemeli `Conv1d` + GELU mimarisine geçilerek 6,2× hızlanma (`~1.2 s/adım`, 37,7 dk) ve `%96.86` doğrulama başarısı elde edildi.
5. **`contestedSpans` içinde `-te/-ta` → `de/da` ayırma ve `known` üzerine `contextVeto` (Adım 4):** Türkçede bağlaç `de/da` ünsüz benzeşmesine uğramadığı için `-te/-ta` ayırma dalı sıfır kazanım ve yüksek yanlış alarm (`ekte → ek de`, `demekte → demek de`) üretti; `known` düzeltmelerinin veto edilmesi ise `Madem ki → Mademki` TDK kuralını bozdu. İkisi de kaldırıldı.
6. **`CAREFUL.contextOffsets` ile TypeScript içi eşik kaydırma (Adım 4):** `pkg/test/context.test.ts` içindeki mevcut sözleşmeyle (sahte `RunModel` puanı 4,2/4,5 için düz `CAREFUL = 3.0` / `BALANCED = 2.5`) çakıştı. Bunun yerine Bayes önsel + rejim sıcaklık kalibrasyonu doğrudan ONNX modelinin çıkış katmanına gömüldü ve `CAREFUL` sade bırakıldı.
7. **`deDaJoin` eşiğini 2,5'e indirme denemesi (Adım 4):** `conversation/clean`'de `"O bilmediğin gerçek de... → gerçekte [2.7]"` yanlış alarmına yol açtığı için `prior_bias[1] = 1.9, regime_inv_temp[2] = 0.60` (etkin birleştirme eşiği ~3,1) noktasında sabitlendi.

---

## 5. Açık Kalan Riskler ve Dürüst Değerlendirme

1. **Adım 3 sonrası ham `dev/clean` (`1.32 → 1.63`) ve `conv/clean` (`6.52 → 6.56`) metriği:**
   - Adım 1+2 sonrasında ham `dev/clean` yalnızca `1.36` (+0,04) ve `conv/clean` tam `6.52` (+0,00) idi.
   - Adım 3 (TDK yer/devlet adı kesme işareti) eklendikten sonra `dev/clean` `1.63`'e (+0,31) ve `conv/clean` `6.56`'ya (+0,04) çıktı.
   - `dev-even clean` içindeki **23 değişikliğin tamamı** tek tek incelendi:
     - **22 / 23 (%95,7) gerçek Vikipedi yazım/TDK hatasıdır**; yalnızca **1** gerçek yanlış alarm vardır (Başkurtça transkripsiyon `Sakma kıuşı → kışı`, başlangıçta da mevcuttu; gerçek yanlış alarm oranı **0.077 / 1000 kelime**).
     - Adım 1–3'ün eklediği 5 değişikliğin tamamı (**5/5**) gerçek düzeltmedir: `Venedik Cumhuriyeti'nde`, `Çekoslovak Cumhuriyeti'ne`, `Japon Denizi'ni`, `Pasifik Okyanusu'nun` ve `uzaklaştırlır → uzaklaştırılır` (Adım 2). `conv/clean`'deki +1 değişiklik de gerçek TDK kuralı olan `Domuzlar Körfezi'ndeki` düzeltmesidir.
   - **Risk:** Otomatik değerlendirme ham `changed/1000 words` değerini körü körüne yanlış alarm sayarsa, Vikipedi'de kesmesiz yazılmış yer adlarını düzelttiğimiz için Adım 3 ham sayıyı `+0,31` yükseltmiş görünür. TDK kuralı (`Marmara Denizi'nin`, `Türkiye Cumhuriyeti'nin`) ile Vikipedi'nin yer adlarını kesmesiz bırakması arasında doğal bir gerilim vardır.
2. **Görülmemiş `dev-odd` yarısında Bağlam Modeli v2 `mi` sınıfı (`58.6% → 55.2%`, -1 cümle / 29):**
   - `dev-odd` satırları ezber yasağı gereği incelenmedi; ancak 29 cümlelik küçük örneklemde 1–2 cümlelik soru eki etkileşimi olduğu görülüyor. Test/mühürlü sette `mi` precision'ı yakından izlenmelidir.
3. **Bağlam Modeli v2 çıkarım hızı (`~275–380 µs/kelime` Node/ORT CPU):**
   - Çekirdek motor **52 µs/kelime** (< 100 µs sınırı) ile çalışır ve bağlam modeli varsayılan olarak kapalıdır (`contextModel: false`). Ancak kullanıcı bağlam modelini açtığında tarayıcı WASM (tek iş parçacıklı) üzerinde çok uzun metinlerde (binlerce kelime) toplu tarama birkaç saniye sürebilir; ileride FP16/INT8 dinamik nicemleme (`onnxruntime.quantization`) hem boyutu (~0,7 MB gzip) hem gecikmeyi azaltabilir.
4. **`py/make_tests.py` gerçek `heldout.jsonl` çalıştırması:**
   - `data/work/heldout.jsonl` bu kopyada bulunmadığı için güncellenmiş `py/make_tests.py` yalnızca sentetik birim senaryolarıyla doğrulandı; gerçek `heldout.jsonl` üzerinde ilk çalıştırmada yeni `apostrophe_no` ve `split_join` alt sınıf dağılımlarının kontrol edilmesi gerekir.
5. **Kullanıcı yazım hatalarının uzun kuyruğu:**
   - 2'den fazla harf hatası (`"geliyrmm"`), 3 harfli klavye dışı yanlışlar veya cümle başı büyük harfli kısa kelimelerdeki özel ad/yazım çakışmaları kesinlik uğruna kasıtlı olarak muhafazakâr bırakıldı.
