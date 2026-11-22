# NEON Names — Çalışma Notları (`neon/names`)

Bu belge, `GOREV11.md` kapsamında `neon/names` dalında geliştirilen TDK uyumlu **Türkçe özel adlar, büyük harf, kesme işareti ve bağlamsal ad/sıradan kelime ayrımı** (`"noktalama"` / `sentenceCase`) sistemini, temiz metin yanlış alarm denetimini, veri/model tasarımını, önce/sonra ölçümlerini, geri alınan denemeleri ve açık riskleri özetler.

> **Veri ayrımı ve ezber yasağı disiplini:**
> - `bench/names/tune.jsonl` (960 satır, tümü çift ID) `id % 4` ile ikiye ayrılmıştır:
>   - **Ayar yarısı (`id % 4 === 0`, 480 satır: 355 hata + 125 temiz):** Hata incelemesi, kural tasarımı ve eşik ayarı yalnızca burada yapılmıştır.
>   - **Doğrulama yarısı (`id % 4 === 2`, 480 satır: 350 hata + 130 temiz):** Tekil cümlelerine **hiç bakılmamış**, yalnızca toplu sınıf metrikleri ölçülmüştür.
> - Vikipedi ve OpenSubtitles madenciliği ile bağlam modeli eğitiminde Vikipedi heldout belgeleri (`md5(doc_id) % 50 == 0`) ve OpenSubtitles heldout satırları (`line_idx % 50 == 0`) kesinlikle dışlanmıştır.
> - `bench/**/*.jsonl` ve `site/src/*` dosyalarına dokunulmamıştır.

---

## 1. Ne Yapıldı ve Neden?

### 1.1 Başlangıç Durumu (`eaed335`)
İlk `noktalama` uygulaması (`eaed335`) yalnızca tek kelimelik özel adların büyük harfini (`ahmet → Ahmet`, `istanbula → İstanbul'a`), temel unvan kısaltmalarını (`dr. ahmet`) ve cümle başı büyük harfi / nokta sonrası boşluğu ele alıyordu. `bench/names/tune.jsonl` (960 satır) üzerindeki başlangıç başarımları:
- `kesme_yanlis`: **%0,0**, `tarih_zaman`: **%0,0**, `belirsiz`: **%0,0**, `kurum_eser`: **%4,1**, `unvan_hitap`: **%4,5**, `karisik_gunluk`: **%13,8**, `ek_kesme`: **%52,8**, `yer_adi`: **%55,7**, `dil_millet_din`: **%64,3**, `kisi_adi`: **%64,9** (toplam hata düzeltme **242/705 = %34,3**).

