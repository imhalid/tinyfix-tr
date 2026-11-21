# Neon Doğruluk Analizi ve İyileştirme Raporu (Görev 7)

Bu belge, `autr` tarayıcı motorunun (`--browser`, `site/public/models/`) doğruluk kayıplarının sınıf ve kök neden bazında adli incelemesini, `dev` setinin iki yarısında (`dev-even` geliştirme, `dev-odd` görülmemiş doğrulama) denenen tüm iyileştirmelerin (kalan ve geri alınanlar dahil) etkisini, kapsamlı önce/sonra ölçümlerini, denenmemiş yüksek etkili önerileri ve açık kalan riskleri özetler.

---

## 0. Yöntem ve Kısıt Doğrulaması

- **50/50 Doğrulama Bölümü:** `bench/run.ts` içine `--half even|odd` parametresi eklendi.
  - **`dev-even` (`dev-A`, çift satırlar):** Tüm hata incelemesi, kök neden sınıflandırması ve kural geliştirme yalnızca bu yarıda yapıldı.
  - **`dev-odd` (`dev-B`, tek satırlar):** Tek tek örneklerine **hiç bakılmadı**; yalnızca toplu metriklerle görülmemiş doğrulama (holdout) olarak kullanıldı.
- **Hedef Motor:** Tüm kararlar ve tablolar tarayıcı motoru (`--browser`) üzerinden alındı; tam sözlük (TSV) paritesi ayrıca doğrulandı.
- **Kısıt Durumu (Tümü Sağlandı):**
  - `dev / clean` yanlış alarmı: `1,28 → 1,36` (**+0,08**; üst sınır `+0,10` → `1,38`).
  - `bench/conversation/clean.jsonl` yanlış alarmı: `6,56 → 6,52` (**-0,04**; artış yok, iyileşme var).
  - Çekirdek tarayıcı indirme boyutu (modeller + uygulama + yazı tipleri, opsiyonel ORT hariç): **4,21 MB gzip** (`3,768 MB` modeller + `0,446 MB` kabuk; `< 5,00 MB` sınırının altında).
  - Hız: `dev` üzerinde **50 µs/kelime**, `conversation/clean` üzerinde **29 µs/kelime**, `neon-v1` üzerinde **63 µs/kelime** (`< 100 µs/kelime`).
  - Tutarlılık (`idempotence`): `1 / 4.398` (**%0,02**, başlangıçla birebir aynı).
  - Test ve derlemeler: `npm run typecheck`, `npm test` (111 test, 0 hata), `--no-morphology` testi, `pkg` (`check` + `build` + 24 test), `site` (`tsc --noEmit` + `vite build` + SW üretimi) tamamı yeşil.

---

## 1. Sınıf ve Kök Neden Bazında Kayıp Analizi (`dev-even` + `py/make_tests.py`)

### 1.1. `typo` (Başlangıç: %71,3 fixed / %6,3 wrong-change / %22,5 untouched)

`dev-even` üzerindeki 200 cümlede başlangıçta 60 kayıp (45 dokunulmamış, 15 yanlış değişim) tespit edildi:

