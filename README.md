# autr: tarayıcıda, internetsiz çalışan Türkçe otomatik düzeltme

Durum (2026-11-21):
- **Kural motoru** (`src/`) çalışıyor.
- **npm paketi** (`pkg/`) ve **internetsiz yazı sitesi** (`site/`, SolidJS 2.0 + mizan) çalışıyor; site tarayıcıda, sunucu kapalıyken test edildi.
- İlk **bağlam modeli** eğitildi ama devreye alınmadı: henüz anlamlı bir fayda göstermedi (aşağıda).

## Klasörler
| Klasör | İçerik |
|---|---|
| `src/` | Düzeltme motoru: sözlük, kurallar, bağlam modeli arayüzü |
| `pkg/` | `autr` npm paketi: `loadAutr()`, `check`/`fix`/`apply`, Web Worker, isteğe bağlı bağlam modeli (onnxruntime-web). Gemini Neon yazdı, Claude derleyip test etti. |
| `site/` | İnternetsiz Türkçe yazı uygulaması: SolidJS 2.0, Tiptap, mizan (pano-ui) stilleri (`site/src/vendor/mizan`, güncelleme: `bash site/scripts/sync-mizan.sh`), service worker. Gemini Neon yazdı. |
| `py/` | Sözlük, test seti ve bağlam modeli eğitim betikleri |
| `bench/` | Ölçüm: `run.ts` (doğruluk), `typing.ts` (yazarken tutarlılık), `examples.ts` |

## Ne yapıyor
Her kelime için, yazılan biçimin Türkçe metinde ne kadar sık geçtiğini, aşağıdaki düzeltme adaylarının sıklığıyla karşılaştırır. Bir aday ancak açık bir farkla öndeyse kelimeyi değiştirir. Aşağıdaki örneklerin hepsi `node bench/examples.ts` ile doğrulandı.

| Tür | Örnek |
|---|---|
| Türkçe karakter | cok → çok, nasil yaptigini → nasıl yaptığını |
| Kesme işareti | Ankaraya → Ankara'ya |
| Bitişik yazılmış | Birşey → Bir şey, geldinmi → geldin mi, arenasıda → arenası da, diyorki → diyor ki |
| Ayrı yazılmış | hiç bir → hiçbir, Oysa ki → Oysaki, Yerler de → Yerlerde |
| Klavye hatası | yapabiliur → yapabilir, konlarda → konularda |
| Bilinen yazım yanlışı | herkez → herkes, malesef → maalesef, herkezin → herkesin |

Henüz düzeltemediği örnekler:
- **"Istanbul":** Vikipedi'de İngilizce "Istanbul" da geçiyor.
- **"gelyorum":** Vikipedi'de birinci tekil kişi neredeyse yok.
- **"sende/ben de", "oldu/öldü" gibi belirsiz durumlar:** Bilerek dokunulmuyor; bunlar bağlam modelinin işi.

## TDK uyumu
Kesme işareti kuralları, TDK'nın Kesme İşareti sayfasındaki şu maddelere göre yazıldı:
- Yapım ekleri ve çoğul eki özel isimden ayrılmaz: Konyalı, Mehmetler, Türklerin, Türkçenin.
- Kurum adlarına gelen ekler ayrılmaz: Türk Dil Kurumundan.

Devlet ve coğrafya adları ise kesme alır (Osmanlı Devleti'ndeki, Çanakkale Boğazı'nın). Biçimden kurum adı mı coğrafya adı mı olduğu anlaşılamadığı için, iyelik ekiyle biten bu tür adlara motor kesme **eklemiyor**. Bu bilinçli olarak bırakılmış bir eksik: yanlış düzeltme yapmıyor, ama bu durumları düzeltmiyor da.

ki ve de/da kuralları ve kelime listesi TDK'dan henüz doğrulanamadı; ilgili sayfalar 404 verdi.

## Bilinen yazım yanlışları (`data/rules/`)
- **`neon-lists-v1.md`:** Gemini 4 Neon'un yazdığı ham liste.
- **`known.tsv`:** Vikipedi sayılarıyla doğrulanan 599 kural. Doğru biçim en az 20 kez ve yanlış biçimden en az 10 kat sık geçiyorsa kabul ediliyor.
- **`review.tsv`:** 225 kural incelemeyi bekliyor. Çoğu eski ya da alternatif yazım (makina/makine, metod/metot, öğe/öge); bunlar üslup kararı.
- **"illaki":** TDK'dan doğrulanamadığı için dışarıda bırakıldı.

