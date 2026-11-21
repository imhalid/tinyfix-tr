import { loadAutr, type Autr, type FixKind, type LoadProgress, type Mode } from "autr";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import { undoAppliedFix, type AppliedFix, type BatchProgress } from "./autocorrectExtension";
import { APP_NAME, APP_TAGLINE, MODELS_BASE_URL, ORT_WASM_BASE_URL } from "./brand";
import { DocumentsList } from "./components/DocumentsDrawer";
import { EditorPane } from "./components/EditorPane";
import { FixPopover } from "./components/FixPopover";
import { BoldIcon, HeadingIcon, ItalicIcon, ListIcon, QuoteIcon, ScanIcon, UndoIcon } from "./components/Icons";
import { Modal, PrivacyDialog } from "./components/PrivacyDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { Drawer } from "./kit/Drawer";
import { formatBytesTr, formatLongDateTr, formatNumberTr, isMacPlatform } from "./kit/format";
import { Toasts, toast } from "./kit/toast";
import type { EditorController } from "./editor";
import { downloadTextFile, serializeMarkdown, serializePlainText } from "./export";
import { waitForServiceWorker, watchOfflineStatus, type OfflineState } from "./offline";
import {
  applyTheme,
  detectSystemTheme,
  getActiveKinds,
  loadSettings,
  normalizeWordTr,
  saveSettings,
  type AppSettings,
  type ResolvedTheme,
  type Theme,
} from "./settings";
import {
  countWords,
  createEmptyDocument,
  createWelcomeDocument,
  deleteDocument,
  extractPreview,
  listDocuments,
  loadLastActiveDocId,
  saveDocument,
  saveLastActiveDocId,
  type DocRecord,
} from "./storage";

type FormatKey = "heading" | "bold" | "italic" | "bulletList" | "blockquote";

interface StatusActivity {
  text: string;
  showUndoHint: boolean;
}


