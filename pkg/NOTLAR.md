# `pkg/` Geliştirme Notları (Motor Değişiklikleri)

`src/` klasörüne dokunmama kuralı gereği, çekirdek motorda gerekli veya faydalı görülen değişiklikler burada listelenmiştir.

## 1. Derleme için zorunlu değişiklik (`TS4023`) — Çözüldü

- **Dosya:** `src/corrector.ts` (76. satır)
- **Durum:** `export interface Token` çekirdek motorda dışa aktarıldı; `pkg/` derlemesi artık `TS4023` hatası vermeden `.d.ts` üretebiliyor.

## 2. İsteğe bağlı gelecek iyileştirmeler

1. **`Corrector.correct(text, range?)` ve `Corrector.correctAsync(text, model, range?)` desteği:**
   Şu an `pkg/src/engine.ts` tüm metni `Corrector.correct(text)` / `Corrector.correctAsync(text, model)` ile çalıştırıp `[from, to)` aralığı dışındaki düzeltmeleri filtreliyor. Paragraf düzeyinde bu hızlı olsa da bağlam modeli açıkken `contestedSpans` aralık dışındaki kelimeler için de ONNX çıkarımına giriyor. `range` çekirdek motora taşınırsa yazarken yalnızca ilgili kelimeyle kesişen çekişmeli aralıklar modele gönderilir ve çıkarım süresi belirgin biçimde kısalır.

2. **`KnownFix` içine kural kategorisi (`section`) eklenmesi:**
   `data/rules/known.tsv` dosyasında `MISSPELLINGS`, `SEPARATE_ALWAYS` ve `JOINED_ALWAYS` bölümleri zaten mevcut. `KnownMisspellings` bu ayrımı `KnownFix` nesnesinde taşırsa `pkg/src/engine.ts` içindeki `mapCorrectionKind` boşluk sezgisine gerek kalmadan `bitisik-ayri` / `yazim` ayrımını doğrudan yapabilir.

3. **Tür bazlı filtrelemenin motor içine taşınması:**
   Şu an `options.kinds` motor çıktısı üzerinden filtreleniyor. Örneğin bir kelimede hem `marks` hem `split` adayı varsa ve kullanıcı `turkce-karakter` türünü kapattıysa, filtreleme motor içinde yapılırsa ikinci uygun aday değerlendirilebilir.

4. **Sıkıştırılmış sözlük biçimi:**
   Tüm indirme ve ayrıştırma mantığı `pkg/src/data.ts` içinde toplandı. Sözlük FST/ikili sıkıştırılmış biçime geçtiğinde yalnızca `src/lexicon.ts` ve `pkg/src/data.ts` güncellenecek; paketin dış API'si ve worker protokolü değişmeden kalacaktır.