Bu kurallar yalnızca küçük harfli kelimelerde veya cümle başında uygulanıyor, cümle ortasındaki özel isimlerde değil ("Birgün" gazetesi bu yüzden korunuyor).

## Çalıştırma
Bağımlılıkları kurmak:
```bash
npm install
```
Türkçe Vikipedi'yi indirmek (yaklaşık 550 MB):
```bash
mkdir -p data/raw/trwiki && cd data/raw/trwiki && curl -LO https://huggingface.co/datasets/wikimedia/wikipedia/resolve/main/20231101.tr/train-00000-of-00002.parquet && curl -LO https://huggingface.co/datasets/wikimedia/wikipedia/resolve/main/20231101.tr/train-00001-of-00002.parquet
```
Sözlüğü çıkarmak (yaklaşık 3 dakika):
```bash
uv run --project py python py/build_lexicon.py
```
Test setlerini üretmek:
```bash
uv run --project py python py/make_tests.py
```
Bilinen yanlışlar listesini doğrulamak:
```bash
uv run --project py python py/verify_lists.py data/rules/neon-lists-v1.md
```
Ölçmek (`dev` üzerinde ayar yapılır, `test` yalnızca rapor içindir):
```bash
node bench/run.ts dev --min-pair 5
```
Örnek cümleleri denemek:
```bash
node bench/examples.ts "Yarın Ankaraya gidiyorum."
```

## Test setleri
- **`bench/dev`, `bench/test`:** Vikipedi'den, sözlüğe hiç girmemiş %2'lik belge diliminden üretildi. Her cümlede tek bir yapay hata var. **Bu sonuçlar olduğundan iyi görünür:** hataları üreten kalıplar, motorun kurallarıyla aynı kalıplar. Ayrıca kelime sıklıkları da aynı kaynaktan geliyor.
- **`bench/handwritten/neon-v1.jsonl`:** Gemini 4 Neon'un yazdığı 265 gerçekçi günlük cümle. Kaçırdığı örnekleri inceledim ve kuralları buna göre ayarladım; ayrıca yazım yanlışları listesini de aynı model yazdı. Bu yüzden artık **bağımsız bir test seti değil, ikinci bir dev seti**. Anadili Türkçe biri tarafından gözden geçirilmeli.
- **`bench/sealed/neon-v2.jsonl`:** Hiç açılmamış, 265 cümlelik ikinci Neon seti. Konular farklı: spor, sağlık, kira, veli mesajları, oyun forumu, müşteri hizmetleri. Yalnızca özet tablo çalıştırılır; kaçırdığı örneklere bakılmaz. Bakılırsa artık mühürlü sayılmaz ve yeni bir set gerekir.

## Gerçekçi günlük metin: mühürlü set (2026-11-21)
| Tür | Düzeltilen cümle | Doğruluk |
|---|---|---|
| bilinen yazım yanlışı ve klavye hatası | %78 | %92 |
| soru eki | %68 | %87 |
| ki | %65 | %93 |
| ayrı/bitişik | %53 | %94 |
| Türkçe karakter (cümlenin tamamı doğru) | %53 | %98 |
| kesme işareti | %50 | %83 |
| de/da | %43 | **%70** |
| **Hatasız cümleler (60)** | 2 cümlede değişiklik, 1.000 kelimede 2,9 | |

Notlar:
- Yazım yanlışları listesini ve bu seti aynı model yazdı. Bu yüzden %78 muhtemelen gerçeğinden iyi.
- de/da en zayıf tür. Doğruluğun %70'te kalması, yapılan her 10 değişiklikten 3'ünün yanlış olduğu anlamına geliyor. Bağlam modeli gelene kadar de/da kuralları daha temkinli ayarlanmalı.
- Örneklem küçük: sınıf başına 20 ile 40 cümle.

## Sonuçlar (test bölümü, 2026-11-21, `--min-pair 5`)
"Doğruluk" sütunu, değişikliklerin her biri tek başına uygulandığında cümleyi doğru biçime yaklaştıran değişikliklerin oranı.

