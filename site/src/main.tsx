// Yazı tipleri pakete gömülü; internetsiz çalışır, dışarıya istek yapmaz. Metin: Google Sans, başlıklar: Instrument Serif.
import "./fonts.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-ext-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/instrument-serif/latin-ext-400-italic.css";
import "./styles.css";
import { render } from "@solidjs/web";
import { App } from "./App";

const root = document.getElementById("app");
if (root) {
  render(() => <App />, root);
}
