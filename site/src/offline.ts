export interface OfflineState {
  online: boolean;
  swReady: boolean;
  swSupported: boolean;
}

/**
 * Sayfa bir service worker tarafından yönetilene kadar (en fazla `timeoutMs`) bekler. Sözlük bundan sonra indirilirse
 * istek service worker'dan geçer ve tek indirmede önbelleğe de yazılır; internetsiz çalışma bunun üzerine kurulu.
 * Service worker yoksa ya da zamanında gelmezse hemen devam eder.
 */
export function waitForServiceWorker(timeoutMs = 4000): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) {
    return Promise.resolve();
  }
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", done);
  });
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