| Tür | Düzeltilen cümle | Doğruluk |
|---|---|---|
| ayrı/bitişik (hiç bir, birşey…) | %97 | %97 |
| Türkçe karakter, tek kelime | %84 | %99 |
| bulunma eki ayrı yazılmış (yerler de → yerlerde) | %84 | %97 |
| ki | %80 | %95 |
| klavye hatası | %67 | %94 |
| soru eki (38 örnek) | %58 | %100 |
| tüm cümle Türkçe karaktersiz (cümlenin tamamı doğru) | %55 | %99 |
| de/da bitişik yazılmış (arenasıda → arenası da) | %53 | %93 |
| kesme işareti | %39 | %95 |

**Hatasız metin:** Dev bölümündeki hatasız cümlelerde yapılan 31 değişikliği tek tek etiketledim:
- 20'si Vikipedi'nin kendi hatalarının düzeltilmesiydi.
- 11'i yanlış alarmdı. Bu, yaklaşık **2.300 kelimede bir** yanlış değişiklik demek.

Gerçekçi günlük metinde (Neon v1, 60 hatasız cümle) 3 yanlış alarm çıktı; üçü de Vikipedi'de geçmeyen geçerli konuşma dili biçimleri ("yorumumu", "ilettim", "kahven").

## Tarayıcı için boyut
| Sözlük | Boyut (gzip) | Hatasız metinde yanlış alarm (1.000 kelimede) |
|---|---|---|
| Tüm kelimeler, en az 5 kez geçen kelime çiftleri | 12,5 MB | 1,2 |
| En az 5 kez geçen kelimeler | 8,8 MB | 1,6 |
| En az 20 kez geçen kelimeler | 6,7 MB | 3,1 |

Kelime çiftlerini budamak hiçbir şeye mal olmuyor. Kelimeleri budamak ise yanlış alarmları artırıyor. Sonuç: düz metin yerine sıkıştırılmış bir sözlük yapısı ve geçerli ekli biçimleri tanıyan bir biçimbilim katmanı gerekiyor.

## Konuşma dili kısaltmaları (seçenek, varsayılan kapalı)
"noldu → ne oldu", "burda → burada", "yapacam → yapacağım" gibi biçimler çoğu zaman bilerek yazıldığı için ayrı bir seçenek.

- **Liste:** `data/rules/known.tsv` dosyasında "CONTRACTION" bölümünde 58 kural var.
  - 21'i mevcut listeden taşındı; Gemini Neon işaretledi (`data/rules/reviews/neon-contractions-v1.tsv`): "burda", "nerde", "ordan", "içerde", "diil", "dakka".
  - 37'si madencilikten geldi: "noldu", "napıyorsun", "istiyon", "yapacam", "bitane".
- **Kapalıyken** bu kelimelere hiçbir kural dokunmuyor. Örneğin "noldu" klavye hatası sanılıp "oldu" yapılmıyor.
- **Açıkken** ayrı bir türle raporlanıyor: motorda `contraction`, pakette `kisaltma`.
- **Paket:** `kinds` içinde `"kisaltma"` verilirse açılıyor; `DEFAULT_FIX_KINDS` onu içermiyor.
- **Site:** Ayarlar → Düzeltme türleri → "Konuşma dili kısaltmaları".

Kapalıyken ölçümler değişmedi. Konuşma setindeki değişiklikler 1.000 kelimede 7,22'den 6,70'e indi, çünkü kısaltmalar artık korunuyor; ikinci geçişte değişen cümle oranı %0. Açıkken bu sette 7,31.

## Biçimbilim katmanı ve yanlış madenciliği (2026-11-21)

### Biçimbilim katmanı (`src/morphology/`)
Gemini Neon yazdı, Claude bağlayıp test etti. Zemberek'in (Apache 2.0, atıf `src/morphology/NOTICE.md`) kök sözlüğü (`data/morph/`) ve biçim kurallarından uyarlanmış bir sonlu durum makinesi. `isWord(biçim)` bir kelimenin Türkçe ek kurallarına göre geçerli olup olmadığını söylüyor.
- **Kesinlik:** Bilinen yanlışların %2,7'sini geçerli sayıyor; bunlar çoğunlukla Zemberek sözlüğündeki eski yazımlar ("sarmısak", "hastahane").
- **Kapsam:** Yaygın biçimlerin %69'unu tanıyor; kalanlar çoğunlukla özel isim ve yabancı kelime.
- **Hız:** Kelime başına 5,6 µs, sözlük yükleme 64 ms.

