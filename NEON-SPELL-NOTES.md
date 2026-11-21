# NEON Spell — Çalışma Notları (`neon/spell`)

Bu belge, `GOREV10.md` kapsamında `neon/spell` dalında geliştirilen **kapsamlı yazım hatası algılama (işaretleme + sıralı öneri)**, **biçimbilimsel üretici öncül (kök sıklığı × ek dizisi olasılığı)**, **iki hatalı hata-toleranslı biçimbilim aday üretimi** ve **paket/Worker `inspect()` API'si** çalışmalarını; tasarım gerekçelerini, her adımın önce/sonra ölçüm tablolarını (bağlamsız çekirdek ve `--context data/work/context/model/context.onnx` ile ayrı ayrı), en sık yanlış işaretleri, geri alınan denemeleri ve açık riskleri özetler.

> **Ezber yasağı ve veri ayrımı disiplini:**
> - Tüm kural tasarımları, eşik seçimleri, hata incelemeleri ve yanlış işaret analizleri **yalnızca** `dev --half even`, `bench/synth/tune.jsonl --id-half even`, `bench/handwritten/neon-v1.jsonl` ve `bench/conversation/clean.jsonl` üzerinde yapılmıştır.
> - `dev --half odd` ve `bench/synth/tune.jsonl --id-half odd` satırlarına hiç bakılmamış; bu yarılar yalnızca toplu genelleme ölçümü için koşturulmuştur (`bench/run.ts` de `--half odd` / `--id-half odd` verildiğinde tekil yanlış işaret listesini varsayılan olarak kapatır).
> - `site/src/` ve `bench/**/*.jsonl` dosyalarına dokunulmamıştır.
> - Başlangıçtaki Claude değişiklikleri ayrı bir ilk commit olarak (`Claude: paragraph rescan, word history, short swaps`) kaydedilmiştir.

---

## 1. Ne Yapıldı ve Neden?

Önceki sürümlerde çekirdek motor yalnızca yüksek güvenle otomatik düzeltebildiği kelimelere dokunuyor; emin olamadığı veya iki hata barındıran (`duzenblemiyor`, `duzenlemniyor`, `grkli`, `beketiyruz`) ya da derlemde hiç/çok az görülmüş geçerli çekimli biçimleri (`düzenlemiyor`, `kullandığımda`, `puanlarım`, `erişemiyoruz`, `kalemlerimi`) tamamen sessiz bırakıyordu.

Bunu dört katmanlı, tamamen yordamsal bir mimariyle çözdük:

### 1.1 Biçimbilimsel Üretici Öncül (`src/morphology/prior.ts`, `AMR2` `morph.bin`)
- **Sorun:** Türkçe sondan eklemeli olduğu için geçerli ve yaygın bir fiil çekimi (`düzenlemiyor`: tarayıcı tam tablosunda `0`, tüm derlemde `2`) yalnızca tam biçim sıklığıyla puanlandığında hem aday üretiminden eleniyor hem de sıralamada geride kalıyordu. Önceki `typoStemShare` denemesi ham dize ön-ekini sabit payla çarptığı için ek olasılığını yok saymış ve `double_omission` yanlış değişikliklerini artırmıştı.
- **Yöntem:** `scripts/build-browser-models.ts`, `data/work/unigrams_conv.tsv` (75M belirteç) ve `data/work/subtitle_counts.tsv` (konuşma dili) üzerinde biçimbilimce geçerli biçimleri `TurkishMorphology.analyze()` ile çözümleyerek:
  - Her `(kök, tür)` için toplam derlem kök sıklığını $C_{\text{lemma}}(\text{kök}, \text{tür})$ (24.231 kök),
  - Vikipedi + altyazı dengeli (%55/%45) ek dizisi olasılıklarını $P(\mathbf{m} \mid \text{tür})$ (5.698 sık ek dizisi),
  - Görülmemiş/uzun ek dizileri için yumuşatılmış biçimbirim ikili geçiş (bigram) geri çekilmesini $P(m_i \mid m_{i-1})$ (523 geçiş) çıkarır.
- **Üretici tahmin:**
  $$\hat{C}_{\text{morph}}(w) = \max_{a \in \text{analyze}(w)} C_{\text{lemma}}(a.\text{stem}, a.\text{pos}) \cdot P(a.\text{morphemes} \mid a.\text{pos})$$
  Örnek çıktılar: `düzenlemiyor` = **184,86**, `kullandığımda` = **188,52**, `danıştım` = **58,34**, `düzenleniyor` = **52,70**, `puanlarım` = **38,50**, `sıfırladı` = **33,38**; buna karşın zorlama/yapay çözümlemeler (`alveolüsün` = **0,06**, `gözlüksüzleştiriveremediklerimizden` = **0,00**) doğal biçimde ezilir.
- **Deneysel-Bayes birleşimi (`effectiveCount`):**
  - **Öneri sıralamasında (`rank`):** `priorEst = 0.65 * prior^0.78`, `eff = max(obs, priorEst) + 0.25 * min(obs, priorEst)`.
  - **Otomatik düzeltmede (`autofix`):** `rawPrior = 0.50 * prior^0.82`, ancak derlemde hiç görülmemiş biçimler için üst sınır `min(45, rawPrior)` (görülmüşlerde `min(120, rawPrior)`). Bu tavan, 75M kelimede 0 kez geçen seçimsel kısıtlı çekimlerin (`gerektin`, `göstermen`) çift harf atlamalarını (`gerektn → gerçekten`) bozmasını engeller.