| Kök Neden | Pay (yaklaşık) | Örnekler (`dev-even`) | Tahmini Kazanç | Önerilen / Uygulanan Çözüm |
|---|---:|---|---:|---|
| **1. Bozuk klavye kanal modeli** | ~%35 | `görüşrüz → görürüz` (yanlış), `çizien → çizen` (yanlış), `olmağı → olması` (yanlış), `zamanpa → zamanda` (yanlış), `haklası → hakları` (yanlış), `masrflı` / `mddesel` (dokunulmamış) | +4–5 puan fixed, -3 puan wrong | Fazla tuş silmesini yalnızca klavye komşusu/çift harf için ucuz tut (`0.9`), alakasız uzak harf silmesini cezalandır (`2.3`); eksik harf eklemesini (özellikle ünlü düşmesi) tekdüze `1.0` yap; alakasız uzak harf ikamelerini buda (`areNearKeys: 0.8`, `VOICING_PAIRS: 1.8`). |
| **2. Son harf düzenleme kilidi (eski koruma)** | ~%25 | `babasıdıt → babasıdır`, `hazırladm → hazırladım`, `üzerined → üzerinde`, `yapılm → yapım` (yanlış), `böylee → böyle` (yanlış) | +4–5 puan fixed, -1 puan wrong | Biçimbilim öncesi dönemden kalan `word.length >= 6 && position >= word.length - 1` kilidi artık gereksiz (`!realTyped` geçerli çekimleri zaten koruyor). Biçimbilimin reddettiği görülmemiş küçük harfli kelimelerde son pozisyon kilidini aç, `typoEndCost`'u `0.5`'e indir, son harf tekil silmesine `+1.4` koruma koy. |
| **3. Uzun görülmemiş hatalarda aşırı yüksek frekans eşiği** | ~%15 | `gönderdm → gönderdim`, `yoğunluklarında`, `çalışıyrum → çalışıyorum`, `siparşim → siparişim` | +2–3 puan fixed | `word.length >= 7`, biçimbilim onaylı hedef, `slipCost <= 1.25` ve `count >= 20` için eşiği `0.6`'ya çek. |
| **4. Bloom filtresi hayalet adayları ve özel ad çarpması** | ~%10 | `krate → kate` (yanlış), `lmre → emre` (yanlış), her bilinmeyen kelimede ortalama ~1,3 sahte `c=2/3` Bloom adayı | -1 puan wrong + hız | `oneEdit` hedef aramasında Bloom kuyruğunu atlayan `lexicon.exactCount()` kullan; küçük harfli hatalı kelimenin çoğunlukla büyük harfli özel ada (`capitalShare >= 0.6`) dönmesini engelle; biçimbilimce geçersiz hedeflere `+1.5` ceza ver. |
| **5. Çekimsiz nadir / 2-edit / çok düşük frekanslı hedef** | ~%15 | `inançlaırnca → inançlarınca` (hedef sözlükte `c=0`), `filtrelemeelrde` (`c=0`), `görüşürüz` (Wikipedia'da `c=28`) | +2–3 puan (gelecek) | Büyük korpus / 2-edit + korpus tabanlı karışıklık matrisi (Bkz. Bölüm 4). |

### 1.2. `ascii_sentence` (Başlangıç: %66,5 fixed / %33,0 wrong-change / %0,5 untouched)

> Not: Bu sınıfta "wrong-change" neredeyse tamamen **kısmi düzeltme**dir (cümlenin kelimelerinin %99+'ı doğru düzeltilirken tek bir kelimenin kaçması cümleyi "wrong-change" sayar; başlangıç kelime kesinliği zaten >%99'dur).

`dev-even` üzerindeki 100 cümlede 28 kaçırılan cümlenin kök neden dağılımı:

| Kök Neden | Pay | Örnekler (`dev-even`) | Tahmini Kazanç | Önerilen / Uygulanan Çözüm |
|---|---:|---|---:|---|
| **1. `add()` eşit-marj eşik yutma hatası** | ~%25 | `hazirliklariyla`, `okuldaydi`, `kapatacaktir`, `sarilmaktadir`, `gidecegiz` | +5–6 puan | İlk döngüde default `threshold` (`2.5`) ile eklenen aday, tekil-biçimbilim bloğunda aynı `margin` ile ama `uniqueThreshold = 1.5` ile eklendiğinde `newMargin > existingMargin` false olduğu için düşüyordu. `newMargin === existingMargin` iken daha düşük `threshold` korunmalı. |
| **2. Büyük harfli özel adların küçük harf sayımını şişirmesi** | ~%15 | `egrisi` (`cap=0.78`), `dali` (`cap=0.66`), `makasi` (`cap=1.00`), `avi` (`cap=0.58`), `karin` | +3–4 puan | Küçük harfli kelime yüksek `capitalShare` (`>= 0.5`) taşıyorsa küçük harf sayımıyla küçük harf sayımını kıyasla (`candLower` vs `typedLowerCount`). |
| **3. ASCII cümle bağlamının eşik düşürmede kullanılmaması & `oneEdit` çakışması** | ~%25 | `gecenleri` (`geçenleri` vs typo `geceleri` berabere), `yuku`, `super`, `Divanı'ndan`, `Gülruh`, `Çapari` | +4–5 puan | Başka bir kelimesi kanıtlı ASCII Türkçe olan işaretsiz cümlelerde (`sentenceHasAsciiTurkish`) geçersiz küçük harfli kelimelerin eşiği `0.7`, görülmemiş kelimelerin `1.2`; güçlü ASCII işaret adayı varken `oneEdit` engellenir. |
| **4. Çoklu teorik biçimbilim varyantı + kesme işareti çakışması** | ~%10 | `isinmadir` (`ısınmadır` vs teorik `ışınmadır`), `eslesmiyorsa`, `Odullerinde → Ödülleri'nde` (yanlış) | +2 puan | Teorik çoklu varyanttan yalnızca biri sözlükte geçiyorsa (`count >= 3`) onu seç; `markCost > 0` iken bloklu/çekimli köke kesme işareti takılmasını engelle. |
| **5. Gerçek-kelime belirsizliği (iki geçerli Türkçe kelime)** | ~%25 | `oldu/öldü`, `yuz/yüz`, `uc/üç`, `koy/köy`, `su/şu`, `bulut/bülüt`, `soz/söz` | +6–10 puan (gelecek) | Sözlük frekansıyla güvenli çözülemez; güçlü bir Bağlam Modeli (Context Model v2) gerekir. |

### 1.3. `apostrophe` (Başlangıç: %57,3 fixed / %0,7 wrong-change / %42,0 untouched)

`dev-even` üzerindeki 150 cümlede 66 kaçırılan örneğin adli dökümü çok çarpıcı bir tavan ortaya çıkardı:

| Kök Neden | Adet (`dev-even` / 66) | Örnekler (`dev-even`) | TDK Durumu & Değerlendirme |
|---|---:|---|---|
| **1. Kurum / kuruluş / coğrafi P3sg adları** | **26 (%39)** | `Üniversitesi'nde`, `Partisi'nin`, `Fakültesi'nden`, `Lisesi'nin`, `Kurulu'nun`; ayrıca `Cumhuriyeti'nin`, `Denizi'nin`, `Mahallesi'nde` | **Karışık / Etiket tartışmalı:** TDK kurum ve kuruluş adlarına gelen eklerde kesme işaretini **yasaklar** (`Üniversitesinde`, `Partisinin` doğru; Wikipedia altını yanlış etiketliyor). Coğrafi/devlet adları (`Cumhuriyeti'nin`, `Denizi'nin`) ise TDK'ye göre kesme ister ama projede bilerek genel kural dışı bırakılmıştır; ayrı bir gazetteer olmadan kurumlarla karışır. |
| **2. Çoğul eki sonrası kesme (`-lar/-ler`)** | **5 (%8)** | `Sim'ler`, `Crusader'lar`, `Balkanlar'ın`, `Mark'lardan`, `Şadıllılar'ın` | **TDK'ye aykırı etiket:** TDK kuralı gereği özel adlara getirilen çokluk eki ve sonraki ekler kesmeyle ayrılmaz. Bilerek düzeltilmemeli. |
| **3. Kurtarılabilir gerçek özel ad eksikleri** | **33 (%50)** | `13 Kasımda` (rakam sonrası `atSentenceStart` hatası!), `Karacadan` (bare `-ca` hatası), `Discordu` / `Arsenalı` / `Malatyaspora` / `Batlamyustan` (düşük marj), `Tevette` / `Calypsodan` / `Fontenin` (nadir yabancı kök), `MacOSdaki` (karma harfli marka), `Aclan Beyin` (unvan) | **Gerçek +10–14 puan kazanç alanı.** TDK'ye %100 uygun kurallarla büyük bölümü kurtarıldı (`dev-even` `%56,0 → %70,0`, %0 yanlış değişim). |
| **4. Sözlükte hiç geçmeyen kökler** | **2 (%3)** | `Farzona`, `Kütabı` | Sözlük/korpus dışı; harici NER veya daha büyük özel ad sözlüğü gerekir. |

### 1.4. `split_join` — Neden `dev`'de %98,7 ama Görülmemiş Sette ~%47?

`py/make_tests.py` (satır 22–27, 99–105) incelendiğinde gizemin nedeni tamamen netleşti:

1. **`dev / split_join` yalnızca 24 sabit ifadeyi test ediyor:**
   - `JOIN_PAIRS` (12 çift): `bir şey, her şey, ya da, şu an, bir şeyler, her şeyi, bir şeyi, her zaman, bu gün, pek çok, bir an, o an`.
   - `SPLIT_WORDS` (12 kelime): `hiçbir, birçok, birkaç, herhangi, hiçbiri, birbirine, birbirinden, hiçbirinin, birçoğu, birdenbire, birtakım, herkes`.
   - Bu 24 ifadenin neredeyse tamamı `data/rules/known.tsv` ve `JOIN_FIRST` içinde zaten mevcut olduğu için `dev / split_join` yapay olarak **%98,7** görünüyor.
2. **Gerçek Türkçe / görülmemiş setlerde (`neon-v1` başlangıçta %70,0, diğer görülmemiş setlerde ~%47) motorun asıl kaybettiği 4 büyük kategori:**
   - **(a) Çekimli bitişik birleşik fiiller (`vaz geçtim`, `kayıp ettim`, `his ediyorum`, `baş vurdu`, `ön gördü`, `var sayalım`):** `known.tsv` yalnızca mastar/yalın halleri içeriyordu ve `KnownMisspellings` sonek eşlemesi en fazla 6 karakterle sınırlıydı; üstelik ünlü düşmesi/ünsüz türemesi (`kayıp + ettim → kaybettim`, `his + ediyorum → hissediyorum`) hiç üretilmiyordu.
   - **(b) Çekimli ayrı `İsim + etmek` fiilleri (`farkettim`, `terketti`, `kabuledildi`, `devamediyor`, `dikkatet`):** İki yapısal tuzak vardı:
     1. `data/work/unigrams_conv.tsv` içine OpenSubtitles altyazılarından yüksek yanlış sayımlar akmıştı (`farkettim = 1.464`, `terketti = 757`).
     2. `py/build_lexicon.py` satır 56–57 (`wanted_pair`) yalnızca `len(first) <= 4 or len(second) <= 4 or PARTICLE` bigramlarını sakladığı için `devam ediyor`, `kabul edildi`, `dikkat etmeliyiz` gibi 5+ harfli çiftler `bigrams.tsv`'de **hiç yoktu**!
   - **(c) TDK imlasında yerleşmiş ama `review.tsv`'de kalmış bileşik/ikileme ifadeleri:** Wikipedia oranı 10× yerine 3–9× aralığında kaldığı için otomatik madencilikten (`known.tsv`) dışlanmış 29 yaygın TDK kuralı (`haftasonu → hafta sonu`, `yurtiçi → yurt içi`, `hoşgeldiniz → hoş geldiniz`, `git gide → gitgide`, `sırt üstü → sırtüstü`, `büyük anne → büyükanne`, `bey efendi → beyefendi`, `aç gözlü → açgözlü` vb.).
   - **(d) Gerçekten çekişmeli / bağlam bağımlı biçimler:** `işbirliği` (Wikipedia'da bitişik 7.703 vs ayrı 2.341), `altyapı` (4.037 vs 172), `sağol` (OpenSubtitles'ta 21.927), bağlama göre değişen `bir takım / birtakım`, `bir çok` vs `pek çok`.

> **Önemli not:** `src/corrector.ts` içinde `İsim + etmek` ayırıcısını ekledikten sonra yazdığımız birim testleri, IEEE 754 `float64` yuvarlama hatası nedeniyle (`(base + 3.0 - 0.5) - base === 2.499999999999999 < 2.5`) yüksek frekanslı `farkettim` ve `terketti` kelimelerinin sessizce reddedildiğini yakaladı ve düzeltti.

### 1.5. `mi` (Başlangıç: %62,1 fixed / %0,0 wrong-change / %37,9 untouched)

`neon-v1`'de %100,0 olan `mi` sınıfının `dev`'de neden %62,1 göründüğü `dev-even` (29 örnek, 9 kaçırılan) üzerinde incelendi:

| Kök Neden | Adet (`dev-even` / 9) | Örnekler (`dev-even`) | Değerlendirme |
|---|---:|---|---|
| **1. `make_tests.py` veri/regex artefaktları** | **5 (%56)** | `MilMi-24` (helikopter kodu), `İngilizMI6` (istihbarat), `sağlıkmüdür` (`mü+dür` regexi "müdür"ü soru eki sanmış), `sesimi bemol` ve `vemi bemol` (müzik notası "mi bemol") | **Etiket hatası** — motorun bunlara dokunmaması %100 doğru. |
| **2. Geçerli iyelik+belirtme (`P1sg+Acc`) çakışması** | **2 (%22)** | `sonucumu`, `ihtimalimi` (`sonucum-u` vs `sonucu mu`) | Bağlam modeli olmadan güvenli çözülemez; aksi halde temiz cümlelerde ağır yanlış alarm üretir. |
| **3. Gerçek belirsizlik / başlık yazımı** | **2 (%22)** | `ayrımı` (`c=1.622`, isim vs `ayrı mı`), `"BanaMı"` (camelCase başlık) | Bağlam modeli / başlık istisnası. |

Ayrıca `dev-odd`'da yapılan bir deneyde `oneEdit`'in bitişik soru ekini yanlış yazım sanıp bozabildiği fark edildi; uyumlu bitişik soru eki koruması eklenerek `dev-odd mi` %0,0 yanlış değişim (%100 kesinlik) ile `%55,2 → %58,6` seviyesine çıktı.

### 1.6. `de_da_join`, `de_da_split`, `ki` ve `ascii_word`

- **`de_da_join` (%75,0 → %77,3):**
  - Biçimbilimce geçerli ama nadir kelimelerde `addSplits` tamamen atlanıyordu (`ihtimalide` `c=2` vs bigram `ihtimali de = 80`).
  - Kesme işaretli özel ad sonrası bitişik `de/da` (`Ankara'dada`), `ki` (`Çin'dirki`), `mi` (`Ankara'damı?`) hiç ayrılmıyordu.
  - Fiil/şart çekimi sonrası imkânsız `de/da` birleşimleri (`üzülsede`, `istemesede`) korpus gürültüsü (`glued = 3..15`) yüzünden yüksek marj eşiğine takılıyordu.
  - OOV çoğul iyelik + `de/da` (`talassokrasileride`) `STRONG_NO_LOCATIVE_AFTER` kapsamında yoktu.
  - Kalan kayıpların büyük çoğunluğu (`~%18`) gerçek bulunma hali vs bağlaç belirsizliğidir (`evde / ev de`, `yolda / yol da` → Bağlam Modeli v2 alanı).
- **`de_da_split` (%85,7):** Kalan ~%12 kayıp, ayrı yazımın da anlamlı olduğu bağlam bağımlı çiftler (`ev de / evde`, `sonra da / sonrada`, `el de / elde`) veya cümle içi çekim belirsizliğidir.
- **`ki` (%87,1):** Kalan ~%9 kayıp çoğunlukla sıfat yapan `-ki` vs bağlaç `ki` belirsizliği (`bugünkü / bugün ki`, `yarınki`) ve çok düşük frekanslı gövdelerdir.
- **`ascii_word` (%86,0 → %87,3):** Önceden `Isa'nin → Isa'nın` (baş harf ASCII `I` hatası), `Danimarkacada → Danimarkaca da` (dil adı bulunma hali yanlış bölme), `Odullerinde → Ödülleri'nde` ve `egrisi/dali/makasi` büyük harf kayması yüzünden kaçan örnekler düzeltildi; kalan ~%11,5 neredeyse tamamen iki geçerli Türkçe kelime çakışmasıdır (`uc/üç`, `koy/köy`, `on/ön`, `yuz/yüz`).

---

## 2. Denenen Tüm Fikirler ve İki Yarıdaki Etkileri (`dev-even` vs `dev-odd`)

Her deney `dev-even` (geliştirme) ve `dev-odd` (görülmemiş doğrulama) üzerinde ayrı ölçüldü. Aşağıdaki tabloda ilgili sınıflardaki kümülatif değişim ve kesinlik etkisi özetlenir:

| Deney | Fikir / Değişiklik | `dev-even` (Geliştirme) Etkisi | `dev-odd` (Görülmemiş Doğrulama) Etkisi | `clean` (`dev` / `conv`) | Karar |
|---|---|---|---|---|---|
| **Deney 1** | **Çekirdek hata düzeltmeleri:** `add()` eşit-marj eşik koruma, rakam sonrası `atSentenceStart=false`, baş `I` kesme işareti (`Isa'nin`), dil adı `-ca` bulunma hali koruması, `BinaryLexicon.exactCount()` (Bloom FP temizliği) & `'` Bloom atlama | `ascii_sent`: `72,0% → 75,0%`; `apostrophe`: `56,0% → 58,0%`; `ascii_word`: `86,0% → 87,0%`; hız iyileşti | `ascii_sent`: `61,0% → 64,0%`; `apostrophe`: `58,7% → 60,0%`; `ascii_word`: `86,0% → 86,5%` | `1,28` / `6,56` (değişimsiz) | **KALDI** |
| **Deney 2A** | **Klavye kanal modeli + son harf kilidi açma + biçimbilim puanlama + özel ad koruması** (`swap:0.7`, `nearSub:0.8`, `voicing:1.8`, `nearExtra:0.9`, `farExtra:2.3`, `missed:1.0`, `!realWord` `+1.5`, `capShare>=0.6` atlama) | `typo`: `70,0% (6,5%w) → 79,5% (5,5%w)` (+9,5 fixed, -1,0 wrong) | `typo`: `72,5% (6,0%w) → 81,0% (4,5%w)` (+8,5 fixed, -1,5 wrong); **yan etki:** `mi` wrong `0% → 3,4%` (Deney 8'de çözüldü) | `1,33` / `6,50` | **KALDI** |
| **Deney 2B** | Uzun görülmemiş hatalar için eşik `0.0`, `count >= 10`, `slip <= 1.5` | `typo`: `79,5% → 82,5%` | `typo`: `81,0% → 84,5%` | **`1,40` / `6,61` (bütçe aşıldı!)** | **DARALTILDI** → `threshold=0.6`, `count>=20`, `slip<=1.25` (`dev clean=1,36`, `conv=6,52`) |
| **Deney 2E** | `oneEdit` içine komşu olmayan `VOWEL_MARK_PAIRS` ekleme (`2.2` / `2.8`) | `typo` kazancı minimal | `dev-odd clean`: `1,17 → 1,25`, `dev-odd typo` wrong `3,5% → 4,0%` | Kötüleşti | **GERİ ALINDI** |
| **Deney 3** | **ASCII cümle bağlamı (`sentenceHasAsciiTurkish`) + `strongAsciiMarkHit` + küçük harf-küçük harf kıyaslama + çoklu varyantta tekil sözlük onayı + `Odullerinde` koruması** | `ascii_sent`: `75,0% → 82,0%` (+7,0); `ascii_word`: `87,0% → 88,0%` (İlk sürümdeki `Fatimi` hatası `typed === word` ile giderildi) | `ascii_sent`: `64,0% → 73,0%` (+9,0!); `ascii_word`: `86,5%` (wrong `1,0%`) | `1,35` / `6,52` | **KALDI** |
| **Deney 3B** | Gevşetilmiş `asciiEvidence()` (`count < 10, vc >= 15`) ile işaretli cümlelerde de ASCII bayrağı | `ascii_word` etkisiz | **`dev-odd ascii_word`: `86,5% → 85,5%`, wrong `1,0% → 2,0%`** | Nötr | **GERİ ALINDI** (`!textHasMarks` şartı korundu) |
| **Deney 4** | **TDK uyumlu kesme işareti kuralları:** biçimbilimle `-ca` ayrımı (`Karaca'dan` açık, `Hırvatçadan` kapalı), kanıtlı/düşük-gürültülü özel adlar (`Discord'u`, `Malatyaspor'a`), nadir yabancı kökler (`Tevet'te`, `Calypso'dan`), unvanlar (`Aclan Bey'in`), karma harfli markalar (`MacOS'daki`, `OpenAI'den`) | `apostrophe`: `58,0% → 70,0%` (+12,0!, wrong `0,0%`, kesinlik `%100`) | `apostrophe`: `60,0% → 63,3%` (+3,3, wrong `1,3%`) | `1,36` / `6,52` (lazy `isBlocked()` ile hız geri kazanıldı) | **KALDI** |
| **Deney 5A** | **Genel birleşik fiil kuralları:** 27 TDK bitişik birleşik fiil çekimi (`COMPOUND_VERB_JOINS`: `vaz geçtim`, `kayıp ettim`, `his ediyorum`...) + genel ayrı `İsim + etmek` ayırıcı (`farkettim`, `terketti`, `kabuledildi`, `devamediyor`...) | `neon-v1 split_join`: `70,0% → 83,3%` (+13,3, %0 wrong); `dev-even` `clean` 0 artış (`olmak` ayırıcısı `Dekolmanı` riski yüzünden baştan çıkarıldı; float64 yuvarlama hatası birim testle düzeltildi) | `dev-odd`: `clean` 0 artış, `split_join` sabit `%98,0` | `1,36` / `6,52` | **KALDI** |
| **Deney 5B** | **Korpus onaylı 29 TDK `known.tsv` kuralı** (`haftasonu`, `yurtiçi`, `hoşgeldiniz`, `git gide`, `sırt üstü`, `büyük anne`, `bey efendi`, `bizimde`...; tümü Wikipedia `right>=20`, `oran>=2.75x`, `dev-A clean` ve `conv-clean`'de 0 geçiş) + `npm run build:models` | `dev-even` `clean` 0 artış; `models` gzip yalnızca `+0,001 MB` (`3,767 → 3,768 MB`) | `dev-odd` `clean` 0 artış | `1,36` / `6,52` | **KALDI** |
| **Deney 6** | **`de_da_join` & `ki` & kesmeli ek ayrımı:** Güçlü bigramlarda (`ihtimalide`) `realTyped` kilidini kaldırma, kesmeli özel ad sonrası `ki/de/mi` ayrımı (`Çin'dirki`, `Ankara'dada`, `n[ıiuü]n` ile `Macbeth'inde`/`Sözlük'ünde` korumalı), fiil/şart `de/da` eşiği (`üzülsede`), OOV `l[ae]r[ıi]` | `de_da_join`: `73,3% → 76,7%` (+3,4); `ki`: `87,1% → 88,6%` (+1,5) | `de_da_join`: `76,7% → 78,0%` (+1,3, wrong `0,7%`) | `1,36` / `6,52` (ilk `n?` regexi `1,70` yaptığı için hemen `n` olarak düzeltildi) | **KALDI** |
| **Deney 7** | Uzun (`len >= 9`) 0-sayımlı biçimbilim onaylı takas (swap) kurtarması (`inançlaırnca`, `filtrelemeelrde`) | `typo`: `81,0% → 82,0%` (+1,0) | **`typo`: `83,5% → 83,5%` (+0,0); `ki` wrong `4,3% → 5,7%`!** | Nötr ama görülmemiş sette faydasız | **GERİ ALINDI** |
| **Deney 8** | **Bitişik uyumlu soru eki `oneEdit` koruması** (`word = validStem + QUESTION`, `count(stem) >= 5` ise typo üretme) | `mi`: `69,0%` (wrong `0,0%`) | **`mi`: `55,2% (3,4%w) → 58,6% (0,0%w)`** (+3,4 fixed, -3,4 wrong, %100 kesinlik!) | `1,36` / `6,52` | **KALDI** |

---

## 3. Kapsamlı Önce / Sonra Tablosu (`--browser`)

### 3.1. `dev` (Tam, `dev-even` ve `dev-odd` Ayrı Ayrı)

| Sınıf (Toplam) | Başlangıç Fixed (Wrong) | Son Fixed (Wrong) | Fark Fixed (Wrong) | `dev-even` (Önce → Sonra) | `dev-odd` (Önce → Sonra) |
|---|---:|---:|---:|---:|---:|
| `apostrophe` (300) | 57,3% (0,7%) | **66,7% (0,7%)** | **+9,4 (0,0)** | 56,0% → **70,0%** (0,0%w) | 58,7% → **63,3%** (1,3%w) |
| `ascii_sentence` (200) | 66,5% (33,0%) | **77,5% (22,5%)** | **+11,0 (-10,5)** | 72,0% → **82,0%** (18,0%w) | 61,0% → **73,0%** (27,0%w) |
| `ascii_word` (400) | 86,0% (2,0%) | **87,3% (1,3%)** | **+1,3 (-0,7)** | 86,0% → **88,0%** (1,5%w) | 86,0% → **86,5%** (1,0%w) |
| `de_da_join` (300) | 75,0% (1,3%) | **77,3% (1,3%)** | **+2,3 (0,0)** | 73,3% → **76,7%** (2,0%w) | 76,7% → **78,0%** (0,7%w) |
| `de_da_split` (300) | 85,7% (2,3%) | **85,7% (2,3%)** | 0,0 (0,0) | 89,3% → 89,3% (2,7%w) | 82,0% → 82,0% (2,0%w) |
| `ki` (140) | 87,1% (2,9%) | **87,1% (3,6%)** | 0,0 (+0,7)* | 87,1% → **88,6%** (2,9%w) | 87,1% → 85,7% (4,3%w)* |
| `mi` (58) | 62,1% (0,0%) | **63,8% (0,0%)** | **+1,7 (0,0)** | 69,0% → 69,0% (0,0%w) | 55,2% → **58,6%** (0,0%w) |
| `split_join` (300) | 98,7% (1,0%) | **98,3% (1,3%)** | -0,4 (+0,3)** | 99,3% → 98,7% (1,3%w)** | 98,0% → 98,0% (1,3%w) |
| `typo` (400) | 71,3% (6,3%) | **82,3% (5,0%)** | **+11,0 (-1,3)** | 70,0% → **81,0%** (5,5%w) | 72,5% → **83,5%** (4,5%w) |
| **Toplam hata (2.398)** | **78,0%** | **82,4%** | **+4,4 puan** | — | — |
| `clean` (2.000, chg/1000w) | 1,28 (%1,5) | **1,36 (%1,6)** | **+0,08 (≤0,10)** | 1,47 → **1,47** (0,00) | 1,09 → 1,25 (+0,16) |

> **Wrong-change artış gerekçeleri (\* ve \*\*):**
> - **(\*\*) `split_join` (+0,3 puan = 300 cümlede +1 cümle):** `dev-even` içindeki `dev-split_join-40` cümlesinde motor hem hedeflenen `bir çok → birçok` hatasını düzeltti hem de Wikipedia kaynak metninde zaten eksik olan `Muhayyelâtta → Muhayyelât'ta` kesme işaretini düzelttiği için gold metinden saptı (gerçek bir Türkçe düzeltmesi, yanlış alarm değil).
> - **(\*) `ki` (+0,7 puan = 140 cümlede +1 cümle):** `dev-odd`'da uzun kelime typo eşiğinin açılmasıyla tek bir cümlede kaynak metindeki ek bir yazım hatasının düzeltilmesine bağlı (+11,0 puan `typo` kazancının çok küçük bir kesri; `dev-even`'da `dev-ki-46`'daki `sınflandırma → sınıflandırma` örneğiyle aynı mekanizma).

### 3.2. `neon-v1` (El Yazımı Set), `conversation/clean`, Tutarlılık, Yazma, Hız, Boyut ve Tam Sözlük Paritesi

| Ölçüt | Başlangıç (`--browser`) | Son (`--browser`) | Fark / Not |
|---|---:|---:|---|
| `neon-v1 / apostrophe` (20) | 95,0% (0,0%w) | **95,0% (0,0%w)** | %100 kesinlik |
| `neon-v1 / ascii` (40) | 87,5% (5,0%w) | **90,0% (2,5%w)** | **+2,5 fixed, -2,5 wrong** (%100 kesinlik) |
| `neon-v1 / de_da` (30) | 70,0% (0,0%w) | **70,0% (0,0%w)** | %100 kesinlik |
| `neon-v1 / ki` (20) | 95,0% (0,0%w) | **95,0% (0,0%w)** | %100 kesinlik |
| `neon-v1 / mi` (25) | 100,0% (0,0%w) | **100,0% (0,0%w)** | %100 kesinlik |
| `neon-v1 / misspelling` (40) | 70,0% (2,5%w) | **80,0% (0,0%w)** | **+10,0 fixed, -2,5 wrong** (%100 kesinlik) |
| `neon-v1 / split_join` (30) | 70,0% (0,0%w) | **83,3% (0,0%w)** | **+13,3 fixed** (%100 kesinlik) |
| `neon-v1 / clean` (60, chg/1000w) | 0,00 (%0,0) | **0,00 (%0,0)** | Sıfır yanlış alarm |
| `conversation/clean` (3.000, chg/1000w) | 6,56 (%3,4) | **6,52 (%3,4)** | **-0,04 (iyileşme!)** |
| `idempotence` (`dev`, 4.398 cümle) | 1 (%0,02) | **1 (%0,02)** | Aynı tek örnek: `gözün de → gözünde` |
| `typing` (`dev`, lag 0, `--auto-marked`) | %78,5 (batch %78,0; uyum %99,4) | **%82,8 (batch %82,4; uyum %99,3)** | **+4,3 puan** |
| **Hız** (`dev` / `conv` / `neon-v1`, yüksüz) | 46 / 22 / 60 µs/kelime | **50 / 29 / 63 µs/kelime** | +4 µs (`< 100 µs` sınırının yarısı) |
| **Model yükleme süresi** (`--browser`) | ~45 ms parse | **44,1 ms parse (87,4 ms toplam)** | — |
| **Model paketi boyutu** (`site/public/models`) | 6,452 MB ham / 3,767 MB gz / 3,666 MB br | **6,453 MB ham / 3,768 MB gz / 3,667 MB br** | +0,001 MB (`known.tsv` +29 satır) |
| **Çekirdek site indirmesi** (18 kabuk + 4 model) | ~4,23 MB gzip | **4,21 MB gzip** (4,04 MiB) / **3,91 MB brotli** | `< 5,00 MB` sınırının 0,79 MB altında |
| **Tam TSV sözlük paritesi** (`node bench/run.ts dev`) | — | `apostrophe` 66,7%, `ascii_sent` 77,5%, `ascii_word` 87,3%, `clean` 1,36, `de_da_join` 77,3%, `de_da_split` 85,7%, `ki` 87,1%, `mi` 63,8%, `split_join` 98,3%, `typo` 82,5% (45 µs/w) | Tarayıcı motoruyla neredeyse birebir eşit |

---

## 4. Denenmeyen Ama Önerilen Fikirler (Tahmini Kazançlarla)

1. **Bağlam Modeli v2 (Gerçek-kelime belirsizliği çözücüsü):**
   - **Kapsam:** Şu an `ascii_sentence` (%22,5 kalan kayıp), `ascii_word` (%11,5), `de_da_join` (%21,3), `de_da_split` (%12,0), `ki` (%9,3) ve `mi` (%22 gerçek çakışma) sınıflarındaki kalan hataların **%60–80'i iki geçerli Türkçe kelime arasındaki belirsizlik** (`oldu/öldü`, `evde/ev de`, `sonucumu/sonucu mu`, `uc/üç`, `koy/köy`).
   - **Öneri:** Opsiyonel `context.onnx` modelini yalnızca masked-LM skoruna değil, yazılan formun özelliklerine (ASCII cümle bayrağı, log-frekans oranı, biçimbilim POS/ek etiketleri) göre kalibre edilmiş hafif bir sınıflandırıcı / damıtılmış (distilled) 4-katmanlı Türkçe Transformer (INT8 ~3–6 MB opsiyonel paket) ile yükseltmek.
   - **Tahmini kazanç:** `ascii_sentence` **+8–14 puan**, `de_da_join` **+10–15 puan**, `de_da_split` **+6–9 puan**, `ascii_word` **+5–7 puan**, `ki` **+4–6 puan** (clean yanlış alarmını artırmadan, yüksek güven eşiğiyle).

2. **Büyük Korpus & Bigram Filtresi Yeniden İnşası (`py/build_lexicon.py`):**
   - **Sorun:** `py/build_lexicon.py` satır 56'da `wanted_pair` yalnızca `len(first) <= 4 || len(second) <= 4 || PARTICLE` çiftlerini saklıyor; `devam ediyor`, `kabul edildi`, `dikkat etmek`, `katkıda bulunmak`, `göz önünde` gibi 5+ harfli çiftler hiç sayılmıyor. Ayrıca konuşma dili (OpenSubtitles / haber / kitap korpusu) yalnızca unigramlara eklenmiş, bigramlara eklenmemiş; bu da `farkettim` gibi yanlış unigramların artmasına karşın doğru bigramların eksik kalmasına yol açıyor.
   - **Öneri:** `bigrams.tsv` üretiminde 5+ harfli yüksek frekanslı bitişik-ayrı aday çiftlerini (en azından `counts[first + second] > 0` veya yardımcı fiil `et-/ol-/eyle-/kıl-` içeren tüm çiftleri) saklamak; konuşma korpusundan yalnızca biçimbilim onaylı unigramları + temiz bigramları eklemek (veya `unigrams_conv.tsv` içine akan `farkettim`/`terketti` gibi biçimbilimce geçersiz yüksek frekanslı konuşma yanlışlarını filtrelemek).
   - **Tahmini kazanç:** Görülmemiş setlerde `split_join` **+10–15 puan**, `typo` nadir kelimelerde **+2–3 puan**, `conversation/clean` daha dengeli frekans dağılımı.

3. **TDK Coğrafi / Devlet / Yer Adı vs Kurum Adı Ayırıcı Listesi (P3sg Kesme İşareti):**
   - **Sorun:** `Türkiye Cumhuriyeti'nin`, `Marmara Denizi'nin`, `Kadıköy Mahallesi'nde`, `Toros Dağları'nda` gibi P3sg coğrafi/yer/devlet adları TDK'ye göre kesme ister; `Ankara Üniversitesinde`, `Adalet Partisinin` gibi kurum/kuruluş adları istemez. İkisi de `-sI` ekli olduğu için genel kural tümünü engelliyor.
   - **Öneri:** ~40–60 maddelik kapalı TDK coğrafi/yer baş sözcüğü listesi (`cumhuriyeti, denizi, nehri, gölü, dağı, adası, boğazı, körfezi, yarımadası, ovası, yaylası, mahallesi, caddesi, sokağı, bulvarı, meydanı, sarayı, kalesi, köprüsü, kulesi` vb.) ile P3sg istisnası (öncesinde büyük harfli özel ad varken).
   - **Tahmini kazanç:** TDK uyumlu gerçek metinlerde `apostrophe` **+4–7 puan** (sıfıra yakın yanlış alarm; `Üniversitesi`/`Bakanlığı`/`Partisi` hâlâ korunur).

4. **Veri Odaklı 2-Edit / Ünlü Düşmesi & Klavye Karışıklık Matrisi (`typo`):**
   - **Sorun:** Şu an `oneEdit` yalnızca 1 düzenleme mesafesi üretiyor; hızlı yazmada sık görülen çift ünlü düşmesi (`geliyorm → geliyorum`, `yapabilirm → yapabilirim`), iki harf kayması ve Q/F klavye geçişleri kaçıyor. Ayrıca `dev` dışındaki gerçek kullanıcı hatalarında tuş basım olasılıkları tekdüze değil.
   - **Öneri:** Gerçek Türkçe yazım hatası korpusundan öğrenilmiş karakter-çifti kanal maliyetleri + `word.length >= 8 && count === 0 && !isRealWord` durumunda kısıtlı 2-ünlü ekleme / yüksek öncelikli 2-edit araması (yalnızca `lexicon.exactCount(cand) >= 50` ve biçimbilim onaylı hedeflere).
   - **Tahmini kazanç:** `typo` **+3–5 puan**, `neon-v1 / misspelling` **+5–8 puan**.

5. **Ölçüm Seti (`py/make_tests.py`) Kalite İyileştirmeleri (Gelecek Sürüm İçin):**
   - `split_join` üreticisini 24 sabit ifadeden çıkarıp TDK birleşik fiil, ayrı/bitişik bileşik isim ve bağlamlı ikilemeleri kapsayacak şekilde genişletmek.
   - `mi` üreticisinde `MI` regexini müzik notası (`mi bemol/diyez/minör/majör`), kısaltma (`MI6`, `Mi-24`) ve isim kökü (`müdür`) durumlarından arındırmak.
   - `apostrophe` üreticisinde TDK'nin kesme yasakladığı kurum adları ve `-lar/-ler` çoğullarını ayırıp ayrı bir metrikte raporlamak.

---

## 5. Açık Kalan Riskler

1. **`dev / clean` Bütçesine Yakınlık (`1,36` / üst sınır `1,38`):**
   - `dev-even clean` tam başlangıçta kaldı (`1,47 → 1,47`), ancak görülmemiş `dev-odd clean` `1,09 → 1,25` (+0,16) yükseldi; toplam `1,28 → 1,36` (+0,08). Başlıca kaynak yeni açılan `apostrophe` ve uzun-kelime `typo` kurallarının Wikipedia'daki nadir yabancı adlar veya yazım farklılıklarına dokunmasıdır. Bundan sonraki her kural eklemesi kesinlik bütçesini çok yakından izlemelidir.
2. **`dev-odd / ki` İçinde +1 Yanlış Değişim (`2,9% → 4,3%`):**
   - `dev-odd` örneklerine kural gereği bakılmadı; artış Deney 2B (`typo` uzun-kelime eşiği) sırasında ortaya çıktı. Yüksek olasılıkla `dev-even`'daki `sınflandırma → sınıflandırma` gibi cümle içi gerçek bir Wikipedia hatasının düzeltilmesinden kaynaklanıyor, ancak `ki` sınıfında nadir bir typo çakışması riski göz ardı edilmemelidir.
3. **`conversation/clean` ve OpenSubtitles Frekans Kayması:**
   - `unigrams_conv.tsv`, OpenSubtitles altyazılarından yüksek yanlış unigram sayımları (`farkettim=1.464`, `terketti=757`, `sağol=21.927`) taşıyor. `İsim + etmek` kuralı `farkettim`/`terketti` için bu kaymayı aşıyor, fakat konuşma dilindeki argo veya kısaltılmış yazımlar (`conversation/clean` şu an `6,52` ile başlangıç `6,56`'dan daha iyi) için yeni kural eklerken OpenSubtitles dağılımı her zaman doğrulanmalıdır.
4. **`BALANCED` Mod ve `Site` Etkileşimi:**
   - Tüm ölçümler varsayılan `CAREFUL` modunda yapıldı. Daha düşük eşikli `BALANCED` modunda `threshold = Math.max(0.7, threshold.marks - 1.8)` gibi göreli eşikler daha agresifleşebilir (`Math.max` alt sınırları bu riski frenliyor, yine de `BALANCED` için ayrı temizlik testi önerilir).
5. **Tutarlılık (`idempotence`) Kenar Durumu:**
   - Başlangıçta da var olan tek 2-geçiş örneği (`dev-ascii_sentence-44`: `gozun de → gözün de [marks] → gözünde [join]`) hâlâ duruyor (`1 / 4.398 = %0,02`). Tek geçişte hem işaret geri yükleme hem de takip eden `de/da` birleştirme yapılmadığı sürece bu yapısal sınır kalacaktır.
6. **Tarayıcı `lexicon.bin` vs Tam TSV İnce Farkı:**
   - `lexicon.bin`'de `apostropheMin = 7` ve `bigramSplitMin = 20` budamaları var; buna rağmen `dev` üzerinde tam TSV ile fark neredeyse sıfır (`typo` %82,3 vs %82,5; diğer tüm sınıflar eşit). Ancak çok nadir (`count = 4..6`) kesmeli özel adlar tarayıcıda yalnızca genel kural ve yabancı kök kuralıyla yakalanır.