Motordaki kullanımı:
- Sözlükte nadir ama ek kurallarına göre geçerli bir kelime, klavye hatası sayılmıyor ve ek yerinden bölünmüyor: "getirsek", "kitabımı", "öyküsüz" korunuyor.
- Tersine, hiç görülmemiş ve ek kurallarına göre geçersiz küçük harfli bir kelimede klavye hatası eşiği 3'ten 1,5'e iniyor. Bu, klavye hatası düzeltmesini %63'ten %71'e çıkardı. Fazladan yapılan değişiklikleri etiketledim, yaklaşık %70'i doğru.
- Bilinen yanlışlar listesi biçimbilimden önce çalışıyor; "yada", "şuan" gibi biçimbilimin geçerli saydığı yanlışlar yine düzeltiliyor.

**Henüz pakette ve sitede değil:** Sözlük verisi yaklaşık 800 KB düz metin. Boyut aşamasında eklenecek.

### Yanlış madenciliği (`py/mine_misspellings.py` → `bench/filter-candidates.ts` → inceleme → `bench/apply-review.ts`)
1. **Aday:** Altyazıda en az 20 kez geçen, Vikipedi'de neredeyse hiç geçmeyen ve tek harf farkla çok daha yaygın bir ikizi olan biçimler. OCR hataları ve Türkçe karakter eksikleri çıkarıldı. Sonuç: 2.565 aday.
2. **Biçimbilim süzgeci:** Geçerli çekimler ("yapıyordun", "görmen") çıkarıldı; 526 aday kaldı.
3. **Gemini Neon incelemesi** (`data/rules/reviews/neon-mined-v1.tsv`): 175 yazım yanlışı, 37 konuşma dili kısaltması ("noldu", "napıyorsun"), 36 ünlem ("eveet"), 105 özel isim, 60 OCR hatası, 105 belirsiz.
4. **Otomatik doğrulama:** Doğru biçim yaygın ve geçerli olmalı, yanlış biçim geçersiz olmalı. Sonuç: 171 satır `data/rules/known.tsv` listesine "MINED" etiketiyle eklendi. Örnekler: "heralde → herhalde", "seyehat → seyahat", "felan → falan", "teşekürler → teşekkürler", "sizinde → sizin de", "oldumu → oldu mu".
5. **Sözlüğün yeniden kurulması:** Konuşma sözlüğü yeniden kuruldu; listedeki yanlışlar artık altyazıdan "geçerli" olarak alınmıyor.

Konuşma dili kısaltmaları ("noldu → ne oldu") bilinçli bir üslup olduğu için listeye **alınmadı**. İstenirse `--categories yazim,kisaltma` ile eklenebilir.

**Ölçümler** (bu tur sonunda): dev'de klavye hatası %71, soru eki %38, hatasız metinde 1.000 kelimede 1,20 değişiklik. Neon v1'de kesme işareti %80, yazım yanlışı %70, hatasız cümlelerde değişiklik yok. Mühürlü sette yazım yanlışı %87,5, diğer türler bir önceki turla aynı ya da 1 cümle farkla. Doğruluk tüm türlerde %93 ve üzerinde. Tutarlılık: ikinci geçişte %0,03.

## Konuşma dili sözlüğü (2026-11-21)
`py/build_conversational.py`, Vikipedi sözlüğüne Türkçe OpenSubtitles'tan (OPUS, 50 milyon kelimelik bir dilim) konuşma biçimleri ekliyor ve `data/work/unigrams_conv.tsv` dosyasını yazıyor. Bu artık varsayılan sözlük; benchmark araçlarında `--lexicon wiki` ile eskisi seçilebilir.

**Altyazılar da hatalı.** Bu yüzden bir biçim ancak şu şartlarla alınıyor:
- Bilinen yanlışlar listesinde (ekli halleri dahil) değil.
- Türkçe karakter farkıyla 5 kat daha sık geçen bir biçimi yok ("karimla" alınmaz).
- 30'dan az geçiyorsa, tek harf farkla 50 kat daha sık geçen bir biçimi yok ("seyehat" türü tek tük hatalar alınmaz).
- Sonu ek gibi olan biçimler (ki, soru eki) ancak altyazıda ayrı yazılışından en az 3 kat sık geçiyorsa alınıyor ("olduğumu" alınır, "gelebilirmiyim" alınmaz). de/da ile biten biçimler hiç alınmıyor.
- Vikipedi'de 20'den fazla geçen kelimelerin sayısı değişmiyor. Böylece birleştirme ve bölme oranları bozulmuyor.