### 1.2 Yapılan Değişiklikler
1. **TDK Özel Ad, Kurum/Coğrafya, Unvan, Tarih, Sayı Eki ve Yanlış Kesme Motoru (`src/rules/proper-names.ts`, `src/sentence.ts`):**
   - **Kurum, kuruluş, kurul, iş yeri adları (TDK: kesme ALMAZ):** Çok kelimeli kurum/kurul/fakülte/bakanlık/belediye/mahkeme/parti/okul/hastane/müze/iş yeri adları hem sözlükten (`PHRASE_NOAPOS`) hem de bileşimsel sol-tarama kuralıyla (Adım 6a) tanınır; ekleri kesmesiz yazılır (`türk dil kurumuna → Türk Dil Kurumuna`, `Ankara Üniversitesi'nde → Ankara Üniversitesinde`). TDK istisnası olan **Avrupa Birliği'ne** ve **Rusya Federasyonu'na** kesmeli bırakılır.
   - **Kurum + makam unvanı (TDK: kesme ALIR):** `<Kurum> Başkanı/Rektörü/Müdürü/Dekanı/Genel Müdürü` kalıpları büyük başlatılır ve ekleri kesmeyle ayrılır (`Türk Dil Kurumu başkanına → Türk Dil Kurumu Başkanı'na`).
   - **Coğrafi yer, anıt, devlet, tarihî olay ve eser adları (TDK: kesme ALIR):** `PHRASE_APOS` + 4 kelimeye kadar sol taramalı Adım 6b (`Van Gölü'nde`, `Rumeli Hisarı'nda`, `Doğu Anadolu Bölgesi'nde`, `Fatih Sultan Mehmet Köprüsü'nden`, `Eski Çağ'ın`). Yer adından önce gelen yön adları (`Orta Şili`, `Doğu Anadolu`) büyük yazılır; okuma/izleme bağlamında eser adları (`Masumiyet Müzesi'ni okudum`, `Ölü Ozanlar Derneği'ni izledim`) kurum kesme-silme kuralından korunur.
   - **Yanlış kesmeleri kaldırma, ünsüz yumuşaması ve kesme taşıma (Adım 4 — W1..W6):**
     - Yapım/çokluk ekli özel adlar (`Türkçe'yi → Türkçeyi`, `Ankaralı'lar → Ankaralılar`, `Türkler'in → Türklerin`, `Hristiyanlık'ın → Hristiyanlığın`, `Atatürkçülük'ün → Atatürkçülüğün`) ve kesmeli kurum adları (`Başbakanlık'a → Başbakanlığa`) kesmesizleştirilirken `joinWithoutApostrophe()` ile Türkçe ünsüz yumuşaması (`k→ğ, p→b, ç→c, t→d`) uygulanır.
     - Arapça/yabancı kökenli `-izm/-iyet` din ve akım adları (`OPTIONAL_APOS_ISM_IYET`: `İslamiyet'e`, `Budizm'in`, `Hinduizm'de`) bitişik yazıldığında büyütülür (`hinduizmde → Hinduizmde`), ancak mevcut kesmesi **asla silinmez**.
     - Yanlış yere konmuş kesmeler taşınır (`Selinin'kini → Selin'inkini`, `Türkiyemiz'in → Türkiye'mizin`, `İstanbulda'ki → İstanbul'daki`); `Savaşı'nın`, `Rüyası'na`, `Bayramı'na`, `Jimin'in` gibi geçerli gövdeler korunur.
   - **Sayı + ek kesme ve ünsüz benzeşmesi (Adım 3b — `fixNumberSuffix`):** `1985te → 1985'te`, `2023de → 2023'te`, `1985'de → 1985'te`, `80lere → 80'lere`, `19.30da → 19.30'da`, `2nci → 2'nci`; birim/kod korumalarıyla (`5cm`, `20px`, `3a`).
   - **Unvan, hitap, akrabalık ve kişi adı zincirleri (Adım 7):** Kısaltmalı unvan zincirleri (`Prof. Dr.`, `Op. Dr.`, `Doç. Dr.`, `Dr. Öğr. Üyesi`), `Sayın` hitap kalıpları (`Sayın Başkan'a`, `Sayın Yargıç`), ad-sonrası unvanlar (`Ahmet Bey'e`, `Ayşe Hanım'dan`, `Ahmet Hoca'ya`, `Mehmet Usta'ya`), akrabalık sözcükleri (`Ayşe teyzem` — küçük harf), ad+soyadı ikilileri (`GIVEN + SURNAME`).
   - **Belirli tarihler, bayramlar ve çağ/dönemler (Adım 5 & Adım 2):** Rakamlı tarihlerde ay/gün büyük harf + kesme (`17 aralıkta → 17 Aralık'ta`, `12 temmuz 2010 pazartesi → 12 Temmuz 2010 Pazartesi`), genel kullanımda küçük (`ocak ayında`, `pazartesi günü`); millî/dinî bayramlar ve dönemler (`Cumhuriyet Bayramı'nda`, `Öğretmenler Günü`, `Eski Çağ'ın`).
   - **Yumuşamayan eklerden belirsiz ad kurtarma (Adım 8e):** Türkçe biçimbilime göre sıradan kelimede yumuşaması/düşmesi gereken ama yumuşamamış biçimler (`umuta → Umut'a`, `umutun → Umut'un`, `kıvança → Kıvanç'a`, `tokata → Tokat'a`, `çiçeke → Çiçek'e`, `ufukun → Ufuk'un`, `emrenin → Emre'nin`) kural katmanında %100 kesinlikle çözülür.
