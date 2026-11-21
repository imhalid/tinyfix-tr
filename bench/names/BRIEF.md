# Sentetik veri: Türkçe büyük harf, özel adlar ve kesme işareti

Türkçe bir otomatik düzeltme modelini (tdkai) ölçmek ve eğitmek için veri üretiyorsun. Model şunları düzeltmeli:
özel adların büyük harfi, özel adlara gelen eklerde kesme işareti, cümle başı büyük harf ve nokta sonrası boşluk.
**Yalnızca Türkçe** metin üret. Kurallar için **TDK Yazım Kılavuzu**'nu esas al. Bir kuraldan emin değilsen o örneği
üretme; tahminle yanlış veri üretmek, az veri üretmekten çok daha kötü.

## Biçim

Sana verilen dosya yoluna JSON Lines yaz. Her satır bir örnek:

```json
{"id": "<sınıf>-001", "class": "<sınıf>", "wrong": "kullanıcının yazdığı metin", "right": "TDK'ya göre doğrusu", "note": "kısa açıklama"}
```

- `wrong` ile `right` arasındaki **tek fark** senin sınıfının konusu olsun: büyük/küçük harf, kesme işareti, boşluk.
  Başka yazım hatası koyma (yalnızca `karisik_gunluk` sınıfı istisna). Cümlenin geri kalanı iki tarafta harfi harfine
  aynı olsun.
- Temiz (değişmemesi gereken) örneklerde `wrong` ve `right` birebir aynı olsun.
- `right` tamamen doğru Türkçe olsun: cümle başı büyük, noktalama yerinde, Türkçe karakterler tam.
- Her örnek 1–3 cümle; günlük mesaj, e-posta, not, haber, ödev gibi farklı türlerden, doğal dilde.
- Aynı adı ya da kalıbı tekrar tekrar kullanma; çeşitlilik çok önemli. Yaygın ve az bilinen adları karıştır.
- Hedef: **160 örnek**. `id` numaraları 001'den başlayıp sırayla artsın.
- Bittiğinde dosyayı baştan okuyup her satırın geçerli JSON olduğunu ve `wrong`/`right` farkının yalnızca konun
  olduğunu kontrol et. Sonunda kısa bir özet ver: kaç örnek, hangi alt durumlar, emin olamadığın için atladıkların.

## Hatırlatma: TDK kuralları (özet; ayrıntı için kılavuz)

- Kişi, yer, kurum, kuruluş, eser, dil, millet, din ve mezhep adları büyük harfle başlar. Birden çok kelimeli
  adlarda her kelime büyük başlar ("Türk Dil Kurumu", "Ankara Üniversitesi").
- Özel adlara gelen çekim ekleri kesmeyle ayrılır: İstanbul'a, Ahmet'in, Türkiye'de, Kadıköy'den. Ünlü/ünsüz uyumu ve
  kaynaştırma harfleri ekte kalır (Ankara'ya, Ayşe'nin, Kars'a). Özel adlarda yumuşama yazıya geçirilmez
  (Mehmet'e, Zonguldak'a).
- **DÜZELTME (TDK kesme işareti sayfasından doğrulandı):** Kurum, kuruluş, kurul, birleşim, oturum ve iş yeri
  adlarına gelen ekler kesmeyle **ayrılmaz**: Türk Dil Kurumundan, Türkiye Büyük Millet Meclisine, Bakanlar Kurulunun,
  Ankara Üniversitesine, Mavi Köşe Bakkaliyesinden. Buna karşılık devlet, savaş, çağ, coğrafya, gazete, kanun, birlik
  adlarında kesme vardır: Osmanlı Devleti'ndeki, Kurtuluş Savaşı'nı, Eski Çağ'ın, Çanakkale Boğazı'nın,
  Resmî Gazete'de, Avrupa Birliği'ne, Türk Dil Kurumu Başkanı'na (kişi unvanı).
- Belirli tarih bildiren ay ve gün adlarına gelen ekler kesmeyle ayrılır: 17 Aralık'a, 12 Temmuz 2010 Pazartesi'nin.
- Çokluk eki ve sonrasındakiler kesme almaz: Ahmetler, Mehmetler, Türklerin.
- Yapım ekleri kesmeyle ayrılmaz: Türkçe, Türkçeyi, Ankaralı, Avrupalılar, Türkler, Müslümanlık, İstanbullu.
- Dil adları ve -ce/-ca ekli adlar ek alırken kesme almaz: Türkçeyi, İngilizcede.
- Unvanlar ve hitaplar özel addan sonra/önce gelince büyük başlar: Ahmet Bey, Ayşe Hanım, Dr. Ahmet Yılmaz,
  Prof. Dr., Sayın Başkan.
- Belirli bir tarih bildiren ay ve gün adları büyük başlar ("1 Ocak 2026 Pazartesi"); genel kullanımda küçük
  ("ocak ayında", "pazartesi günü görüşelim"). Bayram ve özel gün adları büyük ("Ramazan Bayramı").
- Cümle başı büyük harfle başlar; nokta, soru ve ünlemden sonra boşluk bırakılır.
- Hem özel ad hem sıradan kelime olan sözcüklerde ("deniz", "umut", "can", "barış", "gül", "yıldız") anlam bağlamdan
  anlaşılır: "Deniz bugün gelmedi" ad; "deniz bugün dalgalı" sıradan kelime.