Sonuç: 237 bin biçim kabul edildi, bunların 93 bini yeni.

Aynı turda iki kural değişikliği daha yapıldı:
- 6 harf ve üzeri kelimelerde son harfi değiştiren klavye hatası düzeltmesi kapatıldı. Bunlar neredeyse hep kişi ekini değiştiriyordu: "düşünmüştün → düşünmüştüm".
- Sözlükte en az 20 kez geçen birleşik biçimler ek yerinden bölünmüyor: "istediğimi → istediği mi" bölünmüyor.

**Ölçümler:**

| | Vikipedi sözlüğü | Konuşma sözlüğü |
|---|---|---|
| Konuşma dilinde hatasız metin (`bench/conversation/clean.jsonl`, altyazıdan ayrılmış 3.000 cümle): 1.000 kelimede değişiklik | 9,6 | 7,6 |
| Neon v1, hatasız cümlelerde değişiklik | 5,7 | 0 |
| Neon v1, soru eki | %76 | %88 |
| Neon v1, Türkçe karakter | %67,5 | %75 |
| Dev (Vikipedi) | — | tüm türlerde aynı ya da daha iyi |

**Konuşma setindeki değişikliklerin etiketlenmesi:** Altyazılar hatalı olduğu için bu sette yapılan değişikliklerin çoğu gerçek düzeltme: "dogum → doğum", "fazka → fazla", "hapisane → hapishane", "tabiki → tabii ki". Değişiklikleri türe göre etiketledim:
- Kalan yanlış alarmlar çoğunlukla geçerli fiil çekimlerinde klavye hatası düzeltmesi ("ekmemi → etmemi", "getirsek → getirmek") ve konuşmada bağlaç olan de/da'nın birleştirilmesi ("İkinizin de → İkinizinde").
- Tahmini yanlış alarm: 1.000 kelimede yaklaşık 0,8. Etiketlemeden türetildi, tam sayım değil.
- de/da birleştirmesine ek maliyet koymayı denedim: konuşma setindeki değişiklikleri pek azaltmadı ama gerçek de/da düzeltmelerini %86'dan %53'e düşürdü. Bu yüzden uygulanmadı.

**Mühürlü set** (`bench/sealed/neon-v2.jsonl`, yalnızca özet tablo çalıştırıldı; ilk ölçüm → şimdi, düzeltilen / doğruluk):

| Tür | İlk ölçüm | Şimdi |
|---|---|---|
| de/da | %43 / %70 | %47 / %93 |
| Soru eki | %68 / %87 | %84 / %100 |
| ki | %65 / %93 | %85 / %100 |
| Yazım yanlışı* | %78 / %92 | %85 / %100 |
| Türkçe karakter | %53 / %98 | %68 / %99 |
| Kesme işareti | %50 / %83 | %50 / %100 |
| Ayrı/bitişik | %53 / %94 | %50 / %100 |
| Hatasız cümleler | 1.000 kelimede 2,9 | 1.000 kelimede 2,9 |

\*Bu set ile bilinen yanlışlar listesini aynı model yazdı; bu satır muhtemelen gerçeğinden iyi.

**Lisans:** OpenSubtitles verisi araştırmada yaygın kullanılıyor, ama ticari kullanım durumu net değil. Dağıtılan şey metin değil, kelime sayıları. Yine de ürüne koymadan önce karar verilmeli.

## Bağlam modeli (pilot, devrede değil)
`py/context_data.py` → `py/train_context.py`. Harf tabanlı küçük bir evrişimli ağ: 372 bin parametre, Vikipedi'den 780 bin örnek, M1'de 71 dakika. Belirsiz durumlarda (bende/ben de, oldu/öldü, sevgimi/sevgi mi, evdeki/evde ki) adaylardan hangisinin bağlama uyduğuna puan veriyor.