- **İkili depolama (`AMR2`):** `src/morphology/binary.ts` geriye uyumlu biçimde genişletildi (`AMR1` hâlâ birebir okunup yazılır). `AMR2`, sözlük gövdesinin sonuna sıkı `MST1` öncül bloğu ekler (1 bayt/kök nicemlenmiş log-sıklık + 1 bayt biçimbirim kimlikleriyle ek dizileri + ikili geçişler). `morph.bin` ham `254 KB → 338 KB`, gzip **`105 KB → 154 KB` (+49 KB gzip)**; ek ağ isteği yoktur.

### 1.2 Hata-Toleranslı Biçimbilim Aday Üretimi (`src/morphology/fuzzy.ts`)
- **Sorun:** Yalnızca sözlük tabanlı (SymSpell vb.) 2-düzenleme aramaları, tam sözlükte bulunmayan ama geçerli olan `düzenlemiyor`, `kullandığımda`, `kalemlerimi`, `patlıcanları`, `gücenebilir` gibi biçimleri üretemez.
- **Yöntem:** Zemberek `StemIndex` + `MorphotacticsGraph` üzerinde birleşik **katlanmış kök ağacı (folded stem trie) + şeritli Damerau-Levenshtein sonek FST araması**:
  - İlk şüpheli kelimede bellekte tembel olarak kurulan kompakt işaret-katlanmış (`ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u`) kök ağacı (~33.575 kök, ~75K düğüm, ~18 ms kurulum, diskte **0 bayt**).
  - Önceden ayrılmış tek düz `Uint8Array` DP dilimi (trie DFS sırasında sıfır yığın ayırması) ve `|j - d| <= maxEdits` şeritli DP.
  - Kalan düzenleme bütçesi `0` olduğunda (kök-sonek sınırı yer değiştirmesi hariç, ör. `kalel|merimi → kalem|lerimi`) doğrudan `O(1)` işaret-katlanmış tam sonek hızlı yolu.
  - Kök vuruşları `(en az düzenleme, en uzun kök, en yüksek kök sıklığı)` sırasıyla ve kök başına adım tavanıyla (`160` / `220`) genişletilir; her üretilen aday tam `analyzer.isWord()` ile doğrulanır ve `turkishEditCost(typed, cand)` ile hassas Türkçe Q klavye + işaret kaybı + yer değiştirme + ünlü atlama maliyeti hesaplanır.
  - İki aşamalı çalışma:
    1. **1-düzenleme + sınırsız Türkçe işaret geri kazanımı (`maxEdits = 1`)**: `duzenblemiyor → düzenlemiyor`, `duzenlemniyor → düzenlemiyor / düzenleniyor`, `kalelmerimi → kalemlerimi`, `kullandğımda → kullandığımda` (~0,4–0,9 ms/şüpheli kelime).
    2. **2-düzenleme + işaret geri kazanımı (`maxEdits = 2`)**: Yalnızca 1-düzenleme güçlü aday bulamadığında (`grkli → gerekli`, `ftorafını → fotoğrafını`, `mmkn → mümkün`, `palıcanlar → patlıcanları`, `mahalemize → mahallemizde`, `beketiyruz → bekletiyoruz`, `gerektn → gerçekten`, `öğeciler → öğrenciler`).
  - Sonuçlar 4.096 girdilik önbellekte tutulur.

### 1.3 Yordamsal Algılama (İşaretleme) Kuralları (`src/corrector.ts`)
Otomatik düzeltilmeyen her izole belirteç için `detectFlagDetailed()` şu yordamsal süzgeçleri uygular:
1. **Kesin dışlamalar (asla işaretlenmez):**
   - Otomatik düzeltmeyle çakışan aralıklar,
   - İzole olmayan belirteçler (URL, e-posta, yol, `#`/`@`/`_`/sayı/tire bitişikleri, Latin-dışı alfabeler),
   - Satır içi ve blok kod parçaları (paket katmanında `findCodeRanges`),
   - `ignore()` ile yoksayılan kelimeler (Türkçe büyük/küçük harf duyarsız),
   - Tek harfliler, tümü büyük harf kısaltmalar (`TDK`, `NATO`), iç büyük harfli marka/kod adları (`MacOS`, `OpenAI`, `HAProxy`, `iPhone`),
   - Kesme işaretli özel ad ekleri (`Ankara'ya`, `G'Kar'a`),
   - Cümle ortası büyük harfli özel adlar (`Maniwaki`, `Ahmet`),
   - Konuşma dili kısaltmaları (`contractions: false` iken `burda`, `noldu`),
   - Biçimbilimin kabul ettiği tüm geçerli Türkçe kelimeler (`isRealWord(word)`),
   - Derlemde yaygın (`count >= 50`) biçimbilim-dışı terimler (modern alıntılar, markalar).
2. **Sözlükte kayıtlı OOV köklerin üretken çekim koruması (`isAttestedOovInflection`):**
   - Zemberek'in statik sözlüğünde bulunmayan (`!isRealWord(root)`) ama derlemde yerleşik (`exactCount >= 12`, `capitalShare < 0.5`) ad/alıntı köklerinin ünlü uyumlu ve ünsüz benzeşmeli Türkçe ad çekimleri (`özgeçmişimi`, `tripodlar`, `stabilitesinden`, `rockçılarından`) yanlış işaretlenmez. Zemberek'in zaten bildiği köklere asla uygulanmadığı için gerçek yazım hatalarını gizlemez.
