# NEON Context 3 — Çalışma Notları (`neon/context3`)

Bu belge, `GOREV9.md` kapsamında `neon/context3` dalında geliştirilen **Bağlam Modeli v3**'ü (iki aşamalı ön-eğitimli Türkçe alt-sözcük Transformer + INT8 nicemleme + bağlamsal yazım hatası aday seçimi + `bench/typing.ts` arka plan ara geçişi) tüm tasarım kararları, veri/mimari ayrıntıları, önce/sonra ölçüm tabloları, kalibrasyon eğrisi, geri alınan denemeler ve açık riskleriyle özetler.

> **Ezber yasağı ve veri ayrımı disiplini:**
> - Tüm hata incelemeleri, eşik taramaları ve kalibrasyonlar **yalnızca** `dev --half even`, `bench/synth/tune.jsonl --id-half even` (`mesaj-002`, `mesaj-004`…), `bench/handwritten/neon-v1.jsonl`, `bench/conversation/clean.jsonl` ve eğitim dışı doğrulama (`valid.npz`) üzerinde yapılmıştır.
> - `dev --half odd` ve `bench/synth/tune.jsonl --id-half odd` satırlarına **hiç bakılmamış**, yalnızca toplu doğrulama metrikleri çalıştırılmıştır.
> - Ön-eğitim (40M belirteç) ve Aşama 2 veri üretiminde Vikipedi heldout belgeleri (`is_heldout(doc_id, 50)`) ile OpenSubtitles heldout satırları (`idx % 50 == 0`) kesinlikle dışlanmıştır.
> - `bench/**/*.jsonl`, `site/src/*.tsx` ve `site/src/autocorrectExtension.ts` dosyalarına dokunulmamıştır. Çekirdek motorun bağlamsız (`correct()`) çıktısı değişmemiştir.

---

## 1. Ne Yapıldı ve Neden?

### 1.1 Bağlam Modeli v2 Neden Yetersizdi?
Önceki model (`ContextScorerV2`, 615K parametre FP32 karakter-CNN, 2,29 MB gzip, 271–385 µs/kelime):
1. **Anlamsal kapasite yoktu:** Yalnızca 232K denetimli örnek üzerinde sıfırdan eğitilmiş karakter evrişimiydi; gerçek Türkçe sözcük/ek/fiil birlikteliklerini bilmiyordu.
2. **Türkçe SOV sağ bağlamı kesiliyordu:** Sağ pencere yalnızca 40 karakterdi (`LEFT=80, RIGHT=40`); Türkçede cümle sonundaki yüklemi ("... `yllar` geçse de **unutmam**" vs "... `yllar` kar yüzünden **kapandı**") çoğu zaman göremiyordu.
3. **Yazım hatası adaylarını hiç görmüyordu:** Yalnızca `marks`, `de_da`, `ki`, `mi` için eğitilmişti; `oneEdit` / yazım hatası yolundan gelen çekişmeli adaylar (`hber → her/haber`, `adık → adı/aldık`, `oluyr → olur/oluyor`, `ağldı → aldı/ağladı`, `klacağımızı → kalacağımızı/olacağımızı`, `yllar → yıllar/yollar`) arasında karar veremiyordu.
4. **Yavaş ve ağırdı:** FP32 CNN düğümleri Node/ORT CPU'da `dev`'de ~271–380 µs/kelime, `conversation/clean`'de 308 µs/kelime harcıyor ve `conversation/clean` yanlış alarmını `+0.09` artırıyordu.

### 1.2 Bağlam Modeli v3'te Ne Değişti?
1. **Türkçe Alt-Sözcük Dağarcığı (`py/build_tokenizer.py` → `src/context-vocab.ts`, 8.192 parça):**
   - %50 Vikipedi (`data/work/unigrams.tsv`) + %50 OpenSubtitles (`data/work/subtitle_counts.tsv`) dengeli (kuvvet = 0,82) BPE/WordPiece açgözlü en uzun eşleşme sözlüğü.
   - Özel kimlikler: `0=<pad>, 1=<unk>, 2=<cls>, 3=<mask>, 4=<cap>, 5=<allcap>, 6=<num>`. Sözcük başı `▁` öneki; kesme işaretli ekler devam parçası olarak kodlanır.
   - Python (`SubwordTokenizer.encode`) ↔ TypeScript (`encodeSubwords` in `src/context.ts`) **8/8 bit-birebir** doğrulandı.
   - 64 alt-sözcüklük dizi (`[CLS] + left(≤24) + cand(≤8) + right(≤20)`), karakter-CNN'in aksine **sağda 150+ karakter** (çoğu zaman cümlenin son yüklemine kadar) görür.
2. **İki Aşamalı Eğitimli Kompakt Transformer + INT8 Nicemleme (`py/context_arch.py`, `py/pretrain_context.py`, `py/train_context_v3.py`):**
   - **Aşama 1 (Öz-denetimli MLM + RTD ön-eğitim):** 40M heldout dışı Türkçe belirteç üzerinde 5 katmanlı Transformer omurgası eğitilerek gerçek Türkçe sözdizimi ve anlam bilgisi kazandırıldı (`ppl = 79.87`, `rtd_recall = 83.5%`).
   - **Aşama 2 (Çok-görevli aday puanlama):** Gerçek tarayıcı `Corrector.typoCandidatesFor` motorundan üretilmiş 200K yazım hatası + 251K `marks/de_da/ki/mi` örneği üzerinde ince-ayar yapıldı.
   - **Saf-bağlam zorlaması (kısayol önleme):** Ana başlık (`ctx_head`) **sıfır skaler öznitelikle** yalnızca Transformer bağlam havuzlamasından puan üretir ve ayrı yardımcı çapraz-entropi kaybıyla (`+ 0.8 × CE(ctx_only)`) + %45 öznitelik dropout'uyla eğitilir; böylece model frekans/edit kısayollarına çökmeden gerçekten cümleye bakmak zorunda kalır (`ctx_only_all = %90.62`).
   - **Satır-başına INT8 gömme + dinamik INT8 MatMul:** 2,78M parametre (v2'nin **4,5×**'i) yalnızca **2,51 MB gzip** (`≤ 3,0 MB`) tutar ve Node/ORT CPU'da **141–247 µs/kelime** (v2'den ~%40–54 daha hızlı, `< 300 µs` sınırının belirgin altında) çalışır.
