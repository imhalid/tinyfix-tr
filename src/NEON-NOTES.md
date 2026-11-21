# Görev 5 — Düzeltme Motoru İyileştirme Notları (`NEON-NOTES`)

Bu dosya, `tinyfix-tr` düzeltme motorunda (`src/rules/turkish-rules.ts`, `src/known.ts`, `src/corrector.ts` ve `src/corrector.test.ts`) yapılan değişiklikleri, dayandıkları kanıtları, taşıdıkları riskleri, Claude'un çalıştırması gereken ölçümleri ve belirsiz noktaları özetler.

---

## 1. Yapılan Değişiklikler

Yeni saf dilbilgisi/sesbilim yardımcı kuralları geri alınabilir ve bağımsız test edilebilir olacak şekilde [src/rules/turkish-rules.ts](file:///private/tmp/claude-501/-Users-imhalid-autr/ac87e83a-67a6-4983-9f9f-4027ea2ae923/scratchpad/neon/work5/src/rules/turkish-rules.ts) altına toplandı; [src/known.ts](file:///private/tmp/claude-501/-Users-imhalid-autr/ac87e83a-67a6-4983-9f9f-4027ea2ae923/scratchpad/neon/work5/src/known.ts) ve [src/corrector.ts](file:///private/tmp/claude-501/-Users-imhalid-autr/ac87e83a-67a6-4983-9f9f-4027ea2ae923/scratchpad/neon/work5/src/corrector.ts) bu yardımcıları kullanacak biçimde güncellendi. `Settings` ve `WordContext` genel arayüzleri geriye uyumlu bırakıldı (eklenen alanlar isteğe bağlı; `pkg/` gibi biçimbilimsiz çağrılar da bozulmaz).

### A. Temel Hata Düzeltmeleri ve Yanlış Alarm Önleme

1. **Aday karşılaştırmasının ham puan yerine fark puanıyla (`margin = score - base`) yapılması (`src/corrector.ts`)**
   - **Ne:** `Candidate` yapısına `base` ve isteğe bağlı `threshold` eklendi; aday tekilleştirme, sıralama ve `ambiguity` kontrolü artık `score - base` fark puanı üzerinden yapılıyor.
   - **Neden:** Tek kelimelik adaylar `log(typedCount)` tabanını, `join` adayları ise `log(pair)` tabanını kullanıyordu. Eski kod adayları ham `score` ile karşılaştırdığı için tabanına göre çok kötü bir tek-kelime adayı (`margin < 0`) güçlü bir `join` adayını belirsizlik (`ambiguity`) nedeniyle eleyebiliyordu.
   - **Kanıt:** `evidence/dev-de_da_split-misses.txt` içindeki `"ortaokul da"` örneğinde `join("ortaokulda")` (`score=4.58, base=1.10, margin=+3.48`), `split("orta okul")` (`score=4.12, base=7.35, margin=-3.23`) yüzünden `0.46 < 1.0` farkıyla eleniyordu. Aynı taban ayrımı, cümle içi özel isimlerde büyük-harf sayımı (`caps`) karşılaştırmasına da olanak tanıyor.
   - **Risk:** Düşük. Aynı `base` değerini paylaşan adaylar için `margin(a) - margin(b) === score(a) - score(b)` olduğundan davranış matematiksel olarak özdeştir.

2. **`KnownMisspellings` çok-kelimeli ek/bağlaç kurallarında hatalı eklenmenin engellenmesi (`src/known.ts`, `isValidKnownParticleSuffix`)**
   - **Ne:** `known.tsv`'deki son kelimesi `de/da/ki` olan kurallara (`yada -> ya da`, `değilki -> değil ki`, `olduda -> oldu da`) hiçbir ek eklenmesine izin verilmiyor; son kelimesi `mi/mı/mu/mü` olan kurallarda (`kimmi -> kim mi`, `varmı -> var mı`) ise yalnızca ortaya çıkan son kelime geçerli ve uyumlu bir soru eki oluyorsa (`varmısın -> var mısın`, `varmıydı -> var mıydı`) izin veriliyor.
   - **Neden:** Eski kod `wrong.length >= 4` olan `kimmi -> kim mi` kuralını `stems` listesine alıyor, `"kimmiş"` kelimesini `"kim mi" + "ş" = "kim miş"` yapıp `"miş"` sözlükte geçtiği için (`159`) doğru kelimeyi bozuyordu. Aynı hata `"varmış"`, `"yokmuş"`, `"değilmiş"`, `"yadacı"` gibi kelimeleri de tehdit ediyordu.
   - **Kanıt:** `evidence/conv-clean-changes.jsonl` (`conv-clean-1599`: `kimmiş → kim miş`).
   - **Risk:** Çok düşük. `birşeyler -> bir şeyler` gibi isim/zamir tabanlı kurallar etkilenmez.

3. **Cümle içi iki büyük harfli kelimenin birleştirilmesinin engellenmesi (`src/corrector.ts`)**
   - **Ne:** `check()` içindeki birleştirme koşulu `!isUpperInitial(nextTyped) && !(isUpperInitial(typed) && !context.atSentenceStart)` olarak düzeltildi.
   - **Neden:** Eski koşul (`isUpperInitial(nextTyped) === (isUpperInitial(typed) && !context.atSentenceStart)`) her iki kelime de cümle içinde büyük harfle başladığında `true === true` dönüp iki özel adı birleştiriyordu.
   - **Kanıt:** `evidence/conv-clean-changes.jsonl` (`conv-clean-1403`: `Gözlemci Den → GözlemciDen`).
   - **Risk:** Yok; bu doğrudan bir mantık hatası düzeltmesidir.

4. **Hatalı birleştirme (`joinCandidate`) korumaları ve güvenli eşikler (`src/corrector.ts`, `src/rules/turkish-rules.ts`)**
   - **Ne:**
     - `lexicon.capitalShare(joined) >= 0.5` ise küçük harfli birleştirme engellenir (yanlışlıkla özel isim üretmeyi önler).
     - Biçimbilim yüklüyse, `isRealWord(word) && !isRealWord(joined)` olan birleştirmeler (geleneksel `SOMBAHCEMI_KI` hariç) engellenir.
     - `JOIN_FIRST`'ten `"bu"`, `"şu"`, `"o"`, `"ne"`, `"pek"` çıkarıldı; `"her"` yalnızca `"hangi"` ve `"kes"` ile birleştirilir.
     - `de/da` birleştirmelerinde sert ünsüz bitimli kökler ve `-inizin/-imizin` tamlayan ekleri biçimbilimsiz modda da engellenir; biçimbilim yokken ünlü uyumu aranır (biçimbilim varken `hayalde`/`alkolde` gibi ters uyumlar korunur).
     - `JOIN_SECOND` içine `"teki"`, `"taki"` eklendi.
     - `"çok ta"`, `"hiç te"`, `"pek te"`, `"hep te"`, `"yok ta"` gibi yaygın benzeşmiş bağlaç/edat çiftleri (`TE_TA_SKIP`) birleştirilmez.
     - Bağlaç olamayacak `te/ta` (`pair === 0`, geçerli kelime) için eşik `2.0`, bulunma eki + `ki` (`pair <= 1`, geçerli kelime) için eşik `1.8`, `SOMBAHCEMI_KI` (`oysa/halbu/madem/meğer ki`, `pair === 0`) için eşik `1.0` yapıldı (`illa ki` README'ye uygun olarak dışarıda bırakıldı).
   - **Kanıt:** `conv-clean-changes.jsonl` (`Her neyse → Herneyse` x3, `İkinizin de → İkinizinde`), `dev-ki-misses.txt` (`bu şehr → buşehr`, `meğer ki`, `Raporda ki`), `dev-de_da_split-misses.txt` (`kayalık ta`).
   - **Risk:** Düşük. `dev-clean` ve `conv-clean`'de `te/ta` ve `-de/-da ki` eşiklerinin yanlış birleştirme üretip üretmediği ölçülmelidir.

---

### B. Öncelik 1 — `de/da` (Bitişik Bağlaç ve Ayrı Bulunma Eki)

5. **Biçimbilim tabanlı bitişik `de/da` ayrımı + `typo` engelleme koruması (`src/corrector.ts`, `src/rules/turkish-rules.ts`)**
   - **Ne:**
     - Biçimbilim yüklüyken geçerli bir kelime (`isRealWord(form) === true`) **hiçbir zaman** ek/bağlaç (`de/da`, `mi`, `ki`) kuralıyla bölünmez.
     - `isRealWord(form) === false` ve `isRealWord(first) === true` olduğunda (ve `first` yönelme/belirtme/3. tekil iyelik/vasıta/şart/çekimli fiil/çift bulunma gibi `-de/-da` bulunma eki alamayan bir biçimse):
       - Sert ünsüz yumuşama/benzeşme hatası koruması: `first` `[fstkçşhp]` ile bitiyor ve `first + te/ta` geçerli kelimeyse (`kitapda`, `etrafda`, `kıkırdakda`) bağlaç olarak bölünmez (`oneEdit` `kitapta` olarak düzeltebilir).
       - Ters ünlü uyumu koruması: `second === "da"` iken `first + de/te` geçerli kelimeyse (`hayalda`, `saatda`) bölünmez.
       - Eski `-1.0` ek cezası kaldırıldı; `glued === 0` iken taban puan `Math.max(log(stem), 3.2)` olarak belirlendi (seyrek veya sözlükte 0 geçen ama biçimbilimce geçerli uzun kökler `first.length >= 6` için de çalışır).
     - **Sözlük dışı (OOV) yedek kural:** `NO_LOCATIVE_AFTER` biçimbilimsiz mod için güvenli eklerle (`l[ae]r[ae]`, `s[ıiuü]n[aeıiuü]`, `l[ae]r[ıi]n[aeıiuü]`, `m[ae]y[ıi]`, `yl[ae]`, `s[ae]l[ae]r`, `[ıiuü]ğ[ıiuü]`) genişletildi; OOV `3.2` tabanı ise yalnızca kök-sonu belirsizliği olmayan `STRONG_NO_LOCATIVE_AFTER` (`l[ae]rd[ae]`, `[ıiuü]nd[ae]` vb.) ve `stem >= 3` için uygulanır (`mikromaddede` gibi bileşik isimleri korur).
     - **`typo` (`oneEdit`) kaçırmasını önleme:** `word` biçimbilimce kanıtlanmış bir `de/da`, `mi` veya `ki` bölünmesi üretiyorsa (`first.length >= 4`), `oneEdit(word)` çalıştırılmaz; böylece `oneEdit`'in sondan önceki ünlüyü silip daha sık bulunma ekli biçimi (`boyunuda → boyunda`, `düzeninide → düzeninde`, `görüşmelerede → görüşmelerde`, `yönetmenliğinede → yönetmenliğinde`) seçmesi veya belirsizlikle bölünmeyi iptal etmesi engellenir.
   - **Kanıt:** `evidence/dev-de_da_join-misses.txt` (48 kaçırmanın 30+'sı bu örüntüde), `evidence/v1-de_da-misses.txt` (3 yanlış değişikliğin tamamı + 3 ek kaçırma: `boyunuda`, `düzeninide`, `görüşmelerede`, `kardeşimede`, `görselleride`, `diğerinide`), `evidence/dev-clean-changes.jsonl` (`dev-clean-250`: `Giyside → Giysi de`), `evidence/dev-ascii_word-misses.txt` (`guveninde → güvenin de`).
   - **Risk:** Orta-düşük.
     - Zemberek sözlüğünde yer almayan geçerli bir bileşik kelime `X + de/da` biçimindeyse ve `X` Zemberek'te geçerliyse yanlış bölünme riski doğabilir (örneğin nadir yeni terimler). `glued < knownMarked` ve `isProperAtStart` korumaları bunu sınırlar.
     - `dev-typo` setinde tesadüfen `geçerliKelime + de/da` biçimine dönüşen yapay harf silme hataları (`yerinde → yeride`) `typo` yerine `split` (`yeri de`) olarak yorumlanabilir — gerçek metinde bu biçim neredeyse her zaman bitişik bağlaçtır, ancak `dev-typo` üzerindeki etki mutlaka ölçülmelidir.

---

### C. Öncelik 2 — Kesme İşareti (`apostrophe`)

6. **`addApostrophes` hata düzeltmeleri, cümle içi `caps` karşılaştırması, cümle başı ve kısaltma kuralları (`src/corrector.ts`, `src/rules/turkish-rules.ts`)**
   - **Ne:**
     - **İşaret-varyantı öz-çarpışma hatasının giderilmesi:** Genel kuralda `suffix === word.slice(cut)` zorunlu kılındı; `NAME_SUFFIX` içindeki geçersiz `[dt][ae]k[iı]` → `[dt][ae]ki` olarak düzeltildi, tehlikeli tek harfli `m` ve iyelik/yabancı-ad çakışması yaratan ekler temizlendi, `isValidGenericApostrophe` ile Türkçe sesbilim korumaları (ünlü/ünsüz uyumuna göre `n`/`y` kaynaştırma, sert ünsüz sonrası `t-`, yumuşak sonrası `d-`, sessiz `-e` destekli ünlüyle başlayan ekler) eklendi.
     - **`typedCount === 0` yerine `formCount === 0` + TDK çoğul/dil-adı koruması (`hasBlockedApostropheStem`):** `l[ae]r$` (çoğul) ve uzun `[cç][ae]$` (dil adları) kökleri genel kuralda engellendi.
     - **Cümle içi `seen > 0` için büyük-harfli (`caps`) karşılaştırma:** `seenCaps = round(seen * capitalShare(withMark)) >= 10`, `seenCaps / seen >= 0.5`, `capitalShare(stem) >= 0.5` ve `!hasBlockedApostropheStem(stem)` koşullarında `log(seenCaps) - cost` vs `log(typedCaps)` fark puanı da aday olarak eklenir.
     - **Genel kuralda `capitalShare` ve ceza ayrımı:** 2+ harfli ekler için `capitalShare >= 0.58` ve `-0.2` ceza (`Zeynepten`, `Walkenin`, `Iğdırdaki`, `Yostun`, `Kahirin`, `Sissokonun`, `Fransisconun`, `Venenonun`); 1 harfli ekler (`a/e/i/ı/u/ü`) için yabancı kişi/soyadlarını (`Davide`, `Paula`, `Roberti`, `Alberti`, `Michaela`) korumak amacıyla `capitalShare >= 0.75` ve `-1.2` ceza (`Reignsi`, `Kharkive`).
     - **Cümle başı `seen > 0` kesme kuralı:** Yalnızca sözlükte görülmüş (`seen > 0`), `capitalShare(withMark) >= 0.7`, `capitalShare(stem) >= 0.55`, engelli kök olmayan ve ay/gün adı olmayan (`TIME_NAMES_NO_START_APOSTROPHE`: `"Ekimde havalar soğur"` korunur) kelimeler için toplam sayım farkıyla kesme eklenir (`Bursadan → Bursa'dan`).
     - **Büyük harfli kısaltma kuralı (`matchAcronymApostrophe`):** 3+ büyük harf + 2+ küçük harfli Türkçe ek (`HEXIMden → HEXIM'den`, `KDAların → KDA'ların`, `TLSnin → TLS'nin`), `typedCount === 0`, `!isRealWord(word)` ve yaygın küçük harfli kelime köklerini (`GÜNde`, `YILda`, `BİRde`) dışlayan koruma ile.
   - **Kanıt:** `evidence/dev-apostrophe-misses.txt` (`Weekndin`, `Reignsi`, `TLSnin`, `Walkenin`, `Iğdırdaki`, `Zangın`, `Sissokonun`, `Yostun`, `Kahirin`, `Fransisconun`, `Venenonun`, `Kharkive`, `Ekimde`, `Kasımda`, `Ceylanın`, `Rufusun`, `Aşilin`, `Şikagonun`, `HEXIMden`, `KDAların`), `evidence/v1-apostrophe-misses.txt` (`Zeynepten`, `Bursadan`, `Elifin`), `evidence/dev-ascii_word-misses.txt` (`Muslumanlara`, `Sirplari`, `Hirvatcadan`).
   - **Risk:** Orta.
     - Genel kuralın `0.8 → 0.58` (2+ harfli ek) indirimi ve `-1.5 → -0.2` ceza düşüşü, Vikipedi'de sözlükte 0 geçen ama bir özel ad + Türkçe ek kalıbına uyan nadir yabancı özel adlara (`Antonin` vb. sözlükte yoksa) yanlış kesme ekleyebilir. `isValidGenericApostrophe` ve `formCount === 0` bunu büyük ölçüde sınırlar; `dev-clean` ve `conv-clean` mutlaka izlenmelidir.
     - `caps`-vs-`caps` karşılaştırması, başlık içinde büyük harfle yazılmış ama sözlükte `capitalShare(stem) >= 0.5` olan isimlerde (ör. belirli ay adları) istenmeyen kesme riski taşıyabilir.

---

### D. Öncelik 3 — Soru Eki (`mi`) ve Bonus (`ki`)

7. **Biçimbilim tabanlı `mi` ve `ki` bölünmesi (`src/corrector.ts`)**
   - **Ne:**
     - `?` veya kişi/ek-fiil eki (`misin`, `midir`, `misiniz`) varken: `isRealWord(form) === false && isRealWord(first) === true` ise `-1.0` cezası kaldırıldı, `glued === 0` için `3.2` tabanı eklendi (`kalkabileceklermidir?`, `sorgulanmayacakmı?`, `yükledinizmi?`, `Gömdümü?`).
     - Yalın `mı/mi/mu/mü` (`?` olmadan): `isRealWord(form) === false && isRealWord(first) === true`, `!isName`, `first.length >= 4`, `glued < knownWord`, `stem > 0`, `capitalShare(first) < 0.5` koşullarıyla bölünür (`tutarmı → tutar mı`, `güzelmi → güzel mi`, `yazımmı → yazım mı`, `yerdenmi → yerden mi`, `sizimi → sizi mi`). Tüm geçerli `-mı/-mi/-mu/-mü` biçimleri (`kitabımı`, `sevgimi`, `yazımı`, `ayrımı`, `ekonomi`, `resmi`) `isRealWord(form) === true` olduğu için dokunulmaz.
     - Bitişik `ki`: aynı biçimbilim kuralı (`!isRealWord(form) && isRealWord(first)`, `!isName`) uygulandı; `FINITE` yedek düzenli ifadesi de genişletildi (`biliyorumki`, `korkarımki`, `umuyoruzki`, `ustalaşmıştırki`, `muhakkakki`).
   - **Kanıt:** `evidence/dev-mi-misses.txt` (21 gerçek kaçırmanın ~17'si), `evidence/v1-mi-misses.txt` (3/3 kaçırmanın tamamı: `yükledinizmi?`, `tutarmı`, `güzelmi`), `evidence/dev-ki-misses.txt` (14+ bitişik `ki` kaçırması).
   - **Risk:** Düşük. Zemberek sözlüğünde olmayan ama `geçerliKelime + mi/ki` şeklinde biten yabancı kelimeler için `glued < knownWord` (yalın `mi`) ve `capitalShare(first) < 0.5` korumaları eklendi; yine de `dev-clean`'de nadir yabancı/Japonca sözcükler kontrol edilmelidir.

---

### E. Öncelik 4 — Türkçe Karakter (`marks`)

8. **Türkçe karakter düzeltmeleri ve yanlış alarm korumaları (`src/corrector.ts`, `src/rules/turkish-rules.ts`)**
   - **Ne:**
     - **İşaretli metinde geçerli Türkçe kelimeleri koruma:** `context.textHasMarks && isRealWord(word)` olduğunda kelime `strict` kapsamına alınır ve üstünlük eşiği `markedOverride + 0.5` (`6.0`) yapılır (`cabası → çabası` [3.99], `oluyorduk → ölüyorduk` [3.03], `basınız → başınız` [5.52] korunurken `boyle → böyle` [6.8], `katilim → katılım` [7.4] hâlâ düzelir). Kesmeli kelimelerde (`Asil'in`) kök geçerli/yaygınsa işaretli metinde kök değiştirilmez.
     - **Düşük sayılı geçersiz küçük harfli kelimelerde `strict` gevşetme:** `typed === word && !isRealWord(word) && typedCount < 70 && capitalShare < 0.55` için `strict` uygulanmaz (`yogurt` [23], `yasam` [57], `sey` [56], `produksiyon` [45] düzelirken Vikipedi'deki `gore` [645], `basin` [194], `dag` [304], `kultur` [186], `album` [1720] korunur).
     - **Geçersiz işaret varyantlarını eleme ve tekil biçimbilimsel varyant:** `!isRealWord(word)` kelimede sözlükte geçen geçerli bir işaret varyantı varsa geçersiz varyantlar elenir (`suikastci → suikastçı`, geçersiz `suikastçi` artık engellemez). Ayrıca `length >= 6`, `typedCount < 5`, `variants.length <= 128` iken tek bir `isRealWord`-geçerli varyant varsa eşik `1.5` yapılır (`ezilmisti`, `gidecegiz`, `istedigin`, `isinmadir`, `uzatilacak`, `odeneklerle`, `acilmamissa`, `eslesmiyorsa`, `Aglamasinin`, `Mogolcadaki`, `Hirvatcadan`; ve `vCount === 0` iken yalnızca küçük harfli `length >= 8` kelimelerde: `yukleyince`, `sisirmesinden`, `dalgakiranlarla`, `gevseyecekti`).
     - **Kesmeli eklerde Türkçe karakter (`Ukrayna'sinda`, `Eudocia'nin`):** Kökü değişmeyen kesme-sonrası varyantlarda `typedCount === 0 && count >= 7` için eşik `1.5`; ayrıca `fixDisharmoniousApostropheSuffix` ile ek içinde aynı anda `a` ve `i` içeren (`'sinda`, `'larin`, `'sindaki` — sondaki `-ki` korunarak) kesin uyumsuzluklar düzeltilir.
     - **ASCII cümlelerde ayrı soru eki uyumu (`addQuestionHarmony`, `harmonizeQuestionParticle`):** `!context.textHasMarks` iken bir önceki (düzeltilmiş) kelime `prevWord` takip edilerek `var mi → var mı`, `gordu mu → gördü mü` gibi yalnızca eksik işaret ekleyen (`i → ı`, `u → ü`) düzeltmeler yapılır. Ters ünlü uyumu (`saat mi`, `hayal mi`, `normal mi`, `alkol mü`), müzik notaları (`do/re/fa/sol/la/si`, `mi majör/minör/bemol/diyez`), özel adlar (`prevIsName` / `capitalShare >= 0.55`) ve sözlükte yazıldığı biçimi daha sık olan çiftler korunur.
   - **Kanıt:** `evidence/conv-clean-changes.jsonl` (`cabası`, `oluyorduk`, `basınız`), `evidence/dev-de_da_join-misses.txt` (`Asil'in`), `evidence/dev-ascii_word-misses.txt`, `evidence/v1-ascii-misses.txt` (`yukleyince`, `yogurt`, `gidecegiz`, `ezilmisti`, `istedigin`, `var mi` x2).
   - **Risk:** Orta-düşük.
     - `vCount === 0` iken `length >= 8` küçük harfli tekil biçimbilimsel varyant kuralı, Zemberek'te olmayan 8+ harfli bir yabancı kelimenin yalnızca `c/g/i/o/s/u` dönüşümüyle tesadüfen geçerli bir Türkçe çekime düşmesi durumunda yanlış alarm üretebilir.
     - `realTyped` kelimeler için `markedOverride + 0.5` (`6.0`) eşiği, `dev-ascii_word` içinde Zemberek'te tesadüfen geçerli olan (`basina`, `suresi`, `seker` vb.) ama fark puanı `5.5–6.0` arasında kalan birkaç kelimeyi kaçırmaya neden olabilir.

---

## 2. Claude'un Ölçmesi Gerekenler

1. **Derleme ve birim testleri:**
   - `npx tsc --noEmit` (kök) ve `pkg/` içinde `npx tsc --noEmit` (özellikle `rewriteRelativeImportExtensions`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax` ve biçimbilimsiz `pkg/` uyumluluğu).
   - `npm test` (biçimbilimli) ve `node --test src/corrector.test.ts -- --no-morphology` (biçimbilimsiz).
2. **Ana kıyaslamalar (`dev`, `neon-v1`, mühürlü `v2`):**
   - `dev` tüm sınıflar: özellikle `de_da_join`, `de_da_split`, `apostrophe`, `mi`, `ki`, `ascii_word`, `ascii_sentence`, `typo` (typo kaçırma korumasının yan etkisi!), `split_join` (`JOIN_FIRST` temizliğinin gerileme yapmadığını doğrula) ve **`clean`** (yanlış alarm/1000 kelime — eskiden `1.20`, düşmüş ya da aynı kalmış olmalı).
   - `neon-v1` tüm sınıflar: özellikle `de_da` (%50→hedef %70+, yanlış değişiklik %10→%0), `apostrophe` (%80→%95), `mi` (%88→%100), `ascii` (%75→%90+), `clean` (%0 kalmalı).
   - Konuşma dili temiz metin (`conv-clean`): özellikle eski yanlış alarmların (`kimmiş`, `Her neyse`, `İkinizin de`, `Gözlemci Den`, `cabası`, `oluyorduk`, `basınız`) kaybolduğunu ve yenilerinin çıkmadığını doğrula.
   - Mühürlü `v2` seti (varsa): aşırı uyum olmadığını doğrulamak için.
3. **Bağlam modeli, idempotens ve hız:**
   - `bench/idempotence.ts`: özellikle yeni `addSplits` ↔ `joinCandidate`, `addQuestionHarmony` ve `addApostrophes` etkileşimlerinde 2. geçişte hiçbir değişiklik olmamalı.
   - `correctAsync` (`--context`): bağlam modeliyle birlikte regresyon olmaması.
   - Kelime başı süre (µs/kelime): `variants.length <= 128` ve `isRealWord` çağrılarının `dev` toplam çalışma süresine etkisi.

---

## 3. Emin Olunamayan Noktalar

1. **Genel kesme kuralı `capitalShare >= 0.58` ve `-0.2` cezası:** `counts-unigrams.tsv` yalnızca kanıtlardaki kelimeleri içerdiğinden, tam `dev-clean` / `conv-clean` üzerinde sözlükte `0` geçen ve `bilinenÖzelAd (count >= 24, capitalShare >= 0.58) + 2+ harfli Türkçe ek` kalıbına uyan beklenmedik yabancı isim/yer adı çakışmaları çıkabilir. Çıkarsa `capitalShare` `0.62–0.65` bandına çekilebilir veya ceza `-0.2 → -0.5` yapılabilir.
2. **Cümle içi `caps`-vs-`caps` kesme kuralı (`seenCaps >= 10`, `capitalShare(stem) >= 0.5`):** Vikipedi'de kitap/film başlıkları içinde büyük harfle yazılmış ama kökü `capitalShare >= 0.5` olan özel-isim/cins-isim eşseslilerinde yanlış kesme üretip üretmediği `dev-clean` dökümüyle kontrol edilmelidir.
3. **`dev-typo` üzerindeki `morphParticleHit` etkisi:** Yapay 1-harf silme hataları tesadüfen `geçerliKelime + de/da` (`yerinde → yeride`) ürettiğinde `oneEdit` atlanıp `yeri de` seçilecektir. Bunun `dev-typo` oranını ne kadar etkilediği (ve gerekirse sadece `de/da` silme/değiştirme düzenlemelerinin mi bastırılacağı) ölçümden sonra netleşecektir.
4. **Tekil biçimbilimsel işaret varyantında `vCount === 0` kolu (`word.length >= 8`):** `yukleyince`, `sisirmesinden`, `dalgakiranlarla`, `gevseyecekti` için çok etkili; ancak `dev-clean`'de 8+ harfli sözlük dışı yabancı bir sözcüğün tesadüfen geçerli bir Türkçe çekime dönüşme olasılığı sıfır değil. Yanlış alarm görülürse `vCount >= 1` veya `!hasTurkishMarks(word)` şartı eklenebilir.
5. **`realTyped` işaretli-metin eşiği (`markedOverride + 0.5 = 6.0`):** `cabası`, `oluyorduk`, `basınız` yanlış alarmlarını keserken, `dev-ascii_word` içinde Zemberek'te başka bir anlamla geçerli olan (`seker`, `suresi`, `basina` vb.) kelimelerden hangilerinin `5.5–6.0` aralığında kaldığı ölçümden sonra görülecektir.
6. **`listed` / `istedigin` gizemi:** `evidence/counts-unigrams.tsv`'de `istedigin = 2`, `istediğin = 60` (`margin = 2.51 >= 2.5`) görünmesine rağmen `v1-ascii-misses.txt`'te değişmemişti; tekil biçimbilimsel varyant kuralı (`threshold = 1.5`) bu sınır vakasını rahatça kapsıyor ama `unigrams_conv.tsv`'de asıl eleme sebebinin ne olduğu test koşusunda teyit edilebilir.
7. **Biçimbilimsiz (`pkg/`) çalışma:** `pkg/` tarafında `morphology` geçilmediği için `de/da`, `mi`, `ki` ve `marks` kazanımlarının büyük kısmı biçimbilimli tam motorda görülecektir; ancak `known.ts` düzeltmesi, `margin`-tabanlı karşılaştırma, genişletilmiş `NO_LOCATIVE_AFTER`/`FINITE`, `addApostrophes` ve `joinCandidate` düzeltmeleri `pkg/` tarafına da doğrudan fayda sağlar.

---

## 2. tur

İlk turda elde edilen kazanımları koruyarak Vikipedi temiz metnindeki 6 yanlış alarm sınıfı giderildi ve ilk turda başarısız olan 3 birim testi kök nedenlerine göre çözüldü. `WordValidator` arayüzüne yalnızca isteğe bağlı `analyze?(form: string): readonly WordAnalysis[]` eklendi; `TurkishMorphology` ile doğrudan uyumludur ve `src/morphology/` ya da `pkg/` üzerinde hiçbir uyumluluk kırılması yaratmaz.

### A. Yanlış Alarm Düzeltmeleri (`src/rules/turkish-rules.ts`, `src/corrector.ts`)

1. **Kesme işareti — çoğul ve zaten çekimli köklerin engellenmesi (`Japonlarının → Japonların'ın`, `Yunanlardandır → Yunanlardan'dır`)**
   - **Neden:** Genel (görülmemiş biçim) kesme kuralı `hasBlockedApostropheStem` içinde yalnızca kök sonundaki yalın `-lar/-ler` ekini (`l[ae]r$`) engelliyordu. Çoğuldan sonra çekim eki almış kökler (`japonların` + `ın`, `yunanlardan` + `dır`) Vikipedi'de yüksek `capitalShare` değerine sahip olduğu için kesme işareti ekin ortasına konuyordu.
   - **Değişiklik:**
     - `hasBlockedApostropheStem` (`src/rules/turkish-rules.ts`): ünlü uyumlu çoğul+çekim ekleri (`/[aıouâû][^aeıioöuü]*lar(?:ın(?:dan?|a|ı)?|ıyla|dan?|a|la)$/` ve `/[eiöüî][^aeıioöuü]*ler(?:in(?:den?|e|i)?|iyle|den?|e|le)$/`) ile uzun dil/görelik + çekim kökleri (`türkçeden`, `hırvatçadan`) engellendi (`Clara`, `Valerin` gibi yabancı adlar korunur).
     - `Corrector.isInflectedApostropheStem` (`src/corrector.ts`): biçimbilim `analyze()` mevcutsa, yalın kök (`[]` veya `["A3sg"]`) çözümlemesi bulunmayan ve tüm çözümlemeleri çoğul/durum/ek-fiil/yapım eki (`A3pl`, `Abl`, `Loc`, `Ins`, `Equ`, `Cop`, `With`, `Without`, `Ness`, `Agt`, `Rel`) ya da büyük harfli bir kökün çekimi (`capitalShare >= 0.45`) olan aday kökler cümle başı, `caps`-vs-`caps` ve genel kesme kurallarında engellenir. Küçük harfli ortak sözcük çekimleriyle çakışan yalın kişi adları (`Emre`, `Selin`, `Güler`, `Yaşar`) korunur.

2. **Türkçe karakter — kesmeli ekte ünlü uyumu denetimi (`Mortimer'i → Mortimer'ı` engellendi, `Ravenna'nin → Ravenna'nın` korundu)**
   - **Neden:** Kesmeli sözcüklerde ek içindeki ünlü değişimleri (`i → ı`, `u → ü`, `o → ö`) kökün son ünlüsüyle uyum kontrolünden geçmiyordu; bu nedenle sözlükte geçen hatalı `Mortimer'ı` biçimi `Mortimer'i` yerine seçilebiliyordu.
   - **Değişiklik:** `isHarmoniousApostropheMarkChange` (`src/rules/turkish-rules.ts`) eklendi ve hem `candidates` içindeki kesmeli işaret varyantlarında hem de `fixDisharmoniousApostropheSuffix` içinde uygulandı. Değişen her ek ünlüsü, sonuç kökün (`formStem`) son ünlüsü (veya ekin önceki ünlüsü) ile 4 yönlü Türkçe ünlü uyumuna tabi tutulur; ters ünlü uyumlu kökler (`alkol'ün`) desteklenir, yabancı adlardaki hecesel son `-y` (`Mary`, `Tony`, `Lucy`) ince `/i/` olarak değerlendirilir.

3. **Türkçe karakter — düşük eşiğin (`1.5`) yalnızca küçük harfli kelimelere sınırlanması (`Bagrim → Bağrım`)**
   - **Neden:** Tekil biçimbilimsel varyant bloğunda (`threshold = 1.5`) `isName` için ayrı bir dal ve cümle başı büyük harfli sözcüklere açık yol bulunuyordu; bu da `Morza Bagrim` gibi özel adların nadir Türkçe çekimlere (`Bağrım`) dönüşmesine yol açıyordu.
   - **Değişiklik:** Tekil biçimbilimsel varyant bloğunun en başına `!capitalized` şartı eklendi ve `if (isName)` dalı kaldırıldı.

4. **Türkçe karakter — `vCount === 0` (8+ harf) kolunun sıkılaştırılması (`alveolusun → alveolüsün`)**
   - **Neden:** Zemberek sözlüğünde `alveol [A:InverseHarmony]` bulunduğundan, Latince `alveolus` + `-un` biçimi `alveol + P3sg (-ü) + Zero + Pres + A2sg (-sün)` ("onun alveolüsün") çözümlemesiyle geçerli kabul ediliyor ve `vCount === 0` kolundan geçiyordu.
   - **Değişiklik:** `vCount === 0` koluna `!hasTurkishMarks(word)` ve `Corrector.isSafeUnseenMarkVariant` eklendi:
     - `Zero` + 1./2. tekil/çoğul kişi (`A1sg`, `A2sg`, `A1pl`, `A2pl`) nominal ek-fiil çözümlemeleri (Latince `-us/-um/-is` terimlerini bozan sınıf) reddedilir.
     - Kök/mastar sözlükte yeterince yaygın ve küçük harfli olmalıdır (`count >= 5`, `capitalShare < 0.5`).
     - İşaretli metinde (`textHasMarks`), fiil çekimi olmayan ve ne kökte işaret ne de yeni `ç/ğ/ş` ünsüz işareti getiren salt ek-ünlü değişimleri engellenir. `yukleyince`, `sisirmesinden`, `dalgakiranlarla`, `gevseyecekti` gibi gerçek Türkçe çekimler korunur.

5. **`ki` bölmesi — en az 4 harfli kök şartı (`breki → bre ki`)**
   - **Neden:** `bre` Zemberek'te ünlem/bağlaç olarak geçerli olduğundan 3 harfli kök ile `breki → bre ki` bölünmesi yapılıyordu.
   - **Değişiklik:** `addSplits` içindeki `second === "ki"` dalına `first.length >= 4` eklendi (`idi ki`, `var ki`, `yok ki` gibi 3 harfli gerçek çiftler zaten `pair > 0` bigram kuralından geçer).

6. **Bölme — çift bulunma eki yazım hatası koruması (`bölgedelerde → bölgedeler de`)**
   - **Neden:** `bölgelerde` yazım hatası olan `bölgedelerde`, `bölge + de + ler` (`Loc + Zero + Pres + A3pl`) Zemberek'te geçerli olduğu için `bölgedeler de` olarak bölünüyordu.
   - **Değişiklik:** `collapsedDoubledLocative` (`src/rules/turkish-rules.ts`) eklendi; `first` `[dt]eler`/`[dt]alar` (uzunluk ≥ 7) ile bitip `second` uyumlu `de`/`da` olduğunda, aradaki tekrarlı bulunma eki kaldırılmış biçim (`bölgelerde`) geçerli ve sözlükte hem ≥ 20 hem de `first`'in en az 10 katı sık ise bölme engellenir. Gerçek `bölgelerdede → bölgelerde de` bölünmesi etkilenmez.

### B. Başarısız 3 Testin İncelenmesi ve Kararlar (`src/corrector.test.ts`, `src/corrector.ts`)

1. **`synthetic regression tests` (`'Bu kitapta yazılı.'` beklenirken `'Bu kitapta yazımı.'`) — Test kurulumu eksikti (kod doğru)**
   - **Neden:** Sentetik testteki küçük yapay sözlükte `yazım` ve `yazımı` (`794`) tanımlanmış, ancak `yazılı` kelimesi `validWords` / `unigrams` içine eklenmemişti; motor bunu sözlük dışı geçersiz kelime sanıp 1 düzenleme uzaklıktaki `yazımı`ya çeviriyordu.
   - **Karar:** `yazılı` sentetik testin `validWords` ve `unigrams` listesine eklendi; beklenti (`"Bu kitapta yazılı."`) aynen korundu.

2. **`fixes (v5): Bu dizustu bilgisayari oyun icin alan var mi?` (`var mi?` düzeltilmiyordu) — Kod hatalıydı (beklenti doğru)**
   - **Neden:** `addQuestionHarmony` ters ünlü uyumunu `isRealWord(prev + "de") || isRealWord(prev + "te")` ile sınamaktaydı. `prev = "var"` için Zemberek `varde` biçimini **`varit` (`Voicing + LastVowelDrop`) + yönelme `-e`** olarak geçerli sayıyor, `varda` da geçerli olduğundan `frontLoc && backLoc === true` çıkıp fonksiyon erken dönüyordu.
   - **Karar:** Test beklentisi değiştirilmedi. `Corrector.hasFrontLocative` ve `Corrector.hasBackLocative` eklenerek hem bulunma (`-de/-te`) hem ayrılma (`-den/-ten`) eklerinin birlikte geçerli olması şart koşuldu (`varden` geçersiz, `vardan` geçerli; gerçek ters uyumlu `saatte/saatten`, `hayalde/hayalden`, `alkolde/alkolden` korunur). Aynı güvenli kontrol `addSplits`'teki `inverseHarmonyTypo` için de kullanıldı.

3. **`keeps (v5): Neredeyse orada oluyorduk.` (`ölüyorduk` yapılıyordu) — Test girdisi hatalıydı (kod doğru)**
   - **Neden:** `oluyorduk` gibi geçerli kelimeleri yüksek eşikle (`6.0`) koruyan kural özellikle Türkçe karakter içeren metinler (`textHasMarks === true`, `conv-clean-2054`: `"Yapay zekâyı kolluyor, ona yardımcı oluyorduk."`) içindir. `"Neredeyse orada oluyorduk."` cümlesinde tek bir Türkçe karakter bile bulunmadığından `textHasMarks === false` olmakta ve ASCII klavye bağlamında `"Neredeyse orada ölüyorduk."` okuması haklı olarak seçilmektedir.
   - **Karar:** Test cümlesi, sınanmak istenen gerçek `conv-clean-2054` örneğiyle (`"Yapay zekâyı kolluyor, ona yardımcı oluyorduk."`) değiştirildi.

### C. 2. Turda Eklenen Regresyon Testleri

- `src/corrector.test.ts` içinde hem yardımcı fonksiyon testlerine, hem sentetik regresyon testine (`varde` çarpışmasını simüle eden `var mi?` testi dahil), hem de tam sözlüklü `extraFixes`/`extraKeeps` listelerine bu turdaki 6 yanlış alarm ve `Ravenna'nin → Ravenna'nın` koruma örneği eklendi.