- **Doğrulama setinde:** "her zaman daha sık geçen biçimi seç" kuralı %98,4, model %98,6, ikisi birlikte %98,9 doğru. Sıklık kuralının yanıldığı zor örneklerin %46'sını model doğru buluyor.
- **Benchmark'ta** (`node bench/run.ts dev --context … --context-threshold N`), dev bölümü, adaylar eğitimle aynı koşullara sınırlandıktan sonra (küçük harf, en az 5 harf, en az 5 kez geçen kök):

  | Eşik | Türkçe karakter | de/da ayrık | de/da bitişik | Hatasız metinde değişiklik (1.000 kelimede) |
  |---|---|---|---|---|
  | model yok | %83,5 | %86,0 | %53,0 | 1,28 |
  | 8 | %84,8 | %86,0 | %53,0 | 1,28 |
  | 5 | %87,0 | %87,7 | %54,7 | 1,40 |

- **Etiketleme:** Eşik 5'te, sınırlamadan önce fazladan yapılan 9 değişikliğin yalnızca 1'i doğruydu ("ıbn → ibn"). Yanlışlar: "aksamı → akşamı", "uç → üç", "akısı → akışı". İlk ölçümdeki büyük zarar ise entegrasyon hatasından geliyordu: modele eğitimde hiç görmediği adaylar soruluyordu ("gemi → ge mi").
- **Sonuç:** Eşik 8'de zararsız ama faydası çok küçük, eşik düşünce yanlış Türkçe karakter kararları veriyor. Sitede varsayılan olarak kapalı.
- **Sonraki deneme için:**
  - Modele "yazılan biçim hangisi" bilgisini ve sözlük sıklığını girdi olarak vermek.
  - Eğitimdeki hata oranını gerçek kullanıma yaklaştırmak.
  - Vikipedi'nin tamamını ve konuşma dili metnini kullanmak.
  - Başarıyı, sabit bir yanlış alarm oranında doğrulukla ölçmek.

## Yazarken tutarlılık
`node bench/typing.ts dev --lag 0,1 --settle`, siteyle aynı şekilde kelime kelime yazmayı taklit ediyor ve sonucu cümlenin tek seferde düzeltilmesiyle karşılaştırıyor.
- Dev setinde sonuçlar %98,3 ile %98,9 oranında aynı. Neon v1 setinde %97,4 ile %99,2.
- Kalan fark iki sebepten geliyor:
  - "hiç bir" gibi birleştirmeler sonraki kelimeyi görmeden yapılamıyor; 1 kelime gecikmeyle düzeliyor.
  - Türkçe karaktersiz yazım kanıtı bazen cümlenin ilerisinde.
- Gecikme ve cümle sonu kontrolü düzeltme oranını artırmadı (gecikmesiz yazım %69,3, 1 kelime gecikmeyle %69,1). Bu yüzden önerilmiyor. "hiç bir" için daha dar bir çözüm yeterli: yeni kelime bitince yalnızca bir önceki kelimeyle birleştirmeye bakmak; kullanıcının geri aldığı bir düzeltmeyi tekrar uygulamadan.
- **Kararlılık** (`node bench/idempotence.ts`): Düzeltilmiş metni ikinci kez düzeltmek dev setinde 4.398 cümlenin yalnızca 1'ini (%0,02), Neon v1 setinde 265 cümlenin 1'ini değiştiriyor. Yani editörün her kelime sınırında motoru yeniden çalıştırması metni kaydırmıyor.

## Sıradaki adımlar
Önce doğruluk ve tutarlılık, sonra boyut (kullanıcı kararı, 2026-11-21).
1. **İnsan incelemesi.** `data/rules/known.tsv` dosyasının "MINED" bölümü ve `data/rules/reviews/neon-mined-v1.tsv` dosyasındaki 105 belirsiz satır.
2. **Biçimbilim katmanını pakete ve siteye eklemek.** Boyut çalışmasıyla birlikte yapılacak.
3. **Site hataları.** İki ilerleme göstergesinin farklı değer göstermesi; ayar değişince panelin kayması; Cmd+Z'nin boşluğu da silmesi; ayar değişince sözlüğün baştan yüklenmesi; yazarken "hiç bir" birleştirmesinin tetiklenmemesi.
4. **Bağlam modeli v2.** Ancak doğrulama puanlarında, yazılan doğruyken değiştirme oranı ile yazılan yanlışken düzeltme oranı arasında kullanılabilir bir eşik varsa denenmeli.
5. **Boyut.** Sıkıştırılmış sözlük, 8-bit model, ONNX Runtime yerine saf JS çalıştırma. Hedef toplam 5 MB'ın altı. Konuşma sözlüğü kelime sayısını 1,15 milyondan 1,25 milyona çıkardı.