3. **Motor Bağlantısı ve Yazım Hatası Aday Seçimi (`src/corrector.ts`, `src/context.ts`, `pkg/src/context.ts`):**
   - Çekirdek `correct()` çıktısı **hiç değişmedi** (yalnızca dahili `Candidate` yapısına isteğe bağlı `slipCost` eklendi).
   - `correctAsync()` artık üç yeni yazım hatası karar kipini destekler:
     - **T2 Çekişmeli Düzeltme Geçersiz Kılma (`override`):** Çekirdek motor bir yazım hatasını (`fix.kind === "typo"`; **asla `marks` değil**) birden çok geçerli aday arasından frekansla seçtiyse (ör. `hber → her`, `adık → adı`, `ağldı → aldı`), bağlam modeli tüm adayları + yazılanı cümle içinde puanlar ve fark `≥ contextTypoOverride (1.2)` ise doğru adayı (`haber`, `aldık`, `ağladı`) seçer.
     - **T1 Belirsiz Beraberlik Çözme (`ambiguous`):** Çekirdek motor 2+ yakın aday arasında kararsız kalıp hiç dokunmadıysa (`klacağımızı → kalacağımızı/olacağımızı`, `yllar → yıllar/yollar`, `oluyr → olur/oluyor`), en iyi aday ikinciyi `≥ contextTypoAmbigGap (1.25)` ve yazılanı `≥ contextTypoAmbigVsTyped (1.5)` puanla geçerse düzeltir.
     - **T3 Eşik Altı Kurtarma (`rescue`):** Geçersiz bir kelimenin adayı çekirdek eşiğinin biraz altında kaldıysa, bağlam modeli yazılanı `≥ contextTypoRescue (2.5)` puanla geçiyorsa kurtarır.
   - **Çekirdekçe onarılmış çevre bağlamı:** `correctAsync`, Transformer'a sol/sağ pencereyi keserken hedef dışındaki emin çekirdek düzeltmelerini uygular; bu sayede `ascii_sentence` (tüm cümle ASCII yazılmış) ve `mixed` (çoklu yazım hatalı) cümlelerde model bozuk değil temiz Türkçe bağlam görür (`ascii_sentence` `+3.5–4.0` puan kazandı).
   - **`priorTypoOriginals` desteği:** Yazma benzetimindeki veya editördeki arka plan ara geçişinde çekirdeğin az önce değiştirdiği kelimenin orijinal yazımı (`hber`) korunarak tam cümle bağlamıyla (`haber`) yeniden değerlendirilebilmesi sağlandı.
   - **Yapısal düzeltmeler (yalnızca `--context` yolu):**
     - `contestedSpans` içindeki `SOMBAHCEMI_KI.has(word)` hatası düzeltildi (`SOMBAHCEMI_KI` gövde kümesi olduğu için `Mademki`/`illaki` ayrılıyordu → `FIXED_KI_WORDS` ve `!SOMBAHCEMI_KI.has(stem)` koruması eklendi).
     - Dolaylı soru cümlelerinde (`... gelecek mi bilmiyorum`) `?` olmadan da `mi` adayları üretilebilir hale getirildi (kalibre eşikte sıfır temiz yanlış alarm).
   - **Tarayıcı/Paket uyumu (`pkg/src/context.ts`):** `session.inputNames.includes("subwords")` ile v3 oturumunu otomatik algılar; v2/v1 ve mevcut tüm sahte `RunModel` testleriyle %100 geriye dönük uyumludur. `site/public/models/context.onnx` üzerinde gerçek `onnxruntime-web/wasm` ile uçtan uca doğrulandı.
4. **Yazma Benzetimi Arka Plan Ara Geçişi (`bench/typing.ts`):**
   - `--context <onnx>`, `--settle-override`, `--half` ve `--id-half` seçenekleri eklendi.
   - Her kelime bitiminde bugünkü gibi çekirdek motor (canlı yazım) çalışır; cümle sonunda yazmaya ara verilmiş gibi (`--settle-add`) bağlam modeli tüm cümleyi tarar: önceden bağlam modelinin değiştirmediği kelimeleri düzeltebilir, çekirdeğin yazdığı `typo` düzeltmelerini `priorTypoOriginals` üzerinden yalnızca yüksek güven eşiğinde (`--settle-override`, varsayılan `1.2` / `marks` dokunulmaz) güncelleyebilir.

---

## 2. Mimari ve Veri Özeti

### 2.1 Model Mimarisi (`py/context_arch.py`)
| Bileşen | v2 (`ContextScorerV2`) | **v3 (`ContextScorerV3`)** |
|---|---|---|
| Giriş temsili | 144 karakter (`LEFT=80, CAND=24, RIGHT=40`) | **64 alt-sözcük** (`[CLS] + LEFT≤24 + CAND≤8 + RIGHT≤20`, ~150+ kar. sağ) |
| Sözlük | 42 karakter | **8.192 Türkçe alt-sözcük** (%50 Wiki + %50 OpenSubs) |
| Gömme | 64-boyut FP32 | **96-boyut ayrıştırılmış → 192 projeksiyon (satır-başına INT8)** |
| Omurga | 5 katman genişlemeli `Conv1d(144, k=5)` | **5 katman Pre-LN Transformer** (`D=192, H=6, FFN=512, GELU`) |
| Havuzlama | `cand_mean + cand_max + global_attn` | **`cand_mean + cand_max + left_edge + right_edge + ctx_attn`** |
| Puanlama başlığı | Tek 18-öznitelik MLP + `feat_skip` | **Birincil saf-bağlam `ctx_head` (0 öznitelik) + düzenli 26-öznitelik artık MLP + `feat_skip`** |
| ONNX içi kalibrasyon | `prior_bias[4]`, `regime_inv_temp[5]` | **`temperature=1.02`, `prior_bias[5]`, `regime_inv_temp[6]`** |
| Toplam parametre | 615.813 (FP32) | **2.779.678 (4,5×; gömme + MatMul INT8)** |
| ONNX boyutu (ham / gzip / br) | 2,48 MB / 2,29 MB / — | **3,02 MB / 2,51 MB (`2.509.215 B`) / 2,47 MB** (`≤ 3,0 MB` gzip) |
| Nicemleme sapması (`FP32 ↔ INT8`) | — | **`mean_abs_diff = 0.0454`, `max_abs_diff = 0.2956`**, 0 doğruluk kaybı |

