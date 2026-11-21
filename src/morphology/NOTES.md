# `src/morphology/` Mimari Notları

## 1. Yaklaşım Seçimi: Kökten İleri Sonlu Durum Makinesi (Root-Driven FST)

Sağdan sola ek soyma yerine **kökten başlayan ileri yönlü sonlu durum makinesi (FST)** seçildi. Bunun dört temel nedeni var:

1. **Kesinlik (Precision) önceliği:** Türkçe'de ek sıralaması, ses olayları ve kural istisnaları (yumuşama `kitap→kitabı` vs `hukuk→hukuku`, ünlü düşmesi `burun→burnu`, ikizleşme `hak→hakkı`, ters ünlü uyumu `saat→saatler`, bileşik iyelik `zeytinyağı→zeytinyağları`, geniş zaman `-Ir/-Ar`, edilgen `-In/-Il`, ettirgen `-t/-dIr`, düzensiz kökler `ben→bana`, `demek→diyor`, `su→suyu`) doğrudan **köke ve kök özelliklerine** bağlıdır. İleri yönlü FST, bir sonraki ekin yüzey biçimini (`SurfaceTransition`) önceki durumun fonetik özniteliklerinden kesin biçimde üretir ve geçersiz ses/ek kombinasyonlarını en baştan eler.
2. **Zemberek kaynaklarıyla doğal uyum:** Elimizdeki kök sözlükleri (`data/morph/*.dict`) ve referans kural kümesi (`reference/zemberek/TurkishMorphotactics.java`) bu mimariye göre etiketlenmiştir (`Voicing`, `NoVoicing`, `LastVowelDrop`, `Doubling`, `InverseHarmony`, `CompoundP3sg`, `Aorist_I`, `Passive_In`, `Causative_t`…).
3. **Çift yönlü analiz desteği:** Aynı FST motoru hem hızlı doğrulama (`isWord`) hem de tam biçimbirim dökümü (`analyze`) için tek bir tutarlı kaynak sağlar.
4. **Düşük yanlış pozitif riski:** Ek soyucu yaklaşımlar, kısa köklerde veya ses değişimlerinin tersine çevrilmesinde (ör. `-b/-c/-d/-ğ` → `-p/-ç/-t/-k` tahmininde) gerçek olmayan kök-ek eşleşmeleri üretmeye daha açıktır. Kök dizininden yalnızca gerçek köklerin izinli allomorfları (`kitab`, `ağz`, `hakk`, `gid`) üretilip `PA_EXPECTS_VOWEL | PA_CANNOT_TERMINATE` bitleriyle kısıtlandığı için hatalı yarı-kökler asla kabul edilmez.

## 2. Hız Optimizasyonları

Motor, düzeltme sırasında kelime başına yüzlerce aday için `isWord` çağrısı yapacağından şu optimizasyonlar uygulandı:

- **32-bit bitmask temsili:** Hem kök öznitelikleri (`RA_*`, 26 bayrak) hem fonetik öznitelikler (`PA_*`, 18 bayrak) `Set` yerine tek bir `number` bitmask olarak tutulur; tüm ses ve koşul kontrolleri tek bit işlemidir.
- **64 girişli geçiş yüzeyi önbelleği:** Bir ek şablonunun üreteceği yüzey metni yalnızca 6 fonetik bite (`LastVowel`, `Back`, `Front`, `Round`, `Unround`, `LastVoiceless`) bağlıdır. Her `SuffixTransition`, bu 6 bitlik anahtarla indekslenen 64 elemanlı `surfaceCache` ve `Int32Array` `nextPhoneticCache` taşır; ilk kullanım sonrası şablon çözümlemesi ve sonraki fonetik bitmask hesabı O(1) tablo okumasına iner.
- **Sıfır alt-dize arama ve bağlı düğüm (`PathNode`):** Arama sırasında girdi metni dilimlenmez; yalnızca tamsayı `pos` imleci ilerletilir ve ilk karakter `charCodeAt` ile O(1) karşılaştırılır. Yol geçmişi kopyalanan diziler yerine değişmez tek yönlü bağlı liste (`PathNode.prev`) ile temsil edilir.
- **En uzun kökten başlayan erken çıkışlı DFS (`isWord`):** Çekimsiz veya az çekimli kelimeler en uzun önekte anında kabul edilir ve ilk geçerli terminal durumda arama kesilir.
- **Kompakt kök dizini & sınırlı sonuç önbelleği:** Kök haritası tek geçişli yüzeyleri doğrudan `StemTransition` nesnesi olarak saklar (dizi sarmalayıcı olmadan). `isWord`, 65.536 girişle sınırlı bir önbellek kullanır; tekrarlanan sorgular birkaç mikrosaniyenin altında döner.
- **Regex'siz `.dict` ayrıştırıcı:** Sözlük dosyaları `indexOf`/`slice` ile tek geçişte ayrıştırılır ve paylaşılan `MorphotacticsGraph` tekil (singleton) olarak bir kez kurulur.

