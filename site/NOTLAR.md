# `site/` Mimari, SolidJS 2.0 ve Mizan Notları

## Teknoloji seçimi
- **SolidJS 2.0 (`solid-js` 2.0.3, `@solidjs/web` 2.0.3, `vite-plugin-solid` 3.0.0-next.27)** + **Vite 6** + **Tiptap (MIT)** + **Mizan (`mizan/styles.css`)**.
- Yazı tipleri sistem yerel yığınlarından (`var(--font-sans)`, `var(--font-mono)`) gelir; dış font sunucusuna istek yapılmaz.
- Otomatik düzeltme motoru (`site/src/autocorrectExtension.ts`) ProseMirror/Tiptap eklentisi olarak çerçeveden bağımsızdır ve doğrudan korunmuştur.

## SolidJS 2.0 uyarlamaları
- `tsconfig.json` içinde `"jsx": "preserve"` ve `"jsxImportSource": "@solidjs/web"` kullanıldı. `solid-js` 2.0.3 paketi `./jsx-runtime` ihraç etmiyor; JSX türleri ve runtime girişi `@solidjs/web` 2.0.3 içinde (`./jsx-runtime` → `./types/jsx.d.ts`).
- DOM'a bağlama `import { render } from "@solidjs/web";` ile yapılır (`site/src/main.tsx`).
- Bileşen yaşam döngüsünde Solid 2.0 ilkeleri izlendi:
  - `onMount` yerine `onSettled(() => { ... return () => cleanup(); })`
  - İki fazlı `createEffect(compute, effect)`
  - `splitProps` / `mergeProps` yerine `omit()`
  - `<For each={...} keyed={(item) => item.id}>` ile DOM düğümlerinin kimliği korundu (özellikle belge listesi ve `Toaster` çıkış geçişleri için)
  - Solid 2.0 JSX türleriyle uyumlu küçük harfli HTML öznitelikleri (`tabindex`, `for`, `spellcheck`, `autocomplete`), kebap-case SVG öznitelikleri (`stroke-width`, `stroke-linecap`, `stroke-linejoin`) ve dizge ARIA değerleri (`"true"` / `"false"`).

## Mizan (pano-ui) kullanımı ve seçilen bileşenler
Stil katmanı olarak `site/package.json` içinde `"mizan": "file:../../pano-ui"` eklendi ve `site/src/main.tsx` girişinde yalnızca `import "mizan/styles.css";` içe aktarıldı; Mizan'ın React JavaScript'i içe aktarılmıyor. `site/vite.config.ts` içindeki `server.fs.allow` listesine `"../.."` eklendi ki geliştirme sunucusu `../../pano-ui/dist/mizan.css` dosyasını sunabilsin.

`site/src/ui/` altına yalnızca bu uygulamada kullanılan bileşenlerin Solid 2.0 sürümleri yazıldı. Her biri Mizan'ın React sürümüyle aynı DOM yapısını, sınıf adlarını ve `data-*`/`aria-*` özniteliklerini üretir:

- **`Button`** (`Button.tsx`): araç çubuğu, yeni belge, ayarlar/gizlilik/silme eylemleri, dialog/sheet kapatma ve uyarı düğmeleri için temel etkileşim bileşeni.
- **`Spinner`** (`Spinner.tsx`): `Button` (`loading`) ve `Toaster` (`loading` tonu) bağımlılığı.
- **`Switch`** (`Switch.tsx`): anında etkili otomatik düzeltme, bağlam modeli ve dört düzeltme türü anahtarları (`role="switch"`, `.check-row`).
- **`Segmented`** (`Segmented.tsx`): ayarlarda Hassasiyet kipi (`Temkinli` / `Dengeli`) ve Görünüm (`Sistem` / `Açık` / `Koyu`) tekli seçicileri (CSS anchor + `ResizeObserver` yedeği).
- **`Field`** (`Field.tsx`): ayarlarda etiket + kontrol + yardım metni bağlantısı (`FieldContext`).
- **`Input`** (`Input.tsx`): yoksayılan kelime ekleme kutusu (`clearable`, dolu iken `Esc` ile temizleme).
- **`Chips`** (`Chips.tsx`): yoksayılan kelimelerin kaldırılabilir jeton listesi (`tokens`, `Backspace`/`Delete` ile çıkarma).
- **`Sheet`** (`Sheet.tsx`): yerel `<dialog closedby="any">` üstünde; (1) Ayarlar paneli (`side="auto"`, masaüstünde sağdan, telefonda alttan sürüklenebilir çekmece), (2) dar ekranda belgeler listesi (`side="start"`).
- **`Dialog`** (`Dialog.tsx`): yerel `<dialog>` üstünde; (1) Gizlilik ve internetsiz çalışma açıklaması (`role="dialog"`), (2) belge silme onayı (`role="alertdialog"`, yerel `window.confirm` yerine).
- **`Menu`** (`Menu.tsx`): üst araç çubuğundaki Dışa aktar menüsü (`.txt` / `.md`); `popover="auto"` + `popovertarget` örtük çapasıyla, dışarı tıklama dinleyicisi yazmadan.
- **`NavList`** (`NavList.tsx`): sol kenar çubuğundaki ve mobil çekmecedeki dar belge listesi (`aria-current="page"`).
- **`Toolbar`** ve **`ToggleGroup`** (`Toolbar.tsx`, `ToggleGroup.tsx`): üstte tek sekme duraklı, ok tuşlarıyla gezilen sade biçimlendirme şeridi (Başlık, Kalın, İtalik, Madde listesi, Alıntı + dikey `Separator` + Geri al).
- **`Separator`** (`Separator.tsx`): biçimlendirme şeridinde dikey, ayarlar bölümleri arasında yatay oyuk ayırıcı.
- **`Toaster`** ve **`toast()`** (`Toaster.tsx`): düzeltme geri alındığında «Bir daha değiştirme» eylemli bildirim ve belge silindi bildirimi (`popover="manual"`, imleç/odak/gizli sekmede duran süre, kaydırarak kapatma).
- **`Alert`** (`Alert.tsx`): sözlük dosyaları yüklenemediğinde kısa açıklama + «Tekrar dene» / «Gizle» eylemleri ve ayarlarda bağlam modeli uyarısı.
- **`Progress`** (`Progress.tsx`): sözlük ve bağlam modeli indirilirken yazı alanının üstünde ince, sessiz ilerleme göstergesi (`thin`).
- **`StatusDot`** (`StatusDot.tsx`): alt durum çubuğunda «İnternetsiz hazır» / «Çevrimdışı hazır» / «Sözlük indiriliyor…» göstergesi.
- **`Kbd`** (`Kbd.tsx`): alt durum çubuğunda son düzeltmenin yanında `<Kbd>⌘</Kbd><Kbd>Z</Kbd>` / `<Kbd>Ctrl</Kbd><Kbd>Z</Kbd>` geri alma ipucu.
- **`Tooltip`** (`Tooltip.tsx`): ikon düğmelerinde kısa açıklamalar (`popover="hint"` + Interest Invokers + CSS yedeği).
- **`ThemeToggle`** (`ThemeToggle.tsx`): kenar çubuğunda tek dokunuşla tema geçişi (View Transitions destekleyen tarayıcıda daire açılımı).

**Bilinçli olarak eklenmeyenler:** `Checkbox` (ayarlardaki tüm açık/kapalı tercihler anında etkili olduğu için tutarlı biçimde `Switch` seçildi) ve `EmptyState` (belge listesinde her zaman en az bir belge tutuluyor; yoksayılan kelimelerin boş durumu için çekmece içinde tek satırlık sessiz metin yeterli).

## Tema ve stil ilkeleri
- Tema yalnızca `color-scheme` ile yönetilir: `settings.theme === "system"` olduğunda `<html data-theme>` kaldırılır ve işletim sistemi tercihi izlenir; `"light"` veya `"dark"` seçildiğinde `data-theme` yazılır.
- `site/src/app.css` içinde hiçbir sabit renk (hex/`rgb`/`hsl`), özel gölge ya da `[data-theme="dark"]` kuralı yoktur; tamamı Mizan token'larını (`--bg`, `--card`, `--well`, `--text`, `--text-2`, `--muted`, `--hairline`, `--accent`, `--up`, `--radius-*`, `--fs-*`, `--ease`) ve `color-mix(in oklab, ...)` kullanır.

## Sözlük, bağlam modeli, ORT WASM ve Service Worker
- Model dosyaları `./models/` (`site/public/models/`) altından okunur: `unigrams.tsv`, `bigrams.tsv`, `known.tsv` (zorunlu) ve `context.onnx` (isteğe bağlı, ~2 MB).
- `site/vite.config.ts` içindeki `ortWasmPlugin()` korundu: `vite dev` sırasında `/ort/*` isteklerini doğrudan `onnxruntime-web/dist/` dizininden sunar, `vite build` sırasında `dist/ort/` içine kopyalar.
- `site/scripts/generate-sw.mjs` korundu: `npm run build` sonunda uygulama kabuğu (`autr-shell-*`), sözlük/model (`autr-models-*`) ve ORT WASM (`autr-ort-*`) için ayrı önbellekli `dist/sw.js` üretir.
- `pkg/` ve `src/` klasörlerine dokunulmadı; paket tarafında yeni bir değişiklik gerekmedi.