### 2.2 26 Boyutlu Öznitelik Vektörü (`src/context.ts` ↔ `py/context_data_v3.py`)
- **`0..17` (v2 ile birebir aynı):** `log(count+1)/15`, göreli log frekans `(lc - max_lc)/10`, iki kelimeli `min_lc/15`, `is_space`, `has_marks`, `ascii_ctx`, 4 tür biti (`marks, de_da, ki, mi`), 8 biçimbilim biti (`valid, Verb, Noun, Adj/Adv, Pron/Func, Loc/Abl, Poss, Finite`).
- **`18..25` (yeni yazım hatası öznitelikleri):**
  - `18`: `is_typo` (tür bayrağı)
  - `19`: `is_typed` (aday yazılan kelimenin kendisi mi)
  - `20`: `core_m / 6` (çekirdek motor marjı, kırpılmış `[-1, 2]`)
  - `21`: `slip_cost / 3` (klavye / düzenleme maliyeti)
  - `22`: `edit_is_insert` (`len(cand) > len(typed)`: harf atlama onarımı)
  - `23`: `edit_is_delete` (`len(cand) < len(typed)`: fazla tuş silme onarımı)
  - `24`: `edit_is_sub_or_trans` (`len(cand) == len(typed)` ve `cand != typed`: komşu tuş / ünlü / yer değiştirme)
  - `25`: `bigram_boost / 4` (çekirdeğin sol+sağ ikili kelime desteği)

### 2.3 Eğitim Verisi ve Aşamalar
1. **Aşama 1 — Ön-Eğitim (`py/pretrain_context.py`, 37,7 dk MPS):**
   - `22.000.763` Vikipedi + `18.000.001` OpenSubtitles belirteci (`634.932` eğitim, `2.029` doğrulama × 64 blok; %10 ASCII-soyulmuş paragraf; heldout kesinlikle dışlandı).
   - 4.000 adım (`batch=256`, `65,5M` görülen belirteç), MLM (%15 maske) + RTD (%20 bozulmuş belirteç algılama).
   - Doğrulama ilerlemesi: adım 1000 `ppl=233.64 (rtd 73.6%)` → adım 2000 `ppl=116.96 (79.9%)` → adım 3000 `ppl=88.19 (84.3%)` → adım 4000 **`mlm_loss=4.380, ppl=79.87, rtd_recall=83.5%`**.
2. **Aşama 2 — Çok-Görevli Veri (`py/context_data_v3.py` + `scripts/extract-typo-candidates.ts`, 17,5 dk):**
   - Bozulma dağılımı (`corrupt_word`): %44 harf atlama (`omission`), %18 fazla tuş (`extra-key insertion`), %14 komşu tuş (`adjacent_key`), %11 yer değiştirme (`transposition`), %9 ünlü değişimi (`vowel_swap`), %4 çift harf atlama (`double_omission`).
   - Gerçek `Corrector` aday üreticisi (Node alt süreci) ile **450.936 eğitim** ve **13.806 doğrulama** örneği üretildi:
     - `marks`: 95.000 eğitim / 2.119 doğrulama
     - `de_da`: 95.000 eğitim / 2.216 doğrulama
     - `ki`: 28.137 eğitim / 669 doğrulama
     - `mi`: 32.799 eğitim / 802 doğrulama
     - `typo`: 200.000 eğitim / 8.000 doğrulama (`typo_hard_wrong` 45K / 925, `typo_hard_ambig` 40K / 913, `typo_easy_multi` 55K / 4.303, `typo_below_multi` 15K / 137, `typo_below_single` 20K / 1.298, `neg_miss` 15K / 338, `neg_oov` 10K / 86).
3. **Aşama 2 — İnce-Ayar (`py/train_context_v3.py`, 52,74 dk MPS):**
   - 4.228 adım (1,8 epok, `batch=192`, `backbone_lr=4.5e-4`, `head_lr=1.8e-3`, `dropout=0.07`, %45 öznitelik dropout, `loss = CE(total) + 0.8 × CE(ctx_only)`).
   - Ham doğrulama sonuçları (`valid.npz`, `n=13.806`):
     - **Genel:** **`%92.56`** (frekans/çekirdek tabanı `%85.86`, saf-bağlam **`ctx_only_all = %90.62`**), tabanın yanıldığı zor örneklerde `%68.39`.
     - `marks`: `%97.64` (taban `%95.61`, zor `%64.52`; ASCII `%98.03`, işaretli `%97.25`)
     - `de_da`: `%96.03` (taban `%90.21`, zor `%69.59`)
     - `ki`: `%91.18` (taban `%83.71`, zor `%60.55`)
     - `mi`: `%98.00` (taban `%77.31`, zor `%95.05`)
     - `typo`: `%89.82` (taban `%83.11`; `typo_hard_wrong` **`%73.08`**, `typo_hard_ambig` **`%87.40`**, `typo_below_multi` `%91.24`, `typo_below_single` `%95.53`, `typo_easy_multi` `%96.21`).

---

## 3. Önce / Sonra Ölçüm Tabloları (`--browser`, `site/public/models`)

### 3.1 `dev` Tam Set (4.398 cümle, 61.286 kelime)