## 3. Kesinlik (Precision) Kararları

Yanlış yazılmış bir kelimeyi geçerli saymak düzeltme motorunun hatayı kaçırmasına yol açtığı için Zemberek'e kıyasla şu daraltmalar yapıldı:

- **`[A:Ext]` ve `[A:Informal]` kayıtları dışlandı:** `non-tdk.dict` içindeki `[A:Ext]` kayıtları (`birşey`, `herşey`, `egzos`, `şöför`, `şurda`, `dinazor`, `döküman`, `çukulata`, `çünki`, `heykeltraş`, `karnıbahar`, `sezeryan`, `ambülans`, `yokolmak`, `sözkonusu`, `hiçbirşey`, `hergün`…) ve `informal.dict` içindeki konuşma dili yazımları doğrudan `sample-wrong.txt` ile örtüştüğü için yükleme sırasında elenir. `[A:Ext]` taşımayan standart kayıtlar (`annemler` gibi `FamilyMember` kayıtları dahil) korunur.
- **Konuşma dili ünlü düşmeleri (`connectLastVowelDropWords`) eklenmedi:** Zemberek'in *burda, şurda, orda, burdan, ordan, içerde, dışarda, dışardan, yukarda, yukardan, ilerde* biçimlerini kabul eden özel kök yolu dışarıda bırakıldı (yalnız başına `sample-wrong.txt`'nin %2'sinden fazlasına karşılık geliyordu).
- **Soru eki (`mi`) ve bağlaçlar (`de/da/ki`) bitişik kabul edilmez:** `mı/mi/mu/mü` yalnızca bağımsız kelime olarak `questionRoot_S` altında çözümlenir; fiil/isim sonuna eklenmez. Bulunma eki `-dA` (`evde`) ve ilgi eki `-ki` (`evdeki`, `evdekiler`) geçerlidir; ancak `*dahada`, `*nasılda`, `*öylemi` gibi yaygın bağlaç/soru eki bitişik yazım hatalarını önlemek için `daha_Noun_Time` üzerinde bulunma hali ve işlevsel sıfatlarda (`nasıl`, `öyle`, `böyle`, `şöyle`, `her`, `herhangi`, `birkaç`, `birçok`, `birtakım`, `bazı`, `hiçbir`, `tüm`, `bütün`) `Adj → Zero → Noun` adlaşması kısıtlandı (ek-fiil çekimleri `nasılsın`, `öyleydi` korunur; `tüm`/`bütün` ayrıca isim kaydına sahip olduğundan `tümünü`/`bütünü` geçerlidir).
- **İlgi `-ki` sonrası adıl çekimi:** `rel_S → adjectiveRoot_ST → adjZeroDeriv_S → noun_S` yolu engellenip `-ki` sonrası hal/çoğul çekimleri `pronAfterRel_S` üzerinden geçirildi; böylece `evdekini`, `evdekinde`, `evdekiler` geçerli kalırken kaynaştırmasız `*evdekiyi`, `*evdekide` reddedilir.
- **`master-dictionary.dict` içindeki bilinen TDK-dışı/hatalı 13 kayıt dışlandı:** `afedersin`, `afedersinin`, `ardarda`, `birara`, `birarada`, `çöğunlukla`, `elele`, `herbiri`, `herzaman`, `ilerde`, `keşki`, `kolkola`, `yanısıra`.
- **Özel isim ve kısaltmalarda otomatik yumuşama kapalıdır:** TDK yazımında özel isimler ve kısaltmalar yazıda yumuşamadığı için (`Ahmet'i`, `Zonguldak'a`) açıkça `[A:Voicing]` etiketi olmayan `ProperNoun`/`Abbreviation` kayıtlarına otomatik yumuşama uygulanmaz.
- **Çatı dengesi:** Üretken edilgen (`-Il`, `-In`, `-InIl`) ve zincirlenebilir ettirgen (`-t`, `->dIr`) kuralları FST'dedir; yarı-üretken `-Ir` ettirgenleri (`pişirmek`, `düşürmek`, `geçirmek`), dönüşlü (`yıkanmak`, `giyinmek`) ve işteş (`anlaşmak`, `görüşmek`, `yazışmak`) fiiller ise aşırı üretimi önlemek için Zemberek'teki gibi `master-dictionary.dict` kök sözlüğünden gelir.
