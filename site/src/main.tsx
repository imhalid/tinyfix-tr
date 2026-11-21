// mizan (pano-ui) derlenmiş stilleri; güncellemek için: scripts/sync-mizan.sh
import "./vendor/mizan/mizan.css";
import "./app.css";
import { render } from "@solidjs/web";
import { App } from "./App";

const root = document.getElementById("app");
if (root) {
  render(() => <App />, root);
}