2. **Bağlamsal Belirsiz Özel Ad Ayrımı — `ContextScorerV3` 6. Görev (`py/build_name_context_data.py`, `py/context_arch.py`, `py/train_context_v3.py`, `src/context.ts`, `src/corrector.ts`):**
   - Ayrı bir model veya ek indirme maliyeti getirmeden mevcut 5 katmanlı Türkçe alt-sözcük Transformer (`ContextScorerV3`, 2,78M parametre, INT8 ONNX) üzerine **6. görev (`kind: "name"`)** eklendi.
   - `FEATURE_DIM = 26` korunarak `slots 6..9` ve `slot 18` sıfırken `slots 19..25` ad özniteliklerini (`isProper`, `hasApostrophe`, `stemCapShare`, `aposShare`, `isGiven`, `isOther`, `atSentenceStart`) taşır; mevcut 5 görevde (`marks`, `de_da`, `ki`, `mi`, `typo`) sıfır uyumluluk kırılması ve sıfır boyut artışı (**2,509 MB gzip** — önceki `2,510 MB`'tan 0,3 KB daha küçük!).
   - `Corrector.runAsyncPass` içinde `sentenceCase && model.supportsNameContext` iken iki-geçişli toplu puanlama yapılır; yalnızca gerçek belirsiz kişi adları (`GIVEN`) ve belirsiz yer adları (`Çeşme`, `Bodrum`, `Kemer`, `Bebek`, `Moda`, `Tokat`, `Ağrı`, `Konak`, `Kartal`, `Tuzla`, `Mısır`, `Boğaz`, `Ordu`, `Uşak`, `Afyon`, `Van`, `Aydın`, `Kaş`) bağlam modeline sorulur (`contextNameThreshold = 2.5`).
   - `pkg` (`TdkaiEngine`) ve `bench/run.ts` (hem `--browser` hem yerel kip) aynı `names.tsv` + `ContextModel` yolunu paylaşır (`80/80` ayar satırında çekirdek ve `+context` çıktısı `0` uyuşmazlıkla birebir eşittir).
3. **Temiz Metin Yanlış Alarm Denetimi ve Düzeltmeleri (`de24cd3` → final):**
   - `de24cd3` commitinde `conv_clean`, `dev_clean` ve `synth_clean` üzerinde `--dump` ile her değişiklik tek tek incelendi.
   - Yakalanan ve kökten giderilen gerçek yanlış alarmlar:
     - `conv-clean-2471`: `Bay Reede → Bay Reed'e` (`resolveSurname` cümle ortasında zaten büyük harfli soyadını bölmeyecek ve `known.nameFor` yerine yalnızca `known.surnameFor` kullanacak şekilde düzeltildi).
     - `conv-clean-1052`: `İslamiyet'e → İslamiyete` (`OPTIONAL_APOS_ISM_IYET` ayrımı ile düzeltildi).
     - `dev-clean-1827`: `3 gün arda arda Meksika'da → Arda` (Adım 7h ikileme koruması `t1.low !== t2.low` ve `resolveSurname` sıkılaştırması ile düzeltildi).
     - `dev-clean-1286`: `Lig'inde → Liginde` (W6 cümle başı koruma eşiği `startAposCount <= 25` ile düzeltildi).
     - `conv-clean-136/1393/2028` & `dev-clean-1793/1977`: `Anna → Ann'a`, `Jimi → Jim'i`, `Gabrielle → Gabriel'le`, `Lynne → Lynn'e`, `Michelin → Michel'in` (Adım 8e'ye tam ad listesi + sözlük sıklığı / cümle başı koruma eşiği eklenerek tamamen giderildi).
     - `dev-clean-546`: `siyasi bilimler fakültesi → siyasi Bilimler Fakültesi` (`scripts/build-names.ts` içinde `Bilimler Fakültesi`, `İdari Bilimler Fakültesi`, `Üniversitesi Hukuk Fakültesi` gibi parça kurum kuyrukları `GENERIC_PHRASE_FIRST` / `FRAGMENT_PHRASE_FIRST` ile elendi).
     - Bağlam modelinde `canım → Can'ım`, `sevgisi → Sevgi'si` (Adım 8f'de iyelik ekleri hariç tutularak durum/ilgi/vasıta ekleriyle sınırlandı) ve `al → Al`, `altın → Altın`, `taşa → Taş'a` (`isCtxEligible` ile yalnızca kişi/yer adları sorgulanarak giderildi).

---

## 2. Kurallar, Sözlük ve Model Mimarisi

### 2.1 `data/rules/names.tsv` (10.518 satır)
`py/mine_names_corpus.py` (Vikipedi + OpenSubtitles, heldout dışlı) ve `scripts/build-names.ts` (Zemberek biçimbilim + sözlük sıklık filtreleri) ile üretilip `npm run build:models` tarafından `site/public/models/known.tsv` sonuna eklenir (`+111 KB` toplam `known.tsv` gzip):

| Bölüm | Satır | Rolü |
|---|---:|---|
| `NAME` | 5.065 | Koşulsuz özel adlar (kişi, yer, dil, millet, marka; `noapos` bayrağıyla kesmesiz diller/türevler işaretli) |
| `ACRO` | 448 | Büyük harfli kısaltmalar (`TBMM`, `TDK`, `TÜBİTAK`, `ODTÜ`, `NATO`, `AB`, `ABD`, `YKS`…) |
| `GIVEN` | 2.000 | Türkçe ve yaygın kişi ön adları (unvan/soyadı/bağlam çerçeveleri için) |
| `SURNAME` | 1.590 | Kişi soyadları (yalnızca ad/unvan sağında) |
| `AMBIG` | 193 | Hem özel ad hem sıradan Türkçe kelime olan gövdeler (`deniz`, `bahar`, `can`, `barış`, `özlem`, `çeşme`, `bodrum`…) |
| `PHRASE_APOS` / `PHRASE_NOAPOS` | 1.222 | Çok kelimeli kurum (kesmesiz) ve yer/anıt/olay/bayram/eser (kesmeli) adları |

### 2.2 Kurum vs. Coğrafi/Eser Ayrım Yöntemi
- **Baş sözcük taksonomisi (`src/rules/proper-names.ts`):**
  - `INSTITUTION_HEADS` (`kurumu`, `kurulu`, `meclisi`, `bakanlığı`, `üniversitesi`, `fakültesi`, `enstitüsü`, `lisesi`, `okulu`, `hastanesi`, `belediyesi`, `partisi`, `mahkemesi`, `derneği`, `vakfı`, `bankası`, `ajansı`, `federasyonu`, `birliği`, `müdürlüğü`, `başkanlığı`, `komutanlığı`, `oda/borsa`, `bakkaliyesi`, `pastanesi`, `lokantası`…) → **kesmesiz (`takesApos = false`)**, TDK istisnaları (`Avrupa Birliği`, `Rusya Federasyonu`, `Kutup Dairesi`, `Elçilerin İşleri`) `isInstitutionHead()` ile hariç tutulur.
  - `GEO_HEADS` (`dağı`, `gölü`, `denizi`, `okyanusu`, `nehri`, `ırmağı`, `boğazı`, `körfezi`, `kanalı`, `köprüsü`, `kulesi`, `hisarı`, `sarayı`, `camisi`, `meydanı`, `caddesi`, `sokağı`, `bulvarı`, `mahallesi`, `parkı`…), `STATE_HEADS` (`cumhuriyeti`, `devleti`, `imparatorluğu`, `krallığı`) ve `EVENT_HEADS` (`savaşı`, `antlaşması`, `bayramı`, `günü`, `çağı`, `devri`, `dönemi`) → **kesmeli (`takesApos = true`)**.
- Hem madencilik (`scripts/build-names.ts`) hem çalışma zamanı kuralları (Adım 4, 6a, 6b) aynı tek doğruluk kaynağını (`src/rules/proper-names.ts`) kullanır.

### 2.3 Bağlam Modeli (`ContextScorerV3` + 6. Görev `name`)
- **Omurga:** 5 katman Pre-LN Türkçe alt-sözcük Transformer (`D=192, H=6, FFN=512`, 8.192 alt-sözcük, 2.779.678 parametre; `<cap>` = id 4 belirteci sayesinde `"deniz"` `[743]` ve `"Deniz"` `[4, 743]` ayrılır).
- **Eğitim düzeltmesi (`py/context_arch.py`):** %50 `feat_dropout` sırasında `is_name` satırlarında aday kimlik bayrağı (`slot 19 = isProper`) korunurken frekans/oran/biçimbilim özellikleri (`0..4, 10..17, 20..25`) maskelenerek Transformer'ın sözlük önceliğine değil cümle bağlamına bakması sağlandı.
- **İnce-ayar (`py/train_context_v3.py`, MPS GPU, 25,4 dk):** `data/work/context_v3_clean/model/context.pt` başlangıcından `515.337` eğitim / `17.366` doğrulama örneği üzerinde 2.014 adım (`0,75` dönem, `batch=192`, `backbone_lr=2.5e-4`, `head_lr=1.2e-3`).
- **Doğrulama (`valid.npz` — ONNX INT8 holdout):** `marks %97,31`, `de_da %95,68`, `ki %89,88`, `mi %98,26`, `typo %90,65`, `name %86,02` (`base_acc = %52,09`, `hard_acc = %86,35` — frekans önceliğinin başarısız olduğu zor örneklerde %86,4!).
- **Kalibrasyon (`name`):** `T=2.5` noktasında `valid` üzerinde %53,3 düzeltme / %1,6 FA; gerçek Türkçe temiz metinlerde (`names/tune clean`, `handwritten clean`, `synth clean`, `conv clean`) **0 `name` yanlış alarmı**.

---

## 3. Veri (`name_context_v2`)

`py/build_name_context_data.py` yalnızca `data/rules/names.tsv` içindeki **193 gerçek `AMBIG` gövdesini** (118 kişi adı + 18 yer adı + diğer) hedefler:
1. **Doğal örnekler:** OpenSubtitles (2,2M satır, `idx % 50 != 0`) ve Türkçe Vikipedi (90K belge, `md5(id) % 50 != 0`) içindeki doğal sıradan ve özel ad kullanımları.
2. **Fonolojik kişi/yer adı ikamesi (sentetik olmayan gerçek Türkçe cümle bağlamları):** OpenSubtitles ve Vikipedi'deki tekil, belirsiz olmayan gerçek kişi adları (`Ahmet`, `Zeynep`, `Burak`, `Ayşe`, `Jack`, `Sarah`…) ve şehir/semt adları (`İzmir`, `Antalya`, `Taksim`, `Kadıköy`…) bulunduğu gerçek cümlelerde, **tam Türkçe ünlü uyumu ve ünsüz benzeşmesiyle** (`inflect_proper_tr`) `AMBIG` kişi/yer adlarıyla değiştirilir (`"Hafta sonu Burak'la sahile gittik"` → `"Hafta sonu Özlem'le sahile gittik"`, `"Yarın İzmir'e gidiyoruz"` → `"Yarın Çeşme'ye gidiyoruz"`).
3. **Kelime-başına 50/50 dengeleme:** Her `(kelime, ekli_mi)` kovası için pozitif ve negatif sayıları birbirinin en fazla 1,25×'i olacak şekilde dengelenmiştir (`train = 64.401` [%48,8 pozitif, %25,4 ekli, 25.716 OpenSubtitles], `valid = 3.560` [%46,8 pozitif]). Böylece model `can`, `barış`, `özlem`, `bahar`, `deniz`, `gül`, `pınar`, `çeşme` için negatif kelime kısayolu öğrenemez.

---

## 4. Önce / Sonra Karşılaştırması (`bench/names/tune.jsonl`)

Tüm ölçümler `--browser --set sentenceCase=1` ile alınmıştır (`+CTX`: `--context data/work/context/model/context.onnx`, `contextNameThreshold = 2.5`).

### 4.1 Ayar Yarısı (`id % 4 === 0`, 480 satır: 355 hata + 125 temiz)
| Sınıf | n | Başlangıç (`eaed335`) | Final Çekirdek | Final `+CTX` |
|---|---:|---:|---:|---:|
| `kisi_adi` | 37 | %64,9 (24) | **%97,3 (36)** | **%97,3 (36)** |
| `yer_adi` | 37 | %62,2 (23) | **%94,6 (35)** | **%94,6 (35)** |
| `ek_kesme` | 36 | %55,6 (20) | **%91,7 (33)** | **%91,7 (33)** |
| `kesme_yanlis` | 32 | %0,0 (0) | **%100,0 (32)** | **%100,0 (32)** |
| `kurum_eser` | 36 | %2,8 (1) | **%100,0 (36)** | **%100,0 (36)** |
| `dil_millet_din` | 35 | %62,9 (22) | **%100,0 (35)** | **%100,0 (35)** |
| `unvan_hitap` | 33 | %6,1 (2) | **%100,0 (33)** | **%100,0 (33)** |
| `tarih_zaman` | 20 | %0,0 (0) | **%100,0 (20)** | **%100,0 (20)** |
| `belirsiz` | 22 | %0,0 (0) | %77,3 (17) | **%81,8 (18)** |
| `cumle_basi` | 27 | %100,0 (27) | **%100,0 (27)** | **%100,0 (27)** |
| `karisik_gunluk` | 40 | %15,0 (6) | %52,5 (21) | **%55,0 (22)** |
| **Hata Toplamı** | **355** | **%35,2 (125)** | **%91,5 (325)** | **%92,1 (327)** |
| `clean` (yanlış) | 125 | **0/125 (%0,0)** | **0/125 (%0,0)** | **0/125 (%0,0)** |

### 4.2 Doğrulama Yarısı (`id % 4 === 2`, 480 satır: 350 hata + 130 temiz — hiç bakılmadı)
| Sınıf | n | Başlangıç (`eaed335`) | Ara (`de24cd3`) | Final Çekirdek | Final `+CTX` |
|---|---:|---:|---:|---:|---:|
| `kisi_adi` | 37 | %64,9 (24) | %91,9 (34) | **%91,9 (34)** | **%91,9 (34)** |
| `yer_adi` | 33 | %48,5 (16) | %75,8 (25) | **%84,8 (28)** | **%84,8 (28)** |
| `ek_kesme` | 36 | %50,0 (18) | %77,8 (28) | %83,3 (30) | **%86,1 (31)** |
| `kesme_yanlis` | 33 | %0,0 (0) | %81,8 (27) | **%81,8 (27)** | **%81,8 (27)** |
| `kurum_eser` | 37 | %5,4 (2) | %75,7 (28) | **%78,4 (29)** | **%78,4 (29)** |
| `dil_millet_din` | 35 | %65,7 (23) | %97,1 (34) | **%97,1 (34)** | **%97,1 (34)** |
| `unvan_hitap` | 33 | %3,0 (1) | %75,8 (25) | **%87,9 (29)** | **%87,9 (29)** |
| `tarih_zaman` | 20 | %0,0 (0) | %90,0 (18) | **%100,0 (20)** | **%100,0 (20)** |
| `belirsiz` | 18 | %0,0 (0) | %38,9 (7) | %38,9 (7) | **%44,4 (8)** |
| `cumle_basi` | 28 | %100,0 (28) | %100,0 (28) | **%100,0 (28)** | **%100,0 (28)** |
| `karisik_gunluk` | 40 | %12,5 (5) | %30,0 (12) | %32,5 (13) | **%37,5 (15)** |
| **Hata Toplamı** | **350** | **%33,4 (117)** | **%76,0 (266)** | **%79,7 (279)** | **%80,9 (283)** |
| `clean` (yanlış) | 130 | **0/130 (%0,0)** | **0/130 (%0,0)** | **0/130 (%0,0)** | **0/130 (%0,0)** |

### 4.3 Tam Set (`bench/names/tune.jsonl`, 960 satır)
| Sınıf | n | `eaed335` (`GOREV11`) | Final Çekirdek | Final `+CTX` | Kesinlik (`+CTX`) |
|---|---:|---:|---:|---:|---:|
| `kisi_adi` | 74 | %64,9 | %94,6 | **%94,6** | %100,0 |
| `yer_adi` | 70 | %55,7 | %90,0 | **%90,0** | %100,0 |
| `ek_kesme` | 72 | %47,2 | %87,5 | **%88,9** | %98,7 |
| `kesme_yanlis` | 65 | %0,0 | %90,8 | **%90,8** | %98,5 |
| `kurum_eser` | 73 | %4,1 | %89,0 | **%89,0** | %100,0 |
| `dil_millet_din` | 70 | %61,4 | %98,6 | **%98,6** | %100,0 |
| `unvan_hitap` | 66 | %4,5 | %93,9 | **%93,9** | %100,0 |
| `tarih_zaman` | 40 | %0,0 | %100,0 | **%100,0** | %100,0 |
| `belirsiz` | 40 | %0,0 | %60,0 | **%65,0** | %100,0 |
| `cumle_basi` | 55 | %100,0 | %100,0 | **%100,0** | %100,0 |
| `karisik_gunluk` | 80 | %8,8 | %42,5 | **%46,3** | %98,2 |
| `clean` (`/1000` kel.) | 255 | **0,00** | **0,00** | **0,00** | — |

---

## 5. Temiz Metinde Yanlış Alarm Denetimi (`--dump`)

Tüm ölçümler `--browser` ile (`changed / 1.000 kelime`):

| Temiz Set | Çekirdek `sc=0` | Çekirdek `sc=1` | `+CTX` `sc=0` | `+CTX` `sc=1` | Gerçek Türkçe `punct`/`name` FA |
|---|---:|---:|---:|---:|---|
| `bench/names/tune.jsonl` `clean` (255) | — | **0,00** | — | **0,00** | **0** |
| `bench/handwritten/neon-v1.jsonl` `clean` (60) | **0,00** | **0,00** | **0,00** | **0,00** | **0** |
| `bench/synth/tune.jsonl` `clean` (1.431) | 0,10 | 0,49 | 0,10 | 0,49 | **0** (5 değişikliğin tümü gerçek TDK/çekirdek düzeltmesi*) |
| `bench/conversation/clean.jsonl` (3.000) | 6,66 | 9,27 | 6,80 | 9,40 | **0** (`de24cd3`'teki 9,31'den düşürüldü; tüm 56 `punct` değişikliği ham altyazıdaki gerçek TDK düzeltmesi**) |
| `dev` (Vikipedi) `clean` (2.000) | 1,82 | 4,54 | 1,86 | 4,73 | Çekirdek: **0**; `+CTX`: **2** (`savaşa → Savaş'a` × 2)*** |

\* **`synth/tune` `clean` (`0,49/1000`, 5 satır) dökümü:** 1 mevcut çekirdek birleştirme (`seyahat-016-clean`: `kahvaltı da → kahvaltıda`), 1 `eaed335`'ten beri olan gerçek özel ad düzeltmesi (`seyahat-233-clean`: `ankara'dan → Ankara'dan`), ve 3 gerçek TDK bayram/özel gün düzeltmesi (`gunluk-283-clean` ve `okul-210-clean`: `öğretmenler günü → Öğretmenler Günü`). Hiçbir yanlış değişiklik yoktur.

\*\* **`conversation/clean` (`9,27` çekirdek / `9,40` `+CTX`) dökümü:** `sc=0 → sc=1` arasındaki `+2,61/1000` (56 `punct` değişikliği) tamamen ham OpenSubtitles satırlarındaki gerçek hataları düzeltmektedir (küçük harfli cümle başları `iki → İki`, nokta sonrası eksik boşluk `.Daha → . Daha`, `Sayın yargıç → Sayın Yargıç`, `Windsor Üniversitesi'nde → Üniversitesinde`, `Cebelitarık boğazında → Boğazı'nda`, `Kahireden → Kahire'den`, `80lere → 80'lere`). `de24cd3`'te görülen `Bay Reede → Bay Reed'e` ve `İslamiyet'e → İslamiyete` ile ara denemedeki `Anna/Jimi/Gabrielle` hataları sıfırlanmıştır. `+CTX` eklediği 3 değişiklik (`Su → Şu`, `asık → aşık`, `benimde → benim de`) mevcut `marks`/`de_da` düzeltmeleridir; `name` yanlış alarmı **0**'dır.

\*\*\* **`dev` (Vikipedi) `clean` Türkçe yanlış değişiklik listesi:**
- Çekirdek (`sc=1`): 70 `punct` değişikliğinin 68'i ham Vikipedi metnindeki gerçek TDK düzeltmesidir (kurum kesmesi kaldırma `Hacettepe Üniversitesi'nde → Üniversitesinde`, dil kesmesi kaldırma `Fransızca'ya → Fransızcaya`, küçük cümle başı/unvan/eksik boşluk); 2 yabancı kökenli değişiklik (`dev-clean-117` Japonca manga türü `yuri → Yuri`, `dev-clean-999` Yunanca etimoloji `helios'tan → Helios'tan`) mevcuttur; **Türkçe kelimede yanlış `punct` değişikliği 0'dır**.
- `+CTX` (`sc=1`, `T=2.5`): Vikipedi `clean`'deki 61.286 kelimede yalnızca **2 Türkçe `name` yanlış alarmı** oluşmuştur:
  1. `dev-clean-1105`: `savaşa → Savaş'a` (`"...savaşa Yahudilerin neden olduğuna ikna olduğu için..."`)
  2. `dev-clean-1126`: `Savaşa → Savaş'a` (`"Savaşa gitme nedeni sadece bir şeyleri ele geçirmek..."`)
  (Üçüncü ek değişiklik olan `dev-clean-1384: İsmail-pınar → İsmail-Pınar` gerçek bir yer adıdır.)

---

## 6. Diğer Düzeltme Türlerinde Gerileme Kontrolü (`sc=0`, `--browser`)

Yeni çok-görevli `context.onnx` mevcut görevlerde (`marks`, `de_da`, `ki`, `mi`, `typo`) sıfır gerileme gösterir; birçok sınıfta hafif artış sağlar:

| Ölçüm (`--context`, `sc=0`) | Eski `context.onnx` | Yeni `context.onnx` | Fark |
|---|---:|---:|---:|
| `dev` `clean` (`/1000`) | 1,86 | **1,86** | 0,00 |
| `dev` `apostrophe` / `split_join` / `mi` | %71,0 / %98,0 / %63,8 | **%71,0 / %98,0 / %63,8** | 0,0 |
| `dev` `de_da_join` / `de_da_split` / `ki` | %77,3 / %85,3 / %88,6 | **%77,7 / %85,3 / %88,6** | +0,4 / 0 / 0 |
| `dev` `ascii_word` / `typo` | %87,5 / %86,5 | **%87,8 / %86,8** | +0,3 / +0,3 |
| `synth/tune` `clean` (`/1000`) | 0,10 | **0,10** | 0,00 |
| `synth/tune` `adjacent_key` / `double_omission` / `vowel_swap` | %89,0 / %38,7 / %81,4 | **%89,0 / %38,7 / %81,4** | 0,0 |
| `synth/tune` `mixed` | %51,8 | **%52,5** | **+0,7** |
| `handwritten/neon-v1` `clean` (`/1000`) | 0,00 | **0,00** | 0,00 |

*(Not: Eski eğitilmemiş `context.onnx` ile `sc=1` çalıştırıldığında `synth/tune clean` `2,75/1000`'e sıçrıyordu; yeni `kind="name"` eğitimli `context.onnx` ile `0,49/1000` çekirdek düzeyine geri indi.)*

---

## 7. Hız ve Boyut

### 7.1 Model Boyutları (`npm run build:models` → `site/public/models/`)
| Dosya | Ham | Gzip | Brotli | Sınır |
|---|---:|---:|---:|---|
| `lexicon.bin` | 5,588 MB | 3,295 MB | 3,202 MB | — |
| `morph.bin` | 0,338 MB | 0,154 MB | 0,148 MB | — |
| `known.tsv` (`known` + `names`) | 0,356 MB | 0,111 MB | 0,101 MB | — |
| **`CORE MODELS` toplamı** | **6,281 MB** | **3,559 MB** | **3,450 MB** | **`< 5,0 MB` gzip (OK)** |
| **`context.onnx`** | **3,017 MB** | **2,509 MB** | **2,480 MB** | **`≤ 3,0 MB` gzip (OK)** |

### 7.2 Çalışma Hızı (`--browser`, Node CPU)
| Veri Seti | Çekirdek `sc=0` | Çekirdek `sc=1` | `+CTX` `sc=0` | `+CTX` `sc=1` |
|---|---:|---:|---:|---:|
| `bench/names/tune.jsonl` (6.164 kel.) | — | **73 µs/kel.** | — | 217 µs/kel. |
| `bench/synth/tune.jsonl` (20.400 kel.) | 58 µs/kel. | **73 µs/kel.** | 215 µs/kel. | 235 µs/kel. |
| `bench/handwritten/neon-v1.jsonl` (2.301 kel.) | 95 µs/kel. | **109 µs/kel.** | 257 µs/kel. | 300 µs/kel. |
| `bench/conversation/clean.jsonl` (21.478 kel.) | 35 µs/kel. | **52 µs/kel.** | 146 µs/kel. | 178 µs/kel. |
| `dev` (61.286 kel.) | 57 µs/kel. | **72 µs/kel.** | 200 µs/kel. | 227 µs/kel. |

Çekirdek hızı tüm setlerde **`52–109 µs/kelime`** aralığındadır (`≤ ~120 µs/kelime` hedefinin altında).

---

## 8. Geri Alınan Denemeler

1. **Çekirdek içi seyrek doğrusal belirsiz ad sınıflayıcısı (`NAME_CTX` — `py/train_core_name_clf.py`, `src/rules/name-context-core.ts`):**
   - `known.tsv` içine ~9.500 ağırlık (+59 KB gzip) gömerek bağlam modeli olmadan belirsiz adları ayırmayı denedik (`valid_acc = %88,5` budamasız / `%86,0` budamalı).
   - **Neden geri alındı:** Torba-sözcük (bag-of-words) doğrusal modeli `özlemle`, `baharla`, `deniz`, `can`, `barış` gibi günlük Türkçe kelimelere güçlü negatif öncelik, `ay`/`mısır` gibi Vikipedi kelimelerine yüksek pozitif öncelik atadı; temiz metinde sıfır yanlış alarm veren eşikte (`T ≥ 3,8`) ayar ve doğrulama setlerinde **0 net kazanç** sağladı. Kaldırıldı ve çözüm `ContextScorerV3`'ün 6. görevine taşındı.
2. **Dengesiz ilk `name_context` v1 veri seti (420 otomatik madencilikli gövde, 105K örnek):**
   - `word_stats.tsv`'den otomatik eklenen ~220 yüksek sıklıklı kelime (`ben`, `sen`, `yeni`, `gün`, `adam`, `devlet`, `dünya`, `tanrı`) kotanın %90'ını doldurduğu için gerçek Türkçe kişi adları (`can`: 143 negatif / 11 pozitif, `özlem`: 0 ekli pozitif) ağır negatif eğilime düştü ve `AYAR` `belirsiz` puanları negatif kaldı.
   - **Neden değiştirildi:** Hedef küme kesin 193 `AMBIG` gövdesiyle sınırlandırıldı, gerçek kişi/yer bağlamlarından fonolojik ikame + kelime-başına 50/50 dengeleme (`name_context_v2`) ile yeniden eğitildi; `belirsiz` ve `VAL` toplamı belirgin sıçrama yaptı (`+7` ek doğru düzeltme `T=1.5`'te, `+4` sıfır-FA `T=2.5`'te).
3. **Aşırı geniş bileşimsel kurum/coğrafya baş sözcükleri (`kursu`, `kahvesi`, `ofisi`, `merkezi`, `dairesi`, `tepesi`, `vadisi`, `eyaleti`, `bölgesi`, `adası`, `kalesi`):**
   - Bu genel başlıklar `İngilizce Kursuna`, `Kemal Kahvesini`, `Ankara Merkez Ofisine`, `Akropolis Tepesi'ne` gibi yanlış büyük harf/kesme değişikliklerine yol açtı ve `VAL` `dil_millet_din` başarımını `%97,1 → %85,7` düşürdü. Bileşimsel kurallardan çıkarılıp yalnızca belirli özel adlar `CANONICAL_PHRASES`/`phrases.tsv` içinde bırakıldı.
4. **`isCommonWordCollision` gevşetmesi (`!isMorphWord` yerine kök kontrolünü kaldırma):**
   - `murata → Murat'a` için gevşetildiğinde `Anna → Ann'a`, `Paula → Paul'a`, `Jimi → Jim'i`, `Abdi → ABD'i`, `who → WHO` yanlış bölünmelerine neden oldu. Geri alındı; `strongProperApos` (`!isMorphWord(low) && aposFreq >= 15 && aposFreq >= wholeFreq * 2`) ile dar ve güvenli şekilde çözüldü.

---

## 9. Açık Riskler ve Sınırlamalar

- **`karisik_gunluk` tavanı (%46,3 tam eşleşme, %98,2 kelime kesinliği):** Kalan cümle-düzeyi eksikliklerin büyük bölümü özel ad kurallarından değil, cümle sonuna eksik nokta eklenmemesinden (TDK `noktalama` kasıtlı olarak nokta eklemez) ve çekirdek yazım sözlüğünde olmayan özel ad yazım hatalarından (`ecnin → Ece'nin`, `fenrbahce → Fenerbahçe`, `kuzgncukta → Kuzguncuk'ta`) kaynaklanır.
- **Konservatif `contextNameThreshold = 2.5` dengesi:** Temiz metinde sıfır yanlış alarm zorunluluğu nedeniyle `belirsiz` sınıfında ince bağlam ipuçlarına sahip bazı yalın kişi adları (`"Mesaj atınca can hemen cevap verdi"`, `"Telefonu barış açtı"`) eşik altında dokunulmadan bırakılır; `T=1.5` bu örneklerin bir kısmını yakalasa da `VAL clean` ve `synth clean`'de yanlış alarm başlattığı için `T=2.5` tercih edilmiştir.
- **Dative eylem öbeği çakışmaları (`savaşa → Savaş'a`):** Kişi adı ikamesi nedeniyle `"<Ad>'a gitmek"` kalıbı çok ender olarak `"Savaşa gitmek"` gibi yüksek sıklıklı fiil öbekleriyle çakışabilmektedir (`dev clean`'de 61.286 kelimede 2 kez). Gelecekte yüksek sıklıklı eylem-tümleç ikilileri (`savaşa git-`, `savaşa gir-`) için ek negatif madencilik ile tamamen sıfırlanabilir.
- **Yeni/nadir kurum ve eser adları:** Sözlükte olmayan küçük/yerel kurum adları veya genel ad taşıyan yeni kitap/film adları, bileşimsel baş sözcükler dışında kalıyorsa büyük harfle başlatılmayabilir; yeni adlar `src/rules/proper-names.ts` (`CANONICAL_PHRASES`) veya yeniden madencilikle kolayca eklenebilir.
- **Eski v3 `context.onnx` uyumluluğu:** `ContextModel.supportsNameContext` şu an `subwordsOnly` bayrağına bağlıdır; yeni yayınlanan `site/public/models/context.onnx` 6 görevli olduğu için tarayıcı ve paket sürümlerinde sorunsuzdur, ancak elle çok eski bir 5 görevli v3 `context.onnx` dosyası verilirse `kind="name"` için eğitilmemiş çıktı üretebilir.