| Sınıf (N) | Çekirdek (bağlamsız) | Bağlam v2 (`T=3`) | **Bağlam v3 (`T=3`)** | Fark (v3 − Çekirdek) |
|---|---:|---:|---:|---:|
| `apostrophe` (300) | 71.0% (0.7%w) | 71.0% | **71.0%** (0.7%w) | +0.0 |
| `ascii_sentence` (200) | 77.5% (22.5%w) | 77.5% | **81.0%** (19.0%w) | **+3.5** |
| `ascii_word` (400) | 86.5% (2.3%w) | 88.0% | **87.5%** (2.3%w) | **+1.0** |
| `clean` (2000, ch/1000w) | 1.75 (2.0%) | 1.79 (+0.04) | **1.78** (2.0%) | **+0.03** (`≤ +0.10` ✓) |
| `de_da_join` (300) | 77.3% (1.3%w) | 77.7% | **77.3%** (1.3%w) | +0.0 |
| `de_da_split` (300) | 85.3% (2.7%w) | 86.3% | **85.3%** (2.7%w) | +0.0 |
| `ki` (140) | 86.4% (4.3%w) | 87.1% | **88.6%** (3.6%w) | **+2.2** |
| `mi` (58) | 63.8% (0.0%w) | 62.1% (-1.7) | **63.8%** (0.0%w, 100%p) | +0.0 (v2'nin gerilemesi giderildi) |
| `split_join` (300) | 98.0% (1.3%w) | 98.0% | **98.0%** (1.3%w) | +0.0 |
| `typo` (400) | 81.8% (4.8%w) | 81.8% | **85.8%** (4.0%w) | **+4.0** |
| **Toplam hata düzeltme (2.398)** | **82.61%** (1981) | 83.03% (+0.42) | **83.86%** (2011) | **+1.25 puan** (v2'nin **3×** kazanımı) |
| **Hız (µs/kelime)** | **53 µs** | ~271–380 µs | **208 µs** | `< 300 µs` ✓ |

*Not: `dev/clean` içindeki `+0.03` (+1 cümle / 2.000) artışı `dev-even` üzerinde gerçek bir Vikipedi yazım hatasıdır (`heme → hemen`). Görülmemiş `dev-odd` yarısında `clean` tam `+0.00` kalmıştır.*

### 3.2 `dev-even` (Ayar) vs Görülmemiş `dev-odd` (Ezber Kontrolü)

| Sınıf | `even` Çekirdek | `even` v2 | **`even` v3** | `odd` Çekirdek | `odd` v2 | **`odd` v3 [GÖRÜLMEMİŞ]** |
|---|---:|---:|---:|---:|---:|---:|
| `apostrophe` | 76.0% | 76.0% | **76.0%** | 66.0% | 66.0% | **66.0%** |
| `ascii_sentence` | 82.0% | 82.0% | **86.0%** (+4.0) | 73.0% | 73.0% | **76.0%** (+3.0) |
| `ascii_word` | 87.5% | 89.5% | **88.5%** (+1.0) | 85.5% | 86.5% | **86.5%** (+1.0) |
| `clean` (ch/1000w) | 1.93 | 2.01 (+0.08) | **2.01** (+0.08*) | 1.56 | 1.56 (+0.00) | **1.56 (+0.00!)** |
| `de_da_join` | 76.7% | 77.3% | **76.7%** | 78.0% | 78.0% | **78.0%** |
| `de_da_split` | 89.3% | 90.0% | **89.3%** | 81.3% | 82.7% | **81.3%** |
| `ki` | 88.6% | 88.6% | **90.0%** (+1.4) | 84.3% | 85.7% | **87.1%** (+2.8) |
| `mi` | 69.0% | 69.0% | **69.0%** | 58.6% | 55.2% (-3.4) | **58.6%** (+0.0, 100%p) |
| `split_join` | 98.7% | 98.7% | **98.7%** | 97.3% | 97.3% | **97.3%** |
| `typo` | 80.5% | 80.5% | **84.0%** (+3.5) | 83.0% | 83.0% | **87.5%** (+4.5, 95.2%p) |
| **Toplam hata (1.199)** | **84.32%** | 84.82% (+0.50) | **85.49% (+1.17)** | **80.90%** | 81.23% (+0.33) | **82.24% (+1.34!)** |
| **Hız (µs/kelime)** | 54 µs | 271 µs | **196 µs** | 56 µs | — | **214 µs** |

**Genelleme kanıtı:** Görülmemiş `dev-odd` yarısında kazanım (`+1.34` puan) ayar yapılan `dev-even` yarısından (`+1.17` puan) bile yüksek, `clean` artışı tam **`+0.00`** (`1.56 → 1.56`), ve `typo` tek başına **`+4.5` puan** yükselirken yanlış-düzeltme oranı `4.0% → 3.5%` azalmıştır.

### 3.3 `bench/synth/tune.jsonl` (2.862 cümle, 20.400 kelime) — Tam / Çift ID (`even`) / Tek ID (`odd` [GÖRÜLMEMİŞ])

#### Tam Set (`bench/synth/tune.jsonl`)
| Sınıf (N) | Çekirdek (47 µs/w) | Bağlam v2 (278 µs/w) | **Bağlam v3 (192 µs/w)** | Fark (v3 − Çekirdek) |
|---|---:|---:|---:|---:|
| `clean` (1.431, ch/1000w) | **0.10** (0.1%) | 0.10 | **0.10** (0.1%) | **+0.00 ✓** |
| `adjacent_key` (146) | 80.8% | 80.8% | **89.0%** | **+8.2** |
| `double_omission` (93) | 32.3% | 32.3% | **38.7%** | **+6.4** |
| `mixed` (284) | 41.2% (51.8%w) | 41.2% | **51.8%** (44.7%w) | **+10.6** (yanlış -7.1) |
| `omission` (670) | 64.3% (14.6%w, 91.5%p) | 64.2% | **80.3%** (7.9%w, 95.4%p) | **+16.0** (yanlış -6.7!) |
| `transposition` (120) | 80.0% | 80.0% | **84.2%** | **+4.2** |
| `vowel_swap` (118) | 72.0% | 72.0% | **78.0%** (100%p) | **+6.0** |
| **Toplam hata (1.431)** | **61.29%** | 61.22% (-0.07) | **72.96%** | **+11.67 puan!** |

#### Çift ID (`tune-even`, ayar) vs Tek ID (`tune-odd`, GÖRÜLMEMİŞ)
| Sınıf | `even` Çekirdek | **`even` v3 (198 µs/w)** | `odd` Çekirdek | **`odd` v3 [GÖRÜLMEMİŞ] (200 µs/w)** |
|---|---:|---:|---:|---:|
| `clean` (ch/1000w) | 0.20 | **0.20 (+0.00!)** | 0.00 | **0.00 (+0.00!)** |
| `adjacent_key` | 79.8% | **88.1%** (+8.3) | 82.3% | **90.3%** (+8.0) |
| `double_omission` | 34.0% | **37.7%** (+3.7) | 30.0% | **40.0%** (+10.0) |
| `mixed` | 37.1% | **48.4%** (+11.3) | 44.4% | **54.4%** (+10.0) |
| `omission` | 64.3% | **79.9%** (+15.6) | 64.4% | **80.7%** (+16.3!) |
| `transposition` | 78.6% | **82.1%** (+3.5) | 81.3% | **85.9%** (+4.6) |
| `vowel_swap` | 70.5% | **75.4%** (+4.9) | 73.7% | **80.7%** (+7.0, 100%p) |
| **Toplam hata** | **60.81%** | **72.11% (+11.30)** | **61.76%** | **73.81% (+12.05!)** |

Görülmemiş `tune-odd` yarısında kazanım (`+12.05` puan) ayar yapılan `tune-even` yarısını (`+11.30` puan) geçmekte, `clean` **0.00** kalmakta ve `omission` sınıfında çekirdek motorun yanlış-düzeltme oranı yarı yarıya düşmektedir (`14.6% → 7.9%`).

### 3.4 El Yazımı (`handwritten/neon-v1.jsonl`) ve Konuşma (`conversation/clean.jsonl`)

| Ölçüm | Çekirdek | Bağlam v2 | **Bağlam v3** | Kısıt Durumu |
|---|---:|---:|---:|---|
| `neon-v1 / clean` (60, ch/1000w) | **0.00** | 0.00 | **0.00** (0.0%) | `= 0.00` ✓ |
| `neon-v1 / apostrophe` (20) | 95.0% | 95.0% | **95.0%** (100%p) | — |
| `neon-v1 / ascii` (40) | 90.0% | 90.0% | **92.5%** (+2.5, 100%p) | — |
| `neon-v1 / de_da` (30) | 73.3% | 80.0% | **76.7%** (+3.4, 100%p) | — |
| `neon-v1 / ki` (20) | 95.0% | 95.0% | **95.0%** (100%p) | — |
| `neon-v1 / mi` (25) | 100.0% | 100.0% | **100.0%** (100%p) | — |
| `neon-v1 / misspelling` (40) | 85.0% | 85.0% | **90.0%** (+5.0, 100%p) | — |
| `neon-v1 / split_join` (30) | 83.3% | 83.3% | **83.3%** (100%p) | — |
| **`neon-v1` Toplam hata (205)** | **87.80%** | 88.78% (+0.98) | **89.76% (+1.95)** | **Tüm sınıflar %100 kesinlik** |
| `neon-v1` hız (µs/kelime) | 67 µs | 385 µs | **247 µs** | `< 300 µs` ✓ |
| **`conversation/clean` (3.000, ch/1000w)** | **6.66** (3.5%) | 6.75 (+0.09 ✗) | **6.66 (+0.00!)** (3.5%) | `≤ +0.00` ✓ |
| `conversation/clean` hız (µs/kelime) | 31 µs | 308 µs | **141 µs** | **2,2× daha hızlı**, `< 300 µs` ✓ |

### 3.5 Yazma Benzetimi (`bench/typing.ts --browser --lag 0 --auto-marked --settle-add`)

Canlı yazım sırasında her kelime bitiminde çekirdek motor çalışır; cümle sonunda arka plan ara geçişi (`--settle-add --context <onnx>`) tüm cümleyi bağlam modeliyle tarar.

| Set | Çekirdek `--settle-add` | + Bağlam v2 `--settle-add` | **+ Bağlam v3 `--settle-add`** | Fark (v3 − Çekirdek) |
|---|---|---|---|---|
| `dev` **Tam** | **82.7%** (batch 82.6%, clean 1.86) | — | **83.8%** (batch 83.9%, clean 1.90, same 99.6%) | **+1.1 puan** (`clean +0.04`) |
| `dev-even` | 84.3% (clean 2.08) | 84.7% | **85.2%** (clean 2.16) | **+0.9 puan** |
| `dev-odd` **[GÖRÜLMEMİŞ]** | 81.2% (clean 1.64) | — | **82.3%** (clean **1.64**, `+0.00`!) | **+1.1 puan** (`clean +0.00`) |
| `synth/tune` **Tam** | **61.1%** (batch 61.3%, clean 0.10) | — | **72.0%** (batch 73.0%, clean **0.10**, same 99.3%) | **+10.9 puan** (`clean +0.00`) |
| `synth/tune-even` | 60.7% (clean 0.20) | 60.7% | **71.0%** (clean **0.20**, `+0.00`!) | **+10.3 puan** |
| `synth/tune-odd` **[GÖRÜLMEMİŞ]** | 61.6% (clean 0.00) | — | **73.0%** (clean **0.00**, `+0.00`!) | **+11.4 puan** |

*Karşılaştırma:* Çekirdek motorla `--settle-add` hiçbir şey kazandırmıyordu (`83.1% → 82.7%`). Bağlam Modeli v3 ile arka plan ara geçişi gerçek zamanlı yazma akışında `dev`'de **+1.1 puan**, günlük yazım hatalarında (`synth/tune`) **+10.9 puan** (görülmemiş `tune-odd`'da **+11.4 puan**) kazandırmakta ve toplu (`batch`) sonuçla `%99.3–99.6` örtüşmektedir.

### 3.6 Paket Boyutu, Tutarlılık (`idempotence`), Hız ve Tarayıcı WASM Doğrulaması

| Dosya / Metrik | Ham | Gzip (lvl 9) | Brotli | Sınır / Durum |
|---|---:|---:|---:|---|
| `site/public/models/lexicon.bin` | 5.587.966 B | 3.295.183 B | 3.046.559 B | Değişmedi |
| `site/public/models/morph.bin` | 254.158 B | 102.980 B | 94.822 B | Değişmedi |
| `site/public/models/known.tsv` | 31.617 B | 10.604 B | 9.106 B | Değişmedi |
| **Çekirdek modeller toplam** | 5,87 MB | **3,41 MB** | **3,15 MB** | Değişmedi |
| **`site/public/models/context.onnx` (v3 INT8)** | **3.015.976 B** | **2.509.215 B (2,51 MB)** | **2.473.123 B (2,47 MB)** | **`≤ 3,0 MB` gzip ✓** |
| Çekirdek hızı (`dev`) | — | **53 µs/kelime** | — | Bozulmadı ✓ |
| Bağlam v3 hızı (Node/ORT CPU) | — | **141–247 µs/kelime** (`dev` 208 µs, `tune` 192 µs, `conv` 141 µs) | — | **`< 300 µs` ✓** |
| Tutarlılık (`idempotence`) | Çekirdek `dev` (4.398): `1 (0.02%)`; v3 `dev-even` (2.199): `1 (0.05%)` | — | — | Kararlı ✓ |
| Tarayıcı WASM (`onnxruntime-web/wasm`) | `site/public/models/context.onnx` yüklendi, Node ORT ile bit-birebir puan üretti | — | — | Doğrulandı ✓ |

**Görevdeki bağlamsal yazım hatası örnekleri (WASM / ORT uçtan uca çıktı):**
- `"Dün akşam kötü bir hber aldık."` → `"Dün akşam kötü bir haber aldık."` (çekirdek `her` diyordu → v3 düzeltti)
- `"Hber gün aynı şeyi yapıyor."` → `"Her gün aynı şeyi yapıyor."`
- `"Yeni bir araba adık dün."` → `"Yeni bir araba aldık dün."` (çekirdek `adı` diyordu → v3 düzeltti)
- `"Çocuk çok üzülünce ağldı bütün gece."` → `"Çocuk çok üzülünce ağladı bütün gece."` (çekirdek `aldı` diyordu → v3 düzeltti)
- `"Dün marketten kitap ağldı ve çıktı."` → `"Dün marketten kitap aldı ve çıktı."`
- `"Yarın evde klacağımızı söyledim."` → `"Yarın evde kalacağımızı söyledim."` (çekirdek belirsiz bırakıyordu → v3 düzeltti)
- `"Her gün böyle oluyr artık."` → `"Her gün böyle oluyor artık."` (çekirdek belirsiz bırakıyordu → v3 düzeltti)
- `"Bu vakaa herkesi şaşırttı."` → `"Bu vaka herkesi şaşırttı."`

---

## 4. Kalibrasyon Eğrisi ve Seçilen Çalışma Noktası

### 4.1 ONNX İçi Gömülü Kalibrasyon ve Motor Eşikleri
Doğrulama verisi ikiye bölünerek ilk yarıda sıcaklık + önsel/rejim ölçekleri uyarlandı, ikinci ayrık yarıda (`n = 6.903`) eğri çıkarıldı (`data/work/context/model/calibration.json`):
- **ONNX çıkış katmanına gömülü parametreler:**
  - `temperature = 1.02`
  - `prior_bias = [0.0, 0.85, 1.5, 1.0, 0.0]` (`[marks_marked_has_mark, de_da_sep, ki_sep, mi_sep, typo]`)
  - `regime_inv_temp = [1.05, 0.37, 0.345, 0.72, 0.75, 1.0]` (`[marks_ascii, marks_marked, de_da, ki, mi, typo]`)
- **Motor eşikleri (`src/corrector.ts`):**
  - `CAREFUL`: `context = 3.0`, `contextVeto = 6.0`, `contextTypoOverride = 1.2`, `contextTypoAmbigGap = 1.25`, `contextTypoAmbigVsTyped = 1.5`, `contextTypoRescue = 2.5`.
  - `BALANCED`: `context = 2.5`, `contextVeto = 6.0`, `contextTypoOverride = 1.0`, `contextTypoAmbigGap = 1.0`, `contextTypoAmbigVsTyped = 1.2`, `contextTypoRescue = 2.0`.

### 4.2 Ayrık Doğrulama Yarısı (`valid.npz` holdout, `n = 6.903`) Kalibrasyon Eğrisi

Her eşikte (`T`): **FA** = yazılan doğruyken yanlış değiştirme oranı (`false_alarm_when_right`), **Fix** = yazılan yanlışken doğru düzeltme oranı (`fix_rate_when_wrong`).

| Eşik `T` | Genel `FA` / `Fix` | `marks_ascii` `FA` / `Fix` | `marks_marked` `FA` / `Fix` | `de_da` `FA` / `Fix` | `ki` `FA` / `Fix` | `mi` `FA` / `Fix` | `typo` `FA` / `Fix` (`WrongFix`) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5 | 5.27% / 88.47% | 2.57% / 97.40% | 0.76% / 95.91% | 2.09% / 91.92% | 7.27% / 87.27% | 1.21% / 98.30% | 7.32% / 86.53% (7.07%) |
| 1.0 | 3.68% / 86.06% | 1.78% / 96.83% | 0.57% / 93.72% | 0.73% / 86.21% | 5.76% / 85.15% | 1.21% / 97.82% | 5.21% / 84.25% (6.53%) |
| 1.5 | 2.52% / 82.39% | 1.78% / 96.68% | 0.38% / 89.77% | 0.36% / 75.14% | 3.94% / 81.82% | 0.97% / 97.33% | 3.52% / 81.04% (5.85%) |
| 2.0 | 1.70% / 78.41% | 1.78% / 95.82% | **0.00%** / 84.86% | 0.09% / 64.16% | 3.33% / 77.58% | 0.97% / 96.36% | 2.28% / 77.58% (5.19%) |
| **2.5 (`BALANCED` / `rescue`)** | **1.12% / 73.08%** | **1.58% / 95.09%** | **0.00% / 77.22%** | **0.00% / 51.36%** | **2.73% / 70.30%** | **0.73% / 95.39%** | **1.41% / 72.82% (4.41%)** |
| **3.0 (`CAREFUL`)** | **0.81% / 67.29%** | **1.39% / 93.94%** | **0.00% / 68.76%** | **0.00% / 38.66%** | **2.12% / 63.03%** | **0.49% / 91.99%** | **0.99% / 67.62% (3.82%)** |
| 3.5 | 0.51% / 60.68% | 1.19% / 93.22% | 0.00% / 56.48% | 0.00% / 22.78% | 0.91% / 55.76% | 0.24% / 89.56% | 0.62% / 61.91% (3.04%) |
| 4.0 | 0.30% / 53.84% | 0.79% / 91.05% | 0.00% / 39.84% | 0.00% / 11.89% | 0.91% / 49.09% | 0.24% / 86.17% | 0.32% / 55.77% (2.35%) |
| 4.5 | 0.19% / 47.60% | 0.79% / 90.04% | 0.00% / 26.33% | 0.00% / 5.63% | 0.61% / 39.39% | 0.24% / 82.77% | 0.15% / 49.71% (1.95%) |
| 5.0 | 0.09% / 42.20% | 0.20% / 89.18% | 0.00% / 13.64% | 0.00% / 1.81% | 0.00% / 31.52% | 0.24% / 77.67% | 0.10% / 44.42% (1.49%) |
| 6.0 | 0.04% / 32.64% | 0.20% / 83.69% | 0.00% / 4.09% | 0.00% / 0.00% | 0.00% / 22.73% | 0.24% / 65.05% | 0.03% / 33.80% (0.85%) |
| 7.0 | 0.01% / 25.11% | 0.20% / 78.21% | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 18.18% | 0.00% / 50.49% | 0.00% / 25.23% (0.48%) |
| 8.0 | 0.01% / 19.12% | 0.20% / 70.13% | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 10.91% | 0.00% / 37.38% | 0.00% / 18.60% (0.26%) |

**Neden bu çalışma noktası seçildi?**
- `CAREFUL T=3.0` noktasında `marks_marked` ve `de_da` ayrık doğrulama yanlış alarmı **%0.00**, `mi` **%0.49** (%92 düzeltme), `marks_ascii` **%93.94** düzeltme verir.
- Yazım hatası (`typo`) tarafında `override (1.2)` ve `ambigGap (1.25) / ambigVsTyped (1.5)` yalnızca sözlükte/biçimbilimde **zaten geçersiz** bir kelime üzerinde (sıfır geçerli-kelime yanlış alarm riskiyle) çalışır; bu nedenle `3.0` yerine daha esnek tutularak `synth/tune`'da **+11.67 puan** ve `dev/typo`'da **+4.0 puan** kazanırken `clean` setlerinde (`conv/clean`, `tune/clean`, `neon-v1/clean`, `dev-odd/clean`) **+0.00** yanlış alarm sağlanır. `rescue (2.5)` ise geçersiz kelimenin eşik altı tekil adayını kurtarırken `neg_oov` (özel ad / yabancı kelime) üzerinde yanlış alarm üretmemek için daha yüksek tutulmuştur.

---

## 5. Geri Alınan ve Düzeltilen Denemeler

1. **v3.0 Eğitiminde `edit_is_delete` (%0 pozitif) Kısayol Çöküşü:**
   - İlk Aşama 2 veri üretiminde (`data/work/context_v3`) `corrupt_word()` içinde fazla tuş ekleme (%0) yoktu. Dolayısıyla `features[23]` (`edit_is_delete`, yani `len(cand) < len(typed)`) eğitimdeki 143.989 yazım hatası örneğinde **hiç pozitif etiketlenmedi**. MLP başlığı bu özniteliğe `-19.0` ceza öğrendi ve gerçek dünya örneklerinde (`vakaa → vakada`, `Hber gün → Haber gün`, `kitap ağldı → ağladı`) kısa doğru adayı imkânsızlaştırdı; ayrıca `typo_hard_wrong` (65K) > `typo_easy_multi` (30K) aşırılığı `core_m` ağırlığını negatife çevirdi (`-0.275`).
   - **Çözüm (v3.1, `data/work/context_v3_clean`):** `corrupt_word()` içine %18 fazla tuş ekleme eklendi, `typo_easy_multi` (55K) > `typo_hard_wrong` (45K) dengelendi ve mimari saf-bağlam `ctx_head` + `0.8 × CE(ctx_only)` + %45 öznitelik dropout ile yeniden eğitildi. Kısayol tamamen ortadan kalktı (`vakaa → vaka`, `Hber gün → Her gün`, `kitap ağldı → aldı`).
2. **PyTorch MPS SDPA + Float Maske + Dropout `NaN` Çökmesi ve `batch=512` Bellek Şişmesi:**
   - İlk ince-ayar koşusunda `F.scaled_dot_product_attention` + float `attn_mask` + `dropout` MPS üzerinde 400. adımda `loss=nan` üretti (ONNX nicemlemede `AssertionError: scale issue`); `batch=512` (~1.450 etkin aday satırı) bellek takası nedeniyle adım başına 18 saniye sürdü.
   - **Çözüm:** `py/context_arch.py` içinde açık `matmul + softmax + dropout + matmul` dikkatine geçildi, `batch=192` (~500 etkin satır → 7× hızlanma, 0,76 s/adım) ve `torch.isfinite(loss)` denetimi eklendi.
3. **`fix.kind === "marks"` Üzerinde Yazım Hatası `override` İzni:**
   - Çekirdeğin zaten işaret düzeltmesi yaptığı (`fix.kind === "marks"`) kelimelerde `typoMode: "override"` açıldığında `dev-even/ascii_word` üzerinde 4 yanlış değişim oluştu (`uçak → ufak`, `kızı → krizi`, `devraldı → devrildi`, `bütün → burun`).
   - **Çözüm:** `override` kipi kesinlikle `fix.kind === "typo"` ile sınırlandırıldı.
4. **Yüksek `prior_bias[0]` (`2.5–3.5`) ile İşaretli Kelimelerde Ters Yön Bozulması:**
   - `marks_marked` rejiminde `has_marks=1` adayından `3.0` çıkarmak, halihazırda Türkçe karakterli doğru yazılmış kelimelerde işareti silme yönünü yapay olarak güçlendirip `ascii_word`'ü düşürdü.
   - **Çözüm:** `prior_bias[0] = 0.0` yapıldı ve `marks_marked` iki yönlü simetrik olarak `regime_inv_temp[1] = 0.37` ile ölçeklendi.
5. **`SOMBAHCEMI_KI.has(word)` Hatası (`src/corrector.ts`):**
   - `SOMBAHCEMI_KI` kümesi gövde (`madem, oysa, halbu, meğer`) tuttuğu halde `.has(word)` ile tam sözcük sorgulandığı için bağlam modeli `handwritten/clean` üzerinde `Mademki → Madem ki` ve `illaki → illa ki` yanlış alarmlarına yol açtı.
   - **Çözüm:** `FIXED_KI_WORDS` (`oysaki, halbuki, mademki, meğerki, illaki, sanki, belki, çünkü`) ve `!SOMBAHCEMI_KI.has(stem)` koruması eklendi + birim test yazıldı.
6. **Daha Agresif Kalibrasyon Noktaları (`rt[0]=1.35`, `ambigGap=1.0`, `rt[2]=0.45`):**
   - `rt[0]=1.35` konuşma temiz setinde `"Su bardağı → Şu bardağı"` (+1 FA), `ambigGap=1.0` `"Gördüün"` (+1 FA), `rt[2]=0.45` ise `de_da` üzerinde `"sende → sen de"` (+1 FA) üreterek `conversation/clean`'i `6.66`'nın üzerine çıkardı.
   - **Çözüm:** `rt[0]=1.05, rt[2]=0.345, ambigGap=1.25` seçilerek `conversation/clean` tam `6.66 (+0.00)` noktasında sabitlendi.

---

## 6. Açık Kalan Riskler ve Dürüst Değerlendirme

1. **Konuşma Temiz Seti (`conv/clean ≤ +0.00`) Kısıtının `de_da` Geri Çağırması Üzerindeki Etkisi:**
   - `conversation/clean`'i kesin olarak `6.66 (+0.00)` düzeyinde tutmak için `de_da` sıcaklık ölçeği muhafazakâr bırakıldı (`regime_inv_temp[2] = 0.345`, `prior_bias[1] = 0.85`). Bu yüzden modelin doğrulama verisindeki yüksek `de_da` başarısı (`%96.03` ham) `dev/de_da_join` ve `dev/de_da_split`'e `+0.0` yansıdı (`handwritten/de_da`'da `+3.4`, %100 kesinlik). İleride yazım diline (resmi metin vs konuşma) veya cümle uzunluğuna duyarlı `de_da` eşiğiyle `conv/clean` artmadan `de_da` kazanımı +1–2 puan daha açılabilir.
2. **Çok Kısa / Zayıf Bağlamlı Yazım Hatası Örnekleri ve Alt-Sözcük Parçalanma Yanlılığı:**
   - `"Bu kitabın adık ne"` gibi çok kısa ve iki anlamın da sözdizimsel olarak sığabildiği cümlelerde veya `"Kışın yllar kapandı"` örneğinde (`▁yıllar` tek alt-sözcük iken `▁yol + lar` iki alt-sözcük olduğu için) model bazen sık tek-parça adaya kayabiliyor (`sadık`, `yıllar`). Uzun/doğal cümlelerde bağlam bu yanlılığı aşıyor (`synth/tune` `omission` `+16.0` puan), ancak 3–4 kelimelik kısa cümlelerde yazım hatası kesinliği yakından izlenmelidir.
3. **Kullanıcı Yazımında Canlı Çekirdek Değişikliğinin Ara Geçişte Geri Alınması (`bench/typing.ts`):**
   - `bench/typing.ts` içinde çekirdek motorun canlı yazarken yaptığı bir yazım hatası düzeltmesi (`hber → her`) ara geçişte `priorTypoOriginals` üzerinden `haber`'e çevriliyor. `site/src/autocorrectExtension.ts` tarafında arka plan ara geçişi kurulurken, kullanıcının **manuel geri aldığı (undo)** veya düzenlediği bir kelimenin orijinal kaydının temizlenmesi gerekecektir.
4. **Tarayıcı WASM Tek-İş-Parçacıklı Gecikme:**
   - Node/ORT CPU'da `141–247 µs/kelime` ölçüldü (`< 300 µs`). Tarayıcı Web Worker içinde WASM tek iş parçacıklı çalıştığından (COOP/COEP yoksa SIMD tek iş parçacığı), çok uzun belgelerde arka plan geçişinin yalnızca son değişen cümle/paragraf aralığına (`range`) uygulanması önerilir.
5. **Doğrulama Testleri ve Derleme:**
   - `npm run typecheck`: geçti (0 hata).
   - `npm test`: **153 / 153** geçti (alt-sözcük kodlama/paketleme, `typoCandidatesFor`, `override`/`ambiguous`/`rescue`, `priorTypoOriginals`, çekirdekçe onarılmış çevre bağlamı ve `FIXED_KI_WORDS` testleri dahil).
   - `cd pkg && npm test`: **24 / 24** geçti.
   - `npm --prefix site run build`: geçti (`dist/sw.js` 5 model dosyasıyla üretildi; `data/work/context/model/context.onnx` ile `site/public/models/context.onnx` bit-birebir özdeş).
