export interface OfflineState {
  online: boolean;
  swReady: boolean;
  swSupported: boolean;
}

/** Service worker kaydını ve çevrimiçi/çevrimdışı durumunu takip eder. */
export function watchOfflineStatus(onChange: (state: OfflineState) => void): () => void {
  const state: OfflineState = {
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    swReady: false,
    swSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  };

  const notify = () => onChange({ ...state });

  const onOnline = () => {
    state.online = true;
    notify();
  };
  const onOffline = () => {
    state.online = false;
    notify();
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  if (state.swSupported && import.meta.env.PROD) {
    navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        state.swReady = true;
        notify();
      })
      .catch(() => {
        notify();
      });
  } else {
    notify();
  }

  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
