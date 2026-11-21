# Görev: Türkçe yazım hatası verisi üret (eksik harf ağırlıklı)

Bir Türkçe otomatik düzeltme aracının ölçümü ve hata modeli için gerçekçi veri üretiyorsun. Kullanıcılar hızlı yazarken
özellikle **harf atlıyor**: "brada" (burada), "geldm" (geldim), "yapıyrum" (yapıyorum), "rksikliklerinde" (eksikliklerinde),
"nuler" (neler).

## Ne üreteceksin

Sana verilen ALANDA, **300 farklı cümle**. Her cümle:
- Doğal, günlük Türkçe; o alanda gerçekten yazılabilecek bir mesaj/cümle. 5–20 kelime. Konular ve kelimeler çeşitli olsun,
  aynı kalıbı tekrarlama. Çekimli, uzun kelimeler de olsun ("gelemeyeceğimizi", "eksikliklerinde", "anlatabilir misiniz").
- `right`: TDK yazım kurallarına uygun, Türkçe karakterleri tam, doğru yazılmış hâli.
- `wrong`: aynı cümlenin, hızlı yazan birinin yapacağı **1–3 kelimede** hatalı hâli. Geri kalan her şey `right` ile birebir
  aynı (noktalama, büyük harf, boşluklar).
- `errors`: her hatalı kelime için {"wrong", "right", "type"}.

## Hata türleri ve oranları (type alanına yaz)

- `omission` (%55): tek harf atlama. Çoğu ünlü ("burada"→"brada", "geliyorum"→"geliyrum"), bazen ünsüz ("teşekkür"→"teşekür",
  "lütfen"→"lütfn").
- `double_omission` (%10): aynı kelimede iki harf atlama ("gidiyoruz"→"gidiyrz", "çalışıyorum"→"çalşıyrum").
- `adjacent_key` (%15): Türkçe Q klavyede komşu tuşa basma ("eksik"→"rksik", "neler"→"nwler", "ders"→"dets").
- `vowel_swap` (%10): bir ünlünün yerine başka ünlü ("neler"→"nuler", "geliyor"→"geliyur", "kitap"→"kitep").
- `transposition` (%10): yan yana iki harfin yer değiştirmesi ("bilmiyorum"→"bilmiyroum").

Kurallar:
- Hatalı kelime **kendisi geçerli bir Türkçe kelime olmamalı** ("kalem"→"kale" OLMAZ, "evde"→"ede" OLMAZ). Emin değilsen başka
  kelime seç.
- Özel adlarda (kişi, şehir) hata yapma; sadece sıradan kelimelerde.
- Hataları uzun ve kısa kelimelere dağıt; 3 harften kısa kelimelerde hata yapma.
- Türkçe karakterleri (ç, ğ, ı, ö, ş, ü) `wrong` içinde de koru, hata türü gerektirmedikçe değiştirme.

## Çıktı

Yalnızca şu dosyaya yaz (JSON Lines, her satır bir nesne, UTF-8): `OUTPUT_PATH`

{"id": "ALAN_KODU-001", "domain": "ALAN", "right": "...", "wrong": "...", "errors": [{"wrong": "brada", "right": "burada", "type": "omission"}]}

Bitirince dosyayı bir Python betiğiyle kontrol et:
- her satır geçerli JSON;
- `wrong` ile `right` kelime kelime karşılaştırıldığında farklı olan kelimeler tam olarak `errors` listesindekiler;
- 300 satır.
Hatalı satırları düzelt. Başka hiçbir dosyayı değiştirme. Son mesajında yalnızca satır sayısını ve tür dağılımını yaz.