3. **İki işaret nedeni (`FlagReason`):**
   - **`invalid` (`typedCount === 0` ve biçimbilim reddediyor):**
     - **Cümle başı büyük harf** özel ad sayılmaz, ancak Vikipedi/altyazı cümle başı özel adlarını (`Maniwaki`, `Ruluka`, `Cockersham`) ayırt etmek için geçerli bir Türkçe adayın varlığı (`editCost <= 1.2 & eff >= 1`, `<= 1.75 & eff >= 5`, veya `<= 1.95 & eff >= 50`, ya da ayırma/kesme adayı) aranır. Böylece `Hoxam → Hocam`, `Tikım → Takım`, `Otoparkat → Otoparkta`, `Maalledek → Mahalledeki` yakalanırken cümle başı özel adlar sessiz kalır.
     - **Küçük harf:** Yakın Türkçe adayı olmayan açık yabancı/Latince/taksonomik sözcükler (`q/w/x/â/î/û`, `-idae/-aceae/-ensis/-phyllus/...`) ve tüm Zemberek FST'sinde 2 düzenleme içinde 0 adayı olan yabancı terimler dışlanır; buna karşın içinde Türkçe harf olup 1 düzenlemeyle geçerli kelimeye ulaşanlar (`klasöwe → klasöre`) yakalanır.
   - **`rare` (`0 < typedCount < 50`, biçimbilim reddediyor):**
     - Cümle başı büyük harflilerde `capitalShare >= 0.45` özel ad kabul edilir; küçük harflilerde ise derlemdeki büyük harf payı düşülerek `typedLowerCount = count * (1 - capShare)` kullanılır — böylece büyük harfle özel ad olarak geçmiş ama küçük harfle hiç geçmeyen yazım hataları (`beek → bebek`, `sebz → sebze`, `gedi → geldi`, `aşam → akşam`) yakalanır.
     - Yalnızca en iyi geçerli adaya çok yakın (`editCost <= 1.25`) ve belirgin biçimde daha güçlü (`effCount >= max(80, 18 * typedLowerCount)` veya `typedCount <= 3` için `max(45, ...)`; cümle başı görülmüşlerde çok daha sıkı `>= max(500, 200 * typedCount)` → `Afedersiniz → Affedersiniz` yakalanır, `Yaghi`/`Şeyhhasan` korunur) olduğunda işaretlenir.
4. **Öneri sıralaması ve Türkçe durum-çatı uyumu:**
   - Çekirdek sıralama puanı:
     $$\text{rankScore} = \log(\text{effCount} + 1) - 3.6 \cdot \text{editCost} - 1.8 \cdot \mathbb{I}[\text{foldedEdits} \ge 2] + \text{pairBonus} + \text{morphPenalty} + \text{voicePenalty}$$
   - **Türkçe belirtme-edilgen uyumu (`voicePenalty = -1.6`):** Hemen önceki kelime tüm çözümlemelerinde kesin belirtme durumundaysa (`Acc`, ör. `hatalarını`, `arabayı`), salt edilgen/dönüşlü (`Pass`/`Acquire`) fiil adayları (`düzenleniyor`, `düzenlenmiyor`) etken geçişli adaylara (`düzenlemiyor`) göre cezalandırılır. Bu genel Türkçe sözdizimi kuralı bağlam modeli olmadan dahi `hatalarını duzenlemniyor` için `düzenlemiyor`'u 1. sıraya taşır.
   - **Bağlam modeliyle yeniden sıralama (`inspectAsync`):** 2+ önerili işaretler tek bir toplu `model.score()` çağrısında (öncül-bilinçli sıklık öznitelikleriyle) cümle bağlamında puanlanır ve `contextScore + 0.65 * coreScore` ile sıralanır.

### 1.4 Paket ve Worker API'si (`pkg/src/`)
Geriye %100 uyumlu yeni API eklendi (`check`, `fix`, `apply`, `ignore`, `unignore`, `setMode`, `dispose` değişmedi):
- Yeni türler (`pkg/src/types.ts`, `pkg/src/index.ts`):
  - `FlagReason = "invalid" | "rare"`
  - `Flag { from: number; to: number; original: string; suggestions: string[]; reason: FlagReason }`
  - `InspectResult { fixes: Fix[]; flags: Flag[] }`
- `Autr.inspect(text: string, options?: CheckOptions): Promise<InspectResult>`
- `AutrEngine.inspect()` (`pkg/src/engine.ts`): `range`, `kinds` (`"yazim"` dışlanırsa işaret üretmez; `kinds` verilmezse tüm işaretler döner), `autoMarked`, `mode`, `priorTypoOriginals`, kod bloğu koruması, `ignore()`/`unignore()` ve `fixes`/`flags` çakışmazlığı `check()` ile birebir uyumlu çalışır.
- Worker protokolü (`pkg/src/protocol.ts`, `worker.ts`, `workerClient.ts`): `type: "inspect"` isteği ve `type: "inspectResult"` yanıtı eklendi.

---

## 2. Kullanıcının Örnek Cümlesi

> `ben şimdi mesela bir düzenleme yapıyorum ancak bazen metinleri duzenblemiyor yani çok basit kelime harf hatalarını duzenlemniyor bka burada mesela.`

| Hata | Tür / Neden | Bağlamsız (`inspect`) | Bağlam Modeli (`inspectAsync`) |
|---|---|---|---|
| `duzenblemiyor` | `invalid` | İşaretlendi → **1. `düzenlemiyor`** (`düzenleniyor`, `düzenlenmiyor`, `düzenletmiyor`, `düzelemiyor`) | İşaretlendi → **1. `düzenlemiyor`** (`düzenleniyor`, `düzenlenmiyor`, `düzenletmiyor`, `düzelemiyor`) |
| `duzenlemniyor` | `invalid` | İşaretlendi → **1. `düzenlemiyor`** (`düzenleniyor`, `düzenlenmiyor`, `düzelemiyor`, `düzeylenmiyor`) | İşaretlendi → **1. `düzenlemiyor`** (`düzenleniyor`, `düzenlenmiyor`, `düzelemiyor`, `düzeylenmiyor`) |
| `bka` | `rare` | İşaretlendi → **1. `bak`** (`baka`, `beka`) | İşaretlendi → **1. `bak`** (`baka`, `beka`) |