export function App() {
  const initialSettings = loadSettings();
  applyTheme(initialSettings.theme);
  document.title = `${APP_NAME} — ${APP_TAGLINE}`;

  const mac = isMacPlatform();
  const modKey = mac ? "⌘" : "Ctrl";
  const undoShortcut = mac ? "⌘Z" : "Ctrl+Z";

  const [settings, setSettings] = createSignal<AppSettings>(initialSettings);
  const [systemTheme, setSystemTheme] = createSignal<ResolvedTheme>(detectSystemTheme());
  const [docs, setDocs] = createSignal<DocRecord[]>([]);
  const [activeDocId, setActiveDocId] = createSignal<string>("");
  const [docsReady, setDocsReady] = createSignal(false);
  const [focusTitleSeq, setFocusTitleSeq] = createSignal(0);

  const [autr, setAutr] = createSignal<Autr | null>(null);
  const [engineStatus, setEngineStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [engineProgress, setEngineProgress] = createSignal<LoadProgress | null>(null);
  const [contextAvailable, setContextAvailable] = createSignal(false);
  /** Tıklanan düzeltilmiş kelime: pencerede ayrıntısı ve geri alma seçeneği gösterilir. */
  const [openFix, setOpenFix] = createSignal<{ fix: AppliedFix; anchor: HTMLElement } | null>(null);

  /** Penceredeki "Geri al" ve "Bir daha değiştirme" için: düzeltmeyi geri alır, durum çubuğuna yazar. */
  const undoFromPopover = (fix: AppliedFix, neverChange: boolean) => {
    setOpenFix(null);
    const view = editorController?.editor.view;
    if (!view || !undoAppliedFix(view, fix.id)) return;
    if (neverChange) addIgnoredWord(fix.original);
    setLastActivity({
      text: neverChange ? `«${fix.original}» geri alındı, bir daha değiştirilmeyecek` : `«${fix.original}» geri alındı`,
      showUndoHint: false,
    });
    view.focus();
  };
  const [contextWarning, setContextWarning] = createSignal<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);

  const [offline, setOffline] = createSignal<OfflineState>({
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    swReady: false,
    swSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  });

  const [docsOpen, setDocsOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [privacyOpen, setPrivacyOpen] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<DocRecord | null>(null);

  const [wordCount, setWordCount] = createSignal(0);
  const [saveLabel, setSaveLabel] = createSignal("Kaydedildi");
  const [lastActivity, setLastActivity] = createSignal<StatusActivity | null>(null);
  const [batchProgress, setBatchProgress] = createSignal<BatchProgress | null>(null);
  const [activeFormats, setActiveFormats] = createSignal<FormatKey[]>([]);

  let editorController: EditorController | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let engineLoadSeq = 0;
  let engineAbort: AbortController | null = null;
  let disposed = false;


  const sortedDocs = createMemo(() => [...docs()].sort((a, b) => b.updatedAt - a.updatedAt));

  const activeDoc = createMemo(() => {
    const id = activeDocId();
    const list = docs();
    return list.find((doc) => doc.id === id) ?? list[0];
  });

  const updateSettings = (updater: (prev: AppSettings) => AppSettings) => {
    setSettings((prev) => {
      const next = updater(prev);
      saveSettings(next);
      return next;
    });
  };

  const persistActiveDocNow = async (): Promise<void> => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const current = activeDoc();
    if (!current) return;
    try {
      await saveDocument(current);
      setSaveLabel("Kaydedildi");
    } catch {
      setSaveLabel("Kayıt başarısız");
    }
  };

  const scheduleSave = () => {
    setSaveLabel("Kaydediliyor…");
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persistActiveDocNow();
    }, 350);
  };

  const syncFormats = () => {
    if (!editorController) {
      setActiveFormats([]);
      return;
    }
    const { editor } = editorController;
    const next: FormatKey[] = [];
    if (editor.isActive("heading", { level: 2 })) next.push("heading");
    if (editor.isActive("bold")) next.push("bold");
    if (editor.isActive("italic")) next.push("italic");
    if (editor.isActive("bulletList")) next.push("bulletList");
    if (editor.isActive("blockquote")) next.push("blockquote");
    setActiveFormats(next);
  };

  const initAutrEngine = async () => {
    const loadSeq = ++engineLoadSeq;
    engineAbort?.abort();
    const abortController = new AbortController();
    engineAbort = abortController;
    setContextWarning(null);

    const prevAutr = autr();
    if (prevAutr) {
      setAutr(null);
      await prevAutr.dispose().catch(() => {});
    }
    if (disposed || loadSeq !== engineLoadSeq) return;

    setBannerDismissed(false);
    setEngineStatus("loading");
    setEngineProgress({ ratio: 0, loaded: 0, total: null, stage: "downloading" });

    const currentSettings = settings();
    try {
      // İlk ziyarette sözlüğün service worker üzerinden tek seferde inip önbelleğe yazılması için.
      await waitForServiceWorker();
      // Bağlam modeli yalnızca dosyası sitede varsa istenir; yoksa ayarı da gösterilmez.
      const available = await fetch(`${MODELS_BASE_URL}manifest.json`)
        .then((response) => (response.ok ? response.json() : {}))
        .then((sizes: Record<string, number>) => typeof sizes["context.onnx"] === "number")
        .catch(() => false);
      setContextAvailable(available);
      const instance = await loadAutr({
        baseUrl: MODELS_BASE_URL,
        wasmPaths: ORT_WASM_BASE_URL,
        context: currentSettings.contextModel && available,
        worker: true,
        mode: currentSettings.mode,
        ignored: currentSettings.ignoredWords,
        signal: abortController.signal,
        onProgress: (progress) => {
          if (disposed || loadSeq !== engineLoadSeq) return;
          setEngineProgress(progress);
        },
        onWarning: (warning) => {
          if (disposed || loadSeq !== engineLoadSeq) return;
          setContextWarning(warning);
        },
      });
      if (disposed || loadSeq !== engineLoadSeq) {
        await instance.dispose().catch(() => {});
        return;
      }
      setAutr(instance);
      setEngineStatus("ready");
      // Sözlük yüklenirken yazılanları denetle. Solid 2'de yazılan sinyal bir sonraki turda okunur, o yüzden bekletiyoruz.
      setTimeout(() => editorController?.checkWaitingText(), 0);
    } catch (error) {
      if (disposed || loadSeq !== engineLoadSeq || abortController.signal.aborted) return;
      console.error("autr: sözlük yüklenemedi", error);
      setEngineStatus("error");
    }
  };

  onSettled(() => {
    // Sistem teması ve dar ekran dinleyicileri
    const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
    const onDarkChange = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
    darkMedia.addEventListener("change", onDarkChange);


    const stopOffline = watchOfflineStatus((nextOffline) => {
      setOffline(nextOffline);
    });

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        void persistActiveDocNow();
      }
    };
    const onBeforeUnload = () => {
      void persistActiveDocNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);

    // Belgeleri IndexedDB'den yükle
    void (async () => {
      let loaded: DocRecord[] = [];
      try {
        loaded = await listDocuments();
      } catch {
        loaded = [];
      }
      if (disposed) return;
      if (loaded.length === 0) {
        const welcome = createWelcomeDocument();
        loaded = [welcome];
        await saveDocument(welcome).catch(() => {});
      }
      const lastId = loadLastActiveDocId();
      const initial = loaded.find((doc) => doc.id === lastId) ?? loaded[0]!;
      saveLastActiveDocId(initial.id);
      setDocs(loaded);
      setActiveDocId(initial.id);
      setWordCount(initial.wordCount);
      setDocsReady(true);
    })();

    // Otomatik düzeltme motorunu başlat
    void initAutrEngine();

    return () => {
      disposed = true;
      engineAbort?.abort();
      if (saveTimer !== null) clearTimeout(saveTimer);
      darkMedia.removeEventListener("change", onDarkChange);
      stopOffline();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      const currentAutr = autr();
      if (currentAutr) void currentAutr.dispose().catch(() => {});
    };
  });

  // Ayar işlemleri
  const handleToggleEnabled = (enabled: boolean) => {
    updateSettings((prev) => ({ ...prev, enabled }));
  };

  const handleToggleContextModel = (contextModel: boolean) => {
    updateSettings((prev) => ({ ...prev, contextModel }));
    void initAutrEngine();
  };

  const handleChangeMode = (mode: Mode) => {
    updateSettings((prev) => ({ ...prev, mode }));
    autr()?.setMode(mode);
  };

  const handleToggleKind = (kind: FixKind, enabled: boolean) => {
    updateSettings((prev) => ({
      ...prev,
      kinds: { ...prev.kinds, [kind]: enabled },
    }));
  };

  const addIgnoredWord = (rawWord: string) => {
    const normalized = normalizeWordTr(rawWord);
    if (!normalized) return;
    if (settings().ignoredWords.includes(normalized)) return;
    updateSettings((prev) => ({
      ...prev,
      ignoredWords: [...prev.ignoredWords, normalized].sort((a, b) => a.localeCompare(b, "tr")),
    }));
    autr()?.ignore(normalized);
  };

  const removeIgnoredWord = (word: string) => {
    updateSettings((prev) => ({
      ...prev,
      ignoredWords: prev.ignoredWords.filter((item) => item !== word),
    }));
    autr()?.unignore(word);
  };

  const handleChangeTheme = (theme: Theme) => {
    applyTheme(theme);
    updateSettings((prev) => ({ ...prev, theme }));
  };

  // Belge işlemleri
  const openDocument = async (id: string) => {
    if (id === activeDocId()) {
      setDocsOpen(false);
      return;
    }
    await persistActiveDocNow();
    setActiveDocId(id);
    saveLastActiveDocId(id);
    setLastActivity(null);
    setBatchProgress(null);
    setDocsOpen(false);
  };

  const handleNewDoc = async () => {
    await persistActiveDocNow();
    const fresh = createEmptyDocument();
    setDocs((prev) => [fresh, ...prev]);
    setActiveDocId(fresh.id);
    saveLastActiveDocId(fresh.id);
    setLastActivity(null);
    setBatchProgress(null);
    setWordCount(0);
    setDocsOpen(false);
    await saveDocument(fresh).catch(() => {});
    setFocusTitleSeq((n) => n + 1);
  };

  const confirmDeleteDoc = async () => {
    const target = pendingDelete();
    setPendingDelete(null);
    if (!target) return;

    await deleteDocument(target.id).catch(() => {});
    let remaining = docs().filter((doc) => doc.id !== target.id);
    if (remaining.length === 0) {
      const replacement = createEmptyDocument();
      remaining = [replacement];
      await saveDocument(replacement).catch(() => {});
    }
    setDocs(remaining);
    if (activeDocId() === target.id) {
      const next = remaining[0]!;
      setActiveDocId(next.id);
      saveLastActiveDocId(next.id);
      setLastActivity(null);
      setBatchProgress(null);
    }
    toast({ title: "Belge silindi", duration: 3500 });
  };

  const handleTitleInput = (title: string) => {
    const id = activeDocId();
    if (!id) return;
    const now = Date.now();
    setDocs((prev) =>
      prev.map((doc) => (doc.id === id ? { ...doc, title, updatedAt: now } : doc)),
    );
    scheduleSave();
  };

  const handleEditorUpdate = (payload: { json: DocRecord["content"]; text: string }) => {
    const id = activeDocId();
    if (!id) return;
    const words = countWords(payload.text);
    const preview = extractPreview(payload.text);
    const now = Date.now();
    setWordCount(words);
    setDocs((prev) =>
      prev.map((doc) =>
        doc.id === id
          ? { ...doc, content: payload.json, preview, wordCount: words, updatedAt: now }
          : doc,
      ),
    );
    scheduleSave();
  };

  // Biçimlendirme araç çubuğu
  const formatOptions: readonly { value: FormatKey; label: string; icon: () => JSX.Element }[] = [
    { value: "heading", label: "Alt başlık", icon: () => <HeadingIcon /> },
    { value: "bold", label: `Kalın (${modKey}+B)`, icon: () => <BoldIcon /> },
    { value: "italic", label: `İtalik (${modKey}+I)`, icon: () => <ItalicIcon /> },
    { value: "bulletList", label: "Madde listesi", icon: () => <ListIcon /> },
    { value: "blockquote", label: "Alıntı", icon: () => <QuoteIcon /> },
  ];

  const handleToggleFormat = (key: FormatKey) => {
    if (!editorController) return;
    const chain = editorController.editor.chain().focus();
    switch (key) {
      case "heading":
        chain.toggleHeading({ level: 2 }).run();
        break;
      case "bold":
        chain.toggleBold().run();
        break;
      case "italic":
        chain.toggleItalic().run();
        break;
      case "bulletList":
        chain.toggleBulletList().run();
        break;
      case "blockquote":
        chain.toggleBlockquote().run();
        break;
    }
  };

  const handleUndo = () => {
    editorController?.editor.chain().focus().undo().run();
  };

  /** "Tara": belgenin tamamını yeniden denetler; bulunan düzeltmeler her zamanki gibi bildirilir. */
  const handleScan = () => {
    if (!editorController) return;
    if (engineStatus() !== "ready") {
      setLastActivity({ text: "Sözlük hazır olunca tarayabilirsiniz", showUndoHint: false });
      return;
    }
    editorController.checkAllText();
    setLastActivity({
      text: "Metin tarandı",
      showUndoHint: false,
    });
  };

  const exportItems: readonly { label: string; kbd: string; onSelect: () => void }[] = [
    {
      label: "Düz metin",
      kbd: ".txt",
      onSelect: () => {
        const doc = activeDoc();
        if (!editorController || !doc) return;
        downloadTextFile(doc.title, serializePlainText(editorController.getDocNode()), "txt");
      },
    },
    {
      label: "Markdown",
      kbd: ".md",
      onSelect: () => {
        const doc = activeDoc();
        if (!editorController || !doc) return;
        downloadTextFile(doc.title, serializeMarkdown(editorController.getDocNode()), "md");
      },
    },
  ];

  // Durum metinleri
  const modeChipLabel = () => {
    if (!settings().enabled) return "Düzeltme kapalı";
    if (engineStatus() === "loading") return "Hazırlanıyor…";
    if (engineStatus() === "error") return "Sözlük eksik";
    return settings().mode === "careful" ? "Temkinli" : "Dengeli";
  };

  const progressPercent = () => Math.round((engineProgress()?.ratio ?? 0) * 100);

  const progressIndeterminate = () => {
    const p = engineProgress();
    return !p || p.stage === "parsing" || p.loaded === 0;
  };

  const progressLabel = () => {
    const p = engineProgress();
    if (p?.stage === "parsing") {
      return p.file === "context.onnx"
        ? "Bağlam modeli hazırlanıyor…"
        : "Türkçe sözlük hazırlanıyor…";
    }
    const base = settings().contextModel
      ? "Sözlük ve bağlam modeli indiriliyor…"
      : "Sözlük indiriliyor…";
    if (p && p.loaded > 0) {
      const size =
        p.total !== null
          ? `${formatBytesTr(p.loaded)} / ${formatBytesTr(p.total)}`
          : formatBytesTr(p.loaded);
      return `${base} (${size})`;
    }
    return base;
  };


  const statusDotLabel = () => {
    if (engineStatus() === "loading") {
      // Üstteki şeritle aynı aşamayı söyler; yüzde yalnızca gerçekten biliniyorsa gösterilir.
      const p = engineProgress();
      if (p?.stage === "parsing") return "Sözlük hazırlanıyor…";
      return progressIndeterminate() ? "Sözlük indiriliyor…" : `Sözlük indiriliyor… %${progressPercent()}`;
    }
    if (engineStatus() === "error") {
      return offline().online ? "Sözlük yüklenemedi" : "Çevrimdışı (sözlük yok)";
    }
    if (!offline().online) return "Çevrimdışı hazır";
    if (offline().swReady) return "İnternetsiz hazır";
    return "Yerel sözlük hazır";
  };

  const exportMenuId = "export-menu";

  const handleOpenPrivacy = () => {
    setDocsOpen(false);
    setSettingsOpen(false);
    setPrivacyOpen(true);
  };

  return (
    <div class="page">
      <aside class="sidebar" aria-label="Belgeler">
        <div class="sidebar-brand">
          <span class="sidebar-wordmark">{APP_NAME}</span>
          <span class="sidebar-tagline">Türkçe yazım, internetsiz</span>
        </div>
        <DocumentsList
          docs={sortedDocs()}
          activeDocId={activeDocId()}
          onNewDoc={() => void handleNewDoc()}
          onSelectDoc={(id) => void openDocument(id)}
          onRequestDeleteDoc={(doc) => setPendingDelete(doc)}
          onOpenPrivacy={handleOpenPrivacy}
        />
      </aside>

      <div class="main-col">
      <header class="masthead">
        <nav class="masthead-start" aria-label="Uygulama">
          <button type="button" class="wordmark" onClick={() => setDocsOpen(true)} aria-label={`${APP_NAME}, belgeleri aç`}>
            {APP_NAME}
          </button>
          <button type="button" class="text-button" aria-haspopup="dialog" onClick={() => setDocsOpen(true)}>
            Belgeler
          </button>
        </nav>

        <div
          class="format-bar"
          role="toolbar"
          aria-label="Biçimlendirme"
          onMouseDown={(event) => {
            // Biçim düğmelerine basılınca editördeki seçim kaybolmasın.
            if ((event.target as Element).closest("button")) event.preventDefault();
          }}
        >
          <For each={formatOptions}>
            {(option) => (
              <button
                type="button"
                class="icon-button"
                aria-label={option.label}
                title={option.label}
                aria-pressed={activeFormats().includes(option.value) ? "true" : "false"}
                onClick={() => handleToggleFormat(option.value)}
              >
                {option.icon()}
              </button>
            )}
          </For>
          <span class="format-sep" aria-hidden="true" />
          <button
            type="button"
            class="icon-button"
            aria-label={`Geri al (${undoShortcut})`}
            title={`Geri al (${undoShortcut})`}
            onClick={handleUndo}
          >
            <UndoIcon />
          </button>
          <button type="button" class="icon-button" aria-label="Metni yeniden tara" title="Metni yeniden tara" onClick={handleScan}>
            <ScanIcon />
          </button>
        </div>

        <div class="masthead-end">
          <span class="status" data-state={engineStatus()} title={statusDotLabel()}>
            <span class="status-dot" aria-hidden="true" />
            <span class="status-text">{statusDotLabel()}</span>
          </span>
          <button type="button" class="text-button" popovertarget={exportMenuId}>
            Dışa aktar
          </button>
          <div id={exportMenuId} popover="auto" class="menu" role="menu" aria-label="Dışa aktar">
            <For each={exportItems}>
              {(item) => (
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  onClick={(event) => {
                    item.onSelect();
                    (event.currentTarget.closest("[popover]") as HTMLElement | null)?.hidePopover();
                  }}
                >
                  <span>{item.label}</span>
                  <span class="menu-kbd">{item.kbd}</span>
                </button>
              )}
            </For>
          </div>
          <button type="button" class="text-button" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
            Ayarlar
            <Show when={!settings().enabled}>
              <span class="off-note"> · düzeltme kapalı</span>
            </Show>
          </button>
        </div>
      </header>

      <Show when={!bannerDismissed() && engineStatus() === "loading"}>
        <div class="loading" aria-live="polite">
          <div
            class="loading-track"
            role="progressbar"
            aria-label={progressLabel()}
            aria-valuenow={progressIndeterminate() ? undefined : progressPercent()}
            aria-valuemin={0}
            aria-valuemax={100}
            data-indeterminate={progressIndeterminate() ? "" : undefined}
          >
            <span class="loading-bar" style={{ width: `${progressPercent()}%` }} />
          </div>
          <span class="loading-label">{progressLabel()}</span>
        </div>
      </Show>

      <Show when={!bannerDismissed() && engineStatus() === "error"}>
        <div class="notice" role="alert">
          <p>
            <strong>Sözlük yüklenemedi.</strong> Yazmaya devam edebilirsiniz; düzeltme sözlük gelince başlar.
          </p>
          <div class="notice-actions">
            <button type="button" class="button" onClick={() => void initAutrEngine()}>
              Tekrar dene
            </button>
            <button type="button" class="text-button" onClick={() => setBannerDismissed(true)}>
              Gizle
            </button>
          </div>
        </div>
      </Show>

      <main class="sheet">
        <Show when={docsReady() && activeDoc()}>
          {(doc) => (
            <EditorPane
              docId={doc().id}
              title={doc().title}
              focusTitleSeq={focusTitleSeq()}
              meta={
                <>
                  {formatLongDateTr(doc().updatedAt)} · {formatNumberTr(wordCount())} kelime
                </>
              }
              getInitialContent={() => doc().content}
              getRuntime={() => ({
                autr: autr(),
                enabled: settings().enabled,
                activeKinds: getActiveKinds(settings()),
              })}
              onTitleInput={handleTitleInput}
              onUpdate={handleEditorUpdate}
              onSelectionChange={syncFormats}
              onController={(controller) => {
                editorController = controller;
                if (controller) {
                  const text = controller.editor.getText({ blockSeparator: "\n\n" });
                  setWordCount(countWords(text));
                  syncFormats();
                }
              }}
              onApplied={(fix: AppliedFix) => {
                setLastActivity({ text: `«${fix.original}» → «${fix.replacement}»`, showUndoHint: true });
              }}
              onBatchApplied={(fixes) => {
                setLastActivity({ text: `${fixes.length} düzeltme uygulandı`, showUndoHint: true });
              }}
              onFixClick={(fix: AppliedFix, element: HTMLElement) => setOpenFix({ fix, anchor: element })}
              onUndo={(fix: AppliedFix) => {
                setLastActivity({ text: `«${fix.original}» geri alındı`, showUndoHint: false });
                toast({
                  id: `undo-${fix.original}`,
                  title: `«${fix.original}» geri alındı`,
                  duration: 7500,
                  action: { label: "Bir daha değiştirme", onClick: () => addIgnoredWord(fix.original) },
                });
              }}
              onBatchUndo={(fixes) => {
                setLastActivity({ text: `${fixes.length} düzeltme geri alındı`, showUndoHint: false });
              }}
              onBatchProgress={(progress) => setBatchProgress(progress)}
            />
          )}
        </Show>
      </main>

      <footer class="footnote" aria-live="polite">
        <span>{saveLabel()}</span>
        <Show
          when={batchProgress()}
          fallback={
            <Show when={lastActivity()}>
              {(activity) => (
                <span class="footnote-activity">
                  {activity().text}
                  <Show when={activity().showUndoHint}>
                    <kbd>{undoShortcut}</kbd>
                  </Show>
                </span>
              )}
            </Show>
          }
        >
          {(bp) => (
            <span class="footnote-activity">
              Denetleniyor… {bp().processed}/{bp().total}
            </span>
          )}
        </Show>
      </footer>
      </div>

      <Drawer open={docsOpen()} onClose={() => setDocsOpen(false)} side="start" title="Belgeler">
        <DocumentsList
          docs={sortedDocs()}
          activeDocId={activeDocId()}
          onNewDoc={() => void handleNewDoc()}
          onSelectDoc={(id) => void openDocument(id)}
          onRequestDeleteDoc={(doc) => {
            setDocsOpen(false);
            setPendingDelete(doc);
          }}
          onOpenPrivacy={handleOpenPrivacy}
        />
      </Drawer>

      <Drawer
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        side="end"
        title="Ayarlar"
        description="Tüm tercihler yalnızca bu cihazda saklanır."
      >
        <SettingsPanel
          settings={settings()}
          contextWarning={contextWarning()}
          contextAvailable={contextAvailable()}
          onToggleEnabled={handleToggleEnabled}
          onToggleContextModel={handleToggleContextModel}
          onChangeMode={handleChangeMode}
          onToggleKind={handleToggleKind}
          onAddIgnoredWord={addIgnoredWord}
          onRemoveIgnoredWord={removeIgnoredWord}
          onChangeTheme={handleChangeTheme}
        />
      </Drawer>

      <FixPopover
        fix={openFix()?.fix ?? null}
        anchor={openFix()?.anchor ?? null}
        onUndo={(fix) => undoFromPopover(fix, false)}
        onNeverChange={(fix) => undoFromPopover(fix, true)}
        onClose={() => setOpenFix(null)}
      />

      <PrivacyDialog open={privacyOpen()} onClose={() => setPrivacyOpen(false)} />

      <Modal
        role="alertdialog"
        open={pendingDelete() !== null}
        title="Belgeyi sil"
        onClose={(returnValue) => {
          if (returnValue === "confirm") void confirmDeleteDoc();
          else setPendingDelete(null);
        }}
        actions={
          <>
            <button type="submit" class="button" value="cancel">
              Vazgeç
            </button>
            <button type="submit" class="button button-danger" value="confirm">
              Sil
            </button>
          </>
        }
      >
        <p>«{pendingDelete()?.title.trim() || "Adsız belge"}» bu cihazdan kalıcı olarak silinecek.</p>
      </Modal>

      <Toasts />
    </div>
  );
}
