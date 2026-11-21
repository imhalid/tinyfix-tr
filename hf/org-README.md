---
title: README
emoji: ✍️
colorFrom: yellow
colorTo: red
sdk: static
pinned: false
---

<img src="https://huggingface.co/spaces/imhalid/README/resolve/main/banner.png" alt="tdkai: Türkçe yazım, internetsiz. Yazarken bende → ben de, hber → haber düzeltiliyor; düzeltilemeyen kelimenin altı çiziliyor ve öneri sunuluyor." width="100%">

<div align="center">

TDK yazım kurallarına göre çalışan, tamamen cihazda koşan Türkçe otomatik düzeltme.

[Canlı demo](https://tdkai.halid.dev) · [Model](https://huggingface.co/imhalid/tdk-ai)

</div>

---

### Ne yapar?

Yazarken düzeltir. Emin olduğu hatayı kendisi düzeltir; emin olamadığı hatalı kelimenin altını çizer ve öneri sunar.
Metniniz hiçbir sunucuya gitmez: model tarayıcıda, telefonda ya da kendi sunucunuzda çalışır.

| Hata | Yazılan | Düzeltilen |
|---|---|---|
| Türkçe karakter | `cok guzel bir gun` | çok güzel bir gün |
| Harf hatası | `brada nuler oluyor` | burada neler oluyor |
| İki hata birden | `duzenblemiyor` | düzenlemiyor |
| de / da, ki, mi | `bende geldim`, `gelirmisin` | ben de geldim, gelir misin |
| Bitişik / ayrı | `hiç bir`, `birşey` | hiçbir, bir şey |
| Kesme işareti | `Ankaraya` | Ankara'ya |
| Bağlam | `Ondan hiç her alamadım` | Ondan hiç haber alamadım |

### Sayılarla

Modelin hiç görmediği test setlerinde:

- Yazım hatalarının **%96–99**'u düzeltiliyor ya da önerisiyle işaretleniyor.
- Hatasız metinde 1000 kelimede yaklaşık **2** yanlış değişiklik (çoğu nadir özel ad ve terim).
- Çekirdek indirme **3,5 MB**; isteğe bağlı bağlam modeli **2,5 MB**.
- Kelime başına **~0,1 ms**.

### Nasıl çalışır?

1. **Sözlük ve biçimbilim:** 1 milyon kelime biçimi, Zemberek tabanlı Türkçe ek kuralları. Hiç görülmemiş ama dil
   bilgisine uygun biçimler de tanınır.
2. **Aday üretimi:** Türkçe harf kaybı, eksik/fazla/yer değiştirmiş harf, komşu tuş; iki hataya kadar.
3. **Bağlam modeli:** 2,8 milyon parametreli Türkçe alt-kelime Transformer'ı, adaylar arasında cümlenin anlamına göre
   seçer (`oldu / öldü`, `yıllar / yollar`).

---

<div align="center">

**English:** tdkai is an offline Turkish autocorrect that follows TDK spelling rules and runs entirely on the
device. It fixes what it is sure of and flags the rest with suggestions.

<sub>Kelime verisi: Türkçe Vikipedi ve <a href="http://www.opensubtitles.org/">OpenSubtitles.org</a> (OPUS) ·
Biçimbilim: Zemberek-NLP · Model lisansı: CC BY-SA 4.0</sub>

</div>