Üç hata da hem bağlamsız hem bağlam modeliyle eksiksiz yakalanır ve **doğru öneri 1. sıradadır**; cümledeki diğer tüm temiz kelimeler için **0 yanlış işaret** üretilir.

---

## 3. Adım Adım Önce / Sonra Ölçüm Tabloları (`--browser`, `site/public/models`)

> **Kısaltmalar:** `f` = otomatik düzeltildi, `fl@1` = işaretlendi ve doğru öneri 1. sırada, `fl@5` = işaretlendi ve doğru öneri 2–5. sırada, `fl-yok` = işaretlendi (doğru öneri ilk 5'te yok veya kısmi yanlış düzeltme), `kaçır` = kaçırıldı, `yakalama` = `f + fl` toplam algılama oranı, `ch/1kw` = 1000 kelimede otomatik değişiklik, `fl/1kw` = 1000 kelimede işaret sayısı.

### 3.1 `dev` (Tam Set + `even` / `odd` Ezber Kontrolü) — Bağlamsız Çekirdek

| Küme / Sınıf | Başlangıç `fixed` / `ch/1kw` | Aşama 1b (Salt Algılama) | **Son (Aşama 2b)** `fixed` / `ch/1kw` | **Algılama (`f` / `fl@1` / `fl@5` / `fl-yok` / `kaçır`)** | **Yakalama (`f+fl`)** | **`fl/1kw`** |
|---|---:|---:|---:|---|---:|---:|
| **`dev` tam `typo` (400)** | 81.8% (4.3%w) | — | **82.5%** (4.5%w) | 84.8% / 8.0% / 1.8% / 2.5% / 3.0% | **97.0%** | 10.90 |
| **`dev` tam `clean` (2000)** | `1.75` ch/1kw | — | **`1.82`** (+0.07 ≤ +0.10 ✓) | — | — | **1.63** |
| `dev-even typo` (200) | 80.5% (4.5%w) | 80.5% (det 97.0%) | **81.5%** (4.5%w) | 84.5% / 8.5% / 2.0% / 2.0% / 3.0% | **97.0%** | 10.09 |
| `dev-even clean` (1000) | `1.93` ch/1kw | `1.93` (`fl 1.85`) | **`2.01`** (+0.08*) | — | — | **1.77** |
| `dev-odd typo` (200) | 83.0% (4.0%w) | — | **83.5%** (4.0%w) | 85.0% / 7.5% / 1.5% / 3.0% / 3.0% | **97.0%** | 11.76 |
| `dev-odd clean` (1000) | `1.56` ch/1kw | — | **`1.64`** (+0.08) | — | — | **1.48** |
| `dev` tam diğer sınıflar | `apostrophe` 71.0%, `ascii_s` 77.5%, `ascii_w` 86.5%, `de_da_j` 77.3%, `de_da_s` 85.3%, `ki` 86.4%, `mi` 63.8%, `split_join` 98.0% | değişmedi | **tamamı birebir korundu** | `mi` yakalama 72.4%, `ascii_w` 90.0%, `de_da_j` 80.7% | — | — |

*\*`dev-even clean`'deki +0.08 (+1 kelime) artış, Vikipedi'deki gerçek yazım hatası olan `buzulaşmanın → buzullaşmanın` düzeltmesidir.*

### 3.2 `dev` (Tam Set + `even` / `odd`) — Bağlam Modeliyle (`--context context.onnx`)

| Küme / Sınıf | Başlangıç `--context` | **Son `--context`** `fixed` / `ch/1kw` | **Algılama (`f` / `fl@1` / `fl@5` / `fl-yok` / `kaçır`)** | **Yakalama (`f+fl`)** | **`fl/1kw`** |
|---|---:|---:|---|---:|---:|
| **`dev` tam `typo` (400)** | 85.8% (4.0%w) | **86.5%** (4.3%w) | 88.8% / 4.5% / 1.3% / 2.5% / 3.0% | **97.0%** | 7.67 |
| **`dev` tam `clean` (2000)** | `1.78` ch/1kw | **`1.86`** (+0.08 ≤ +0.10 ✓) | — | — | **1.59** |
| `dev-even typo` (200) | 84.0% (4.5%w) | **85.0%** (5.0%w) | 87.5% / 5.5% / 1.5% / 2.5% / 3.0% | **97.0%** | 7.37 |
| `dev-even clean` (1000) | `2.01` ch/1kw | **`2.08`** (+0.07) | — | — | **1.70** |
| `dev-odd typo` (200) | 87.5% (3.5%w) | **88.0%** (3.5%w) | 89.5% / 3.5% / 1.0% / 3.0% / 3.0% | **97.0%** | 7.98 |
| `dev-odd clean` (1000) | `1.56` ch/1kw | **`1.64`** (+0.08) | — | — | **1.48** |

### 3.3 `dev2` (Tam Set — 63.338 kelime)

| Sınıf | Başlangıç Çekirdek | **Son Çekirdek** (`fixed` / `yakalama` / `fl/1kw`) | **Son `--context`** (`fixed` / `yakalama` / `fl/1kw`) |
|---|---:|---|---|
| `typo` (400) | 79.0% (4.8%w) | **81.3%** (+2.3) / **95.8%** (83.5f + 8.5@1 + 1.0@5 + 2.8no) / 11.02 | **83.3%** / **95.8%** (85.5f + 6.3@1 + 1.5@5 + 2.5no) / 9.53 |
| `clean` (2000) | `1.64` ch/1kw | **`1.72`** ch/1kw (+0.08) / `fl/1kw` = **1.56** | **`1.76`** ch/1kw / `fl/1kw` = **1.52** |
| `apostrophe_no` (200) | `4.35` ch/1kw | **`4.35`** ch/1kw (+0.00) / `fl/1kw` = **1.00** | **`4.35`** ch/1kw / `fl/1kw` = **1.00** |

### 3.4 `bench/synth/tune.jsonl` — Çift (`even`, ayar) ve Tek (`odd`, görülmemiş doğrulama)

#### Bağlamsız Çekirdek (`--browser`)

| Yarı / Sınıf (N) | Başlangıç `fixed` (`wrong`) | **Son `fixed` (`wrong`)** | **Algılama (`f` / `fl@1` / `fl@5` / `fl-yok` / `kaçır`)** | **Yakalama (Cümle / Kelime)** | **`fl/1kw`** |
|---|---:|---:|---|---:|---:|
| `even / adjacent_key` (84) | 79.8% (1.2%) | **81.0%** (1.2%) | 81.0% / 16.7% / 1.2% / 1.2% / 0.0% | **100.0% / 100.0%** | 24.96 |
| `even / double_omission` (53) | 34.0% (5.7%) | 34.0% (7.5%) | 37.7% / 32.1% / 17.0% / 13.2% / 0.0% | **100.0% / 100.0%** | 89.14 |
| `even / mixed` (124) | 37.1% (56.5%) | 37.1% (56.5%) | 37.9% / 28.2% / 11.3% / 22.6% / 0.0% | **100.0% / 100.0%** | 80.29 |
| `even / omission` (339) | 64.3% (15.0%) | **66.4%** (15.9%) | 66.7% / 19.5% / 3.8% / 9.7% / 0.3% | **99.7% / 99.8%** | 36.76 |
| `even / transposition` (56) | 78.6% (3.6%) | **80.4%** (3.6%) | 83.9% / 16.1% / 0.0% / 0.0% / 0.0% | **100.0% / 100.0%** | 22.84 |
| `even / vowel_swap` (61) | 70.5% (1.6%) | **78.7%** (1.6%) | 78.7% / 16.4% / 3.3% / 1.6% / 0.0% | **100.0% / 100.0%** | 29.34 |
| `even / clean` (717) | `0.20` ch/1kw | **`0.20` (+0.00 ✓)** | — | — | **0.00** |
| **`odd / adjacent_key` (62)** | 82.3% (3.2%) | **83.9%** (3.2%) | 83.9% / 9.7% / 3.2% / 1.6% / 1.6% | **98.4% / 98.5%** | 20.98 |
| **`odd / double_omission` (40)** | 30.0% (5.0%) | **30.0%** (5.0%, +0.0%w!) | 30.0% / 50.0% / 12.5% / 7.5% / 0.0% | **100.0% / 100.0%** | 104.87 |
| **`odd / mixed` (160)** | 44.4% (48.1%) | **45.0%** (48.8%) | 46.3% / 24.4% / 13.1% / 15.0% / 1.3% | **98.8% / 99.4%** | 72.64 |
| **`odd / omission` (331)** | 64.4% (14.2%) | **65.6%** (13.9%) | 65.6% / 20.5% / 6.0% / 7.6% / 0.3% | **99.7% / 99.8%** | 38.93 |
| **`odd / transposition` (64)** | 81.3% (4.7%) | **81.3%** (4.7%) | 84.4% / 12.5% / 0.0% / 3.1% / 0.0% | **100.0% / 100.0%** | 22.78 |
| **`odd / vowel_swap` (57)** | 73.7% (0.0%) | **77.2%** (0.0%) | 77.2% / 22.8% / 0.0% / 0.0% / 0.0% | **100.0% / 100.0%** | 32.34 |
| **`odd / clean` (714)** | `0.00` ch/1kw | **`0.00` (+0.00 ✓)** | — | — | **0.20** |

#### Bağlam Modeliyle (`--browser --context context.onnx`)

| Yarı / Sınıf (N) | Başlangıç `--context` `fixed` | **Son `--context` `fixed`** | **Algılama (`f` / `fl@1` / `fl@5` / `fl-yok` / `kaçır`)** | **Yakalama (Cümle / Kelime)** | **`fl/1kw`** |
|---|---:|---:|---|---:|---:|
| `even / adjacent_key` (84) | 88.1% | **88.1%** | 88.1% / 9.5% / 1.2% / 1.2% / 0.0% | **100.0% / 100.0%** | 14.98 |
| `even / double_omission` (53) | 37.7% | **37.7%** | 41.5% / 34.0% / 11.3% / 13.2% / 0.0% | **100.0% / 100.0%** | 80.78 |
| `even / mixed` (124) | 48.4% | **48.4%** | 49.2% / 27.4% / 4.0% / 19.4% / 0.0% | **100.0% / 100.0%** | 61.52 |
| `even / omission` (339) | 79.9% | **81.1%** | 81.4% / 11.5% / 0.9% / 5.9% / 0.3% | **99.7% / 99.8%** | 18.38 |
| `even / transposition` (56) | 82.1% | **83.9%** | 85.7% / 14.3% / 0.0% / 0.0% / 0.0% | **100.0% / 100.0%** | 20.30 |
| `even / vowel_swap` (61) | 75.4% | **80.3%** | 80.3% / 18.0% / 1.6% / 0.0% / 0.0% | **100.0% / 100.0%** | 29.34 |
| `even / clean` (717) | `0.20` ch/1kw | **`0.20` (+0.00 ✓)** | — | — | **0.00** |
| **`odd / adjacent_key` (62)** | 90.3% | **90.3%** | 90.3% / 4.8% / 1.6% / 1.6% / 1.6% | **98.4% / 98.5%** | 9.32 |
| **`odd / double_omission` (40)** | 40.0% | **40.0%** (5.0%w) | 40.0% / 47.5% / 5.0% / 7.5% / 0.0% | **100.0% / 100.0%** | 89.89 |
| **`odd / mixed` (160)** | 54.4% | **54.4%** | 55.6% / 23.1% / 6.3% / 13.8% / 1.3% | **98.8% / 99.4%** | 54.05 |
| **`odd / omission` (331)** | 80.7% | **81.0%** | 81.0% / 10.9% / 2.4% / 5.4% / 0.3% | **99.7% / 99.8%** | 19.89 |
| **`odd / transposition` (64)** | 85.9% | **85.9%** | 89.1% / 6.3% / 0.0% / 4.7% / 0.0% | **100.0% / 100.0%** | 13.67 |
| **`odd / vowel_swap` (57)** | 80.7% | **82.5%** (0.0%w) | 82.5% / 17.5% / 0.0% / 0.0% / 0.0% | **100.0% / 100.0%** | 24.88 |
| **`odd / clean` (714)** | `0.00` ch/1kw | **`0.00` (+0.00 ✓)** | — | — | **0.20** |

### 3.5 El Yazımı (`handwritten/neon-v1.jsonl`) ve Konuşma Dili (`conversation/clean.jsonl`)

| Küme / Sınıf | Başlangıç Çekirdek | **Son Çekirdek** (`fixed` / `yakalama` / `fl/1kw`) | Başlangıç `--context` | **Son `--context`** (`fixed` / `yakalama` / `fl/1kw`) |
|---|---:|---|---:|---|
| `neon-v1 / misspelling` (40) | 85.0% (100%p) | **90.0%** (+5.0) / **95.0%** (90.0f + 5.0@1) / 5.56 | 90.0% (100%p) | **90.0%** / **95.0%** (90.0f + 5.0@1) / 5.56 |
| `neon-v1 / clean` (60) | `0.00` ch/1kw | **`0.00` (+0.00 ✓)** / `fl/1kw` = **0.00** | `0.00` ch/1kw | **`0.00` (+0.00 ✓)** / `fl/1kw` = **0.00** |
| `neon-v1 / ascii` (40) | 90.0% | 90.0% / 92.5% (tok 96.6%) | 92.5% | 92.5% / **97.5%** (tok 98.9%) |
| `conversation / clean` (3000) | `6.66` ch/1kw | **`6.66` (+0.00 ✓)** / `fl/1kw` = **1.77** (38/21.478) | `6.66` ch/1kw | **`6.66` (+0.00 ✓)** / `fl/1kw` = **1.77** (38/21.478) |

### 3.6 Kendi Ürettiğimiz Sentetik İkili Hata Ölçümü (`even clean` üzerinde 1.796 cümle)

Temiz cümlelerdeki 6+ harfli geçerli kelimelere Türkçe harf kaybı + harf hatası ve çift harf hatası uygulanarak ölçüldü:

| Sentetik İkili Hata Sınıfı (N) | `fixed` | `flag@1` | `flag@5` | `flag-no` | `missed` | **Yakalama (`f+fl`)** | **`f + fl@1`** |
|---|---:|---:|---:|---:|---:|---:|---:|
| `mark_plus_extra` (433, ör. `duzenblemiyor`) | 57.5% | 36.0% | 1.6% | 3.5% | 1.4% | **98.6%** | **93.5%** |
| `mark_plus_omit` (400) | 25.5% | 46.5% | 13.3% | 14.0% | 0.8% | **99.3%** | **72.0%** |
| `mark_plus_swap` (423) | 49.9% | 46.3% | 1.2% | 2.1% | 0.5% | **99.5%** | **96.2%** |
| `double_extra_or_sub` (540) | 2.8% | 68.0% | 16.9% | 9.1% | 3.3% | **96.7%** | **70.8%** |

### 3.7 Hız, Boyut ve Tutarlılık (`idempotence`)

| Ölçüm | Başlangıç | **Son** | Hedef / Kısıt |
|---|---:|---:|---|
| Çekirdek modeller toplam (`lexicon.bin` + `morph.bin` + `known.tsv`) | `3.410 MB` gzip (`3.311 MB` br) | **`3.459 MB` gzip** (`3.360 MB` br) | `< 5.00 MB` gzip ✓ |
| Eklenen `morph.bin` `MST1` öncül bloğu | — | **`+49 KB` gzip** (`254 KB → 338 KB` ham) | Raporlandı ✓ |
| `dev` hız — `correct()` (`--no-inspect`) | 53 µs/kelime | **56 µs/kelime** | `≤ ~120 µs` ✓ |
| `dev` hız — `inspect()` (düzeltme + işaretleme + 2-düzenleme) | — | **107 µs/kelime** (`dev2`: 107 µs) | `≤ ~120 µs` ✓ |
| `conversation/clean` hız — `inspect()` | 37 µs/kelime | **61 µs/kelime** | `≤ ~120 µs` ✓ |
| `dev` hız — `inspectAsync()` (`--context`) | 249 µs/kelime | **257 µs/kelime** (`conv`: 175 µs) | — |
| `idempotence` (`dev`, 4.398 cümle) | 1 (0.02%) | **1 (0.02%)** | Değişmedi ✓ |

---

## 4. Temiz Metinlerde En Sık Yanlış İşaretler (Yalnızca `even` / Konuşma)

### 4.1 `bench/conversation/clean.jsonl` — 38 / 21.478 kelime (`1.77 / 1000 kelime`)
İlk 30 (her biri 1 kez):
`artisdir` (`invalid→partidir`), `atlıyacaksanız` (`invalid→atlayacaksanız`), `avucumun` (`invalid→avucunun`), `barsaklarıdır` (`invalid→bardaklarıdır`), `basbas` (`invalid→babası`), `biyoritmine` (`invalid→biyotitine`), `blüz` (`invalid→bölüm`), `buldolabında` (`invalid→buzdolabında`), `colada` (`rare→cola da`), `Cylonlar` (`invalid→Ceylanlar`), `dankımı` (`invalid→tanımı`), `deyecem` (`invalid→derecem`), `duradayım` (`invalid→durumdayım`), `düzüşürken` (`invalid→düzülürken`), `Gördüün` (`invalid→Gördün`), `herneyse` (`rare→her neyse`), `idiyotlar` (`invalid→diyotlar`), `imizin` (`invalid→ikizin`), `işyerime` (`invalid→işyerine`), `Kahireden` (`invalid→Kahreden`), `kocagöt` (`invalid→kocaköy`), `konuçlanıp` (`invalid→konuşlanıp`), `kübü` (`rare→küpü`), `küçükeşit` (`invalid→küçükleşti`), `lmre` (`invalid→ömre`), `lşıktan` (`invalid→ışıktan`), `mayahoş` (`invalid→mayhoş`), `mühitlerde` (`invalid→muhitlerde`), `ötededen` (`invalid→öteden`), `pançı` (`invalid→planlı`).

> **Gözlem:** Bu 38 işaretin **20'den fazlası** OpenSubtitles kaynağındaki gerçek yazım/OCR hatalarıdır (`buldolabında`, `lşıktan`, `mayahoş`, `mühitlerde`, `ötededen`, `konuçlanıp`, `Gördüün`, `atlıyacaksanız`, `herneyse`, `artisdir`, `duradayım`, `blüz`, `barsaklarıdır`). Gerçek yanlış işaretler esasen Zemberek'te olmayan bileşikler/argo (`işyerime`, `kocagöt`, `küçükeşit`, `biyoritmine`) ve cümle başı bilimkurgu/yer adlarıdır (`Cylonlar`, `Kahireden`, `Ellenor`).

### 4.2 `bench/dev/clean.jsonl --half even` — 23 / 12.991 kelime (`1.77 / 1000 kelime`)
Tamamı (23 kelime, her biri 1 kez):
`bölgedelerde` (`invalid→bölgelerde`), `bronkoskopa` (`invalid→bronkoskopi`), `Dinot` (`invalid→Dipnot`), `Dolguusu` (`invalid→Dolgusu`), `düşünürek` (`rare→düşünerek`), `folivorlar` (`invalid→folklorlar`), `heme` (`rare→hemen`), `kotobaya` (`invalid→otobana`), `kullancak` (`rare→kullanacak`), `kuşbilim` (`invalid→koşnilim`), `öğretmeğe` (`invalid→öğretmeye`), `olmağı` (`invalid→olması`), `ortikon` (`invalid→ortaköy`), `rekonstrüksüyonlar` (`invalid→rekonstrüksiyonlar`), `Şeyhhasan` (`rare→Şeyh hasan`), `sıralalamada` (`invalid→sıralamamada`), `tarajalis` (`invalid→taramalı`), `ülkelelerde` (`invalid→ülkelerde`), `uydumculuğa` (`invalid→uyduculuğa`), `varolmamaları` (`invalid→varamamaları`), `xcatlak` (`invalid→çatlak`), `Yeşilyeşil` (`rare→Yeşil yeşil`), `yörüngealtı` (`rare→yörünge altı`).

> **Gözlem:** Bunların yaklaşık **9'u gerçek Vikipedi yazım hatasıdır** (`bölgedelerde`, `Dolguusu`, `düşünürek`, `heme`, `kullancak`, `rekonstrüksüyonlar`, `sıralalamada`, `ülkelelerde`, `yörüngealtı`). Geri kalanlar nadir teknik/eski Türkçe/Latince sözcükler (`bronkoskopa`, `folivorlar`, `ortikon`, `öğretmeğe`, `olmağı`, `tarajalis`, `kuşbilim`, `uydumculuğa`) ve cümle başı özel adlardır (`Dinot`, `Şeyhhasan`).

### 4.3 `synth/tune.jsonl clean` ve `handwritten/neon-v1.jsonl clean`
- `synth/tune.jsonl --id-half even clean` (717 cümle): **0.00 / 1000 kelime** (0 yanlış işaret).
- `synth/tune.jsonl --id-half odd clean` (714 cümle): **0.20 / 1000 kelime** (1 işaret).
- `handwritten/neon-v1.jsonl clean` (60 cümle): **0.00 / 1000 kelime** (`özgeçmişimi`, OOV kök çekimi kuralıyla korundu).

---

## 5. Geri Alınan veya Düzeltilen Denemeler

1. **Sınırsız `MorphPrior` otomatik düzeltme yükseltmesi (`0.55 * prior^0.85` tavansız):**
   - `gerek` gibi çok sık fiillerin 75M kelimede 0 kez geçen 2. tekil çekimine (`gerektin`) yapay olarak yüksek puan vererek `double_omission` wrong-change oranını `5.7% → 9.4%` yaptı (`gerektn → gerektin`, `göstermdn → göstermen`) ve `suhenin → şubenin` yanlış düzeltmesiyle `dev-even mi` sınıfını düşürdü.
   - **Düzeltme:** Otomatik düzeltmede görülmemiş biçimler için tavan (`min(45, 0.5 * prior^0.82)`), en az 8 harf şartı, ve işaret geri kazanımı + harf değişikliği birleşiminde eş-uzunluklu ikame yasağı eklendi. `dev mi` %100 kesinliğe, `synth-odd double_omission` wrong-change oranı başlangıçla birebir `5.0%`'ye döndü.
2. **Kök sıralamasında `lemmaScore`-öncelikli genişletme (`fuzzy.ts`):**
   - 2–3 harfli çok sık kökler (`ol`, `al`, `et`) adım bütçesini tüketip `patlıcan` (`palıcanlar`) ve `gücen` (`gcnebilir`) gibi uzun gerçek kökleri aç bıraktı (geri çağırma 18/21'e düştü).
   - **Düzeltme:** `(bestDist ASC, stemLen DESC, lemmaScore DESC)` sıralaması + kök başına adım tavanı (`160`/`220`) ve kök-sonek sınırı yer değiştirme kontrolü (`kalel|merimi → kalem|lerimi`) ile geri çağırma **21/21 (%100)** oldu.
3. **Şeritli DP diliminde (`dpSlab`) sıfırlama eksikliği (`fuzzy.ts`):**
   - İlk sürümde şerit dışı hücreler `INF_DIST` ile doldurulmadığı için kısa kökler (`dü`, `düz`, `e`, `milis`) uzun kelimelerde sahte uzaklık `0` okuyordu. `slab.fill(INF_DIST, nextOff, nextOff + stride)` + `Math.abs(cand.length - L) <= maxEdits` korumasıyla tamamen giderildi.
4. **Düşük düzenleme cezası (`-2.3 * editCost`) ile agresif 2-düzenleme tetiklemesi:**
   - Sık 2-düzenlemeli kelimeler, 1-düzenlemeli yer değiştirmelerin (`transposition` `flag@1`: `17.9% → 8.9%`) önüne geçiyordu. Bayes kanal cezası `-3.6 * editCost - 1.8 * I[foldedEdits >= 2]` ve temiz 1-düzenleme yer değiştirmelerinde 2-düzenlemeyi atlama kuralıyla `transposition` `fixed + flag@1` yeniden **%100.0** oldu.
5. **Bağlam yeniden sıralamasında ham `lexicon.count()` kullanımı:**
   - `context.onnx` `features[0..2]` alanında `düzenlemiyor` için `count=2`, `düzenleniyor` için `count=146` gördüğünden `hatalarını duzenlemniyor` için `düzenleniyor`'u kıl payı öne alıyordu. Yalnızca işaret yeniden sıralamasında öncül-bilinçli `priorAwareLexicon` + `0.65 * coreScore` birleşimiyle (otomatik düzeltme v3 kalibrasyonuna hiç dokunmadan) hem çekirdekte hem bağlam modelinde `düzenlemiyor` 1. sıraya oturdu.

---

## 6. Açık Kalan Riskler ve Dürüst Değerlendirme

1. **Gerçek kelimeyle çakışan yazım hataları (biçimbilimin kabul ettiği hatalar):**
   - `dev typo` içindeki kaçırılan `%3,0` (ör. `isleyicilerinin`, `seçilerinin`, `eşeme`) ve `handwritten misspelling` içindeki `%5,0` (`direk`, `makinası`) Zemberek biçimbilimi tarafından geçerli Türkçe kelime kabul edildiği için yordamsal algılama bunları işaretlemez. Bunların yakalanması ileride tüm cümle üzerinde bağlam modeli tabanlı "gerçek-kelime anomali tespiti" (RTD / düşük olasılıklı belirteç işaretlemesi) gerektirir.
2. **İki hatalı `double_omission` önerilerinde top-1 vs top-5:**
   - `double_omission` sınıflarında yakalama **%100**, top-5 başarısı **%85–93** olmasına karşın, 2 harf eksik kısa kelimelerde (`eeli → emekli`, `soyl → sosyal`, `sıcıydı → sıkıcıydı`) çok sayıda yakın 1-düzenleme rakip olduğu için top-1 oranı bağlamsızda %69–80 bandındadır (bağlam modeliyle `odd` yarıda **%87.5** `fixed + flag@1`'e çıkar).
3. **Yoğun hatalı metinlerde `inspect()` hızı:**
   - Karışık `dev`/`dev2` metinlerinde ortalama **107 µs/kelime**, temiz konuşma dilinde **61 µs/kelime** (≤ 120 µs sınırının altında). Ancak neredeyse her cümlesi çift hatalı sentetik stres setlerinde (`synth`, 155 µs/kelime) 2-düzenleme FST araması sık çağrıldığı için süre yükselir. Gerçek kullanıcı belgelerinde yazım hatası yoğunluğu %1–3 olduğundan tarayıcıda akıcı (~60–90 µs/kelime) çalışacaktır; ayrıca `fuzzySearch` 4.096 girdilik önbellekle tekrarlı taramalarda neredeyse ücretsizdir.
4. **Tekrarlı tarama ve arayüz entegrasyonu:**
   - `site/src/` arayüzüne bu görev kapsamında dokunulmamıştır. Claude arayüzde `autr.inspect(text, options)` çağrısını bağlarken `fixes` (otomatik düzeltme) ile `flags` (alt çizgi + öneri menüsü) dizilerinin asla çakışmadığına ve `from/to` UTF-16 konumlarının `check()` ile aynı olduğuna güvenebilir.
