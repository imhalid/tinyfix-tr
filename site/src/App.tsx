import { loadAutr, type Autr, type FixKind, type LoadProgress, type Mode } from "autr";
import { Show, createMemo, createSignal, onSettled } from "solid-js";
import type { AppliedFix, BatchProgress } from "./autocorrectExtension";
import { APP_NAME, APP_TAGLINE, MODELS_BASE_URL, ORT_WASM_BASE_URL } from "./brand";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { EditorPane } from "./components/EditorPane";
import {
  BoldIcon,
  ChevronDownIcon,
  DownloadIcon,
  HeadingIcon,
  ItalicIcon,
  ListIcon,
  QuoteIcon,
  SettingsIcon,
  SidebarIcon,
  UndoIcon,
} from "./components/Icons";
import { PrivacyDialog } from "./components/PrivacyDialog";
import { SettingsSheet } from "./components/SettingsSheet";
import type { EditorController } from "./editor";
import { downloadTextFile, serializeMarkdown, serializePlainText } from "./export";
import { watchOfflineStatus, type OfflineState } from "./offline";
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
import {
  Alert,
  Button,
  Dialog,
  Kbd,
  Menu,
  Progress,
  Separator,
  Sheet,
  StatusDot,
  Toaster,
  ToggleGroup,
  Toolbar,
  Tooltip,
  formatBytesTr,
  formatNumberTr,
  isMacPlatform,
  toast,
  type MenuItem,
  type ToggleOption,
} from "./ui";

type FormatKey = "heading" | "bold" | "italic" | "bulletList" | "blockquote";

interface StatusActivity {
  text: string;
  showUndoHint: boolean;
}

const MOBILE_MEDIA = "(max-width: 840px)";

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
  const [contextWarning, setContextWarning] = createSignal<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);

  const [offline, setOffline] = createSignal<OfflineState>({
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    swReady: false,
    swSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  });

  const [isMobile, setIsMobile] = createSignal(
    typeof window !== "undefined" ? window.matchMedia(MOBILE_MEDIA).matches : false,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [mobileSheetOpen, setMobileSheetOpen] = createSignal(false);
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

  const resolvedTheme = createMemo<ResolvedTheme>(() => {
    const theme = settings().theme;
    return theme === "system" ? systemTheme() : theme;
  });

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
      const instance = await loadAutr({
        baseUrl: MODELS_BASE_URL,
        wasmPaths: ORT_WASM_BASE_URL,
        context: currentSettings.contextModel,
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

    const mobileMedia = window.matchMedia(MOBILE_MEDIA);
    const onMobileChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setMobileSheetOpen(false);
    };
    mobileMedia.addEventListener("change", onMobileChange);

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
      mobileMedia.removeEventListener("change", onMobileChange);
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
      setMobileSheetOpen(false);
      return;
    }
    await persistActiveDocNow();
    setActiveDocId(id);
    saveLastActiveDocId(id);
    setLastActivity(null);
    setBatchProgress(null);
    setMobileSheetOpen(false);
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
    setMobileSheetOpen(false);
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
    toast({ title: "Belge silindi", tone: "neutral", duration: 3500 });
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
  const formatOptions: readonly ToggleOption<FormatKey>[] = [
    { value: "heading", label: "Alt başlık", icon: <HeadingIcon /> },
    { value: "bold", label: "Kalın", kbd: `${modKey}+B`, icon: <BoldIcon /> },
    { value: "italic", label: "İtalik", kbd: `${modKey}+I`, icon: <ItalicIcon /> },
    { value: "bulletList", label: "Madde listesi", icon: <ListIcon /> },
    { value: "blockquote", label: "Alıntı", icon: <QuoteIcon /> },
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

  const exportItems: readonly MenuItem[] = [
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

  const statusDotState = (): "live" | "delayed" | "off" => {
    if (engineStatus() === "loading") return "delayed";
    if (engineStatus() === "error") return "off";
    return "live";
  };

  const statusDotLabel = () => {
    if (engineStatus() === "loading") {
      return `Sözlük indiriliyor… %${progressPercent()}`;
    }
    if (engineStatus() === "error") {
      return offline().online ? "Sözlük yüklenemedi" : "Çevrimdışı (sözlük yok)";
    }
    if (!offline().online) return "Çevrimdışı hazır";
    if (offline().swReady) return "İnternetsiz hazır";
    return "Yerel sözlük hazır";
  };

  const handleToggleSidebar = () => {
    if (isMobile()) {
      setMobileSheetOpen((open) => !open);
    } else {
      setSidebarCollapsed((collapsed) => !collapsed);
    }
  };

  const handleOpenPrivacy = () => {
    setMobileSheetOpen(false);
    setSettingsOpen(false);
    setPrivacyOpen(true);
  };

  return (
    <div class="app-shell">
      {/* Masaüstü daraltılabilir belge kenar çubuğu */}
      <aside
        class="app-sidebar"
        data-collapsed={sidebarCollapsed() ? "" : undefined}
        aria-label="Belgeler"
        inert={sidebarCollapsed() ? true : undefined}
      >
        <DocumentSidebar
          docs={sortedDocs()}
          activeDocId={activeDocId()}
          resolvedTheme={resolvedTheme()}
          onNewDoc={() => void handleNewDoc()}
          onSelectDoc={(id) => void openDocument(id)}
          onRequestDeleteDoc={(doc) => setPendingDelete(doc)}
          onToggleTheme={(next) => handleChangeTheme(next)}
          onOpenPrivacy={handleOpenPrivacy}
        />
      </aside>

      {/* Ana çalışma alanı */}
      <main class="app-main">
        <header class="app-topbar">
          <div class="topbar-start">
            <Tooltip content="Belgeler" side="bottom">
              <Button
                icon
                size="sm"
                aria-label="Belgeler menüsü"
                aria-expanded={isMobile() ? (mobileSheetOpen() ? "true" : "false") : (sidebarCollapsed() ? "false" : "true")}
                onClick={handleToggleSidebar}
              >
                <SidebarIcon />
              </Button>
            </Tooltip>
          </div>

          <div class="topbar-center">
            <Toolbar
              label="Biçimlendirme"
              onMouseDown={(e) => {
                // Biçimlendirme düğmelerine basıldığında editördeki metin seçimi kaybolmasın.
                if ((e.target as Element).closest("button")) e.preventDefault();
              }}
            >
              <ToggleGroup
                size="sm"
                iconOnly
                label="Metin biçimi"
                options={formatOptions}
                value={activeFormats()}
                onToggle={handleToggleFormat}
              />
              <Separator orientation="vertical" decorative />
              <Tooltip content="Geri al" kbd={undoShortcut} side="bottom">
                <Button icon size="sm" aria-label="Geri al" onClick={handleUndo}>
                  <UndoIcon />
                </Button>
              </Tooltip>
            </Toolbar>
          </div>

          <div class="topbar-end">
            <Button
              size="sm"
              class={["autr-mode-btn", { muted: !settings().enabled }]}
              aria-haspopup="dialog"
              onClick={() => setSettingsOpen(true)}
            >
              {modeChipLabel()}
            </Button>

            <Menu
              size="sm"
              label="Dışa aktar"
              trigger={
                <>
                  <DownloadIcon />
                  <span class="export-label">Dışa aktar</span>
                  <ChevronDownIcon />
                </>
              }
              items={exportItems}
            />

            <Tooltip content="Ayarlar" side="bottom">
              <Button
                icon
                size="sm"
                aria-label="Ayarlar"
                aria-haspopup="dialog"
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon />
              </Button>
            </Tooltip>
          </div>
        </header>

        {/* Sessiz indirme ilerlemesi veya hata uyarısı */}
        <Show when={!bannerDismissed() && engineStatus() === "loading"}>
          <div class="engine-strip" aria-live="polite">
            <div class="engine-strip-inner">
              <Progress
                thin
                value={progressPercent()}
                indeterminate={progressIndeterminate()}
                label={progressLabel()}
                showValue={!progressIndeterminate()}
              />
            </div>
          </div>
        </Show>

        <Show when={!bannerDismissed() && engineStatus() === "error"}>
          <div class="engine-strip">
            <div class="engine-strip-inner">
              <Alert
                tone="bad"
                title="Sözlük dosyaları yüklenemedi"
                actions={
                  <>
                    <Button size="sm" onClick={() => void initAutrEngine()}>
                      Tekrar dene
                    </Button>
                    <Button size="sm" onClick={() => setBannerDismissed(true)}>
                      Gizle
                    </Button>
                  </>
                }
              >
                Yazmaya devam edebilirsiniz; sözlük dosyaları eklendiğinde yeniden deneyin.
              </Alert>
            </div>
          </div>
        </Show>

        {/* Yazı kağıdı */}
        <div class="editor-scroll">
          <Show when={docsReady() && activeDoc()}>
            {(doc) => (
              <EditorPane
                docId={doc().id}
                title={doc().title}
                focusTitleSeq={focusTitleSeq()}
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
                  setLastActivity({
                    text: `«${fix.original}» → «${fix.replacement}»`,
                    showUndoHint: true,
                  });
                }}
                onBatchApplied={(fixes) => {
                  setLastActivity({
                    text: `${fixes.length} düzeltme uygulandı`,
                    showUndoHint: true,
                  });
                }}
                onUndo={(fix: AppliedFix) => {
                  setLastActivity({
                    text: `«${fix.original}» geri alındı`,
                    showUndoHint: false,
                  });
                  toast({
                    id: `undo-${fix.original}`,
                    title: `«${fix.original}» geri alındı`,
                    tone: "info",
                    duration: 7500,
                    action: {
                      label: "Bir daha değiştirme",
                      onClick: () => addIgnoredWord(fix.original),
                    },
                  });
                }}
                onBatchUndo={(fixes) => {
                  setLastActivity({
                    text: `${fixes.length} düzeltme geri alındı`,
                    showUndoHint: false,
                  });
                }}
                onBatchProgress={(progress) => {
                  setBatchProgress(progress);
                }}
              />
            )}
          </Show>
        </div>

        {/* Tek satırlık sessiz alt durum çubuğu */}
        <footer class="app-statusbar">
          <div class="statusbar-start">
            <span class="num">{formatNumberTr(wordCount())} kelime</span>
            <span class="status-sep" aria-hidden="true">
              ·
            </span>
            <span class="status-save">{saveLabel()}</span>

            <Show
              when={batchProgress()}
              fallback={
                <Show when={lastActivity()}>
                  {(activity) => (
                    <span class="status-activity">
                      <span class="status-sep" aria-hidden="true">
                        ·
                      </span>
                      <span class="status-fix-text">{activity().text}</span>
                      <Show when={activity().showUndoHint}>
                        <span class="status-undo-hint">
                          <Kbd>{modKey}</Kbd>
                          <Kbd>Z</Kbd>
                        </span>
                      </Show>
                    </span>
                  )}
                </Show>
              }
            >
              {(bp) => (
                <span class="status-activity">
                  <span class="status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span class="status-fix-text num">
                    Denetleniyor… ({bp().processed}/{bp().total})
                  </span>
                </span>
              )}
            </Show>
          </div>

          <div class="statusbar-end">
            <StatusDot state={statusDotState()}>{statusDotLabel()}</StatusDot>
          </div>
        </footer>
      </main>

      {/* Dar ekranda belge listesi Sheet */}
      <Sheet
        open={mobileSheetOpen()}
        onClose={() => setMobileSheetOpen(false)}
        side="start"
        title="Belgeler"
        description={APP_NAME}
      >
        <DocumentSidebar
          inSheet
          docs={sortedDocs()}
          activeDocId={activeDocId()}
          resolvedTheme={resolvedTheme()}
          onNewDoc={() => void handleNewDoc()}
          onSelectDoc={(id) => void openDocument(id)}
          onRequestDeleteDoc={(doc) => {
            setMobileSheetOpen(false);
            setPendingDelete(doc);
          }}
          onToggleTheme={(next) => handleChangeTheme(next)}
          onOpenPrivacy={handleOpenPrivacy}
        />
      </Sheet>

      {/* Ayarlar çekmecesi */}
      <SettingsSheet
        open={settingsOpen()}
        settings={settings()}
        contextWarning={contextWarning()}
        onClose={() => setSettingsOpen(false)}
        onToggleEnabled={handleToggleEnabled}
        onToggleContextModel={handleToggleContextModel}
        onChangeMode={handleChangeMode}
        onToggleKind={handleToggleKind}
        onAddIgnoredWord={addIgnoredWord}
        onRemoveIgnoredWord={removeIgnoredWord}
        onChangeTheme={handleChangeTheme}
      />

      {/* Gizlilik açıklaması */}
      <PrivacyDialog open={privacyOpen()} onClose={() => setPrivacyOpen(false)} />

      {/* Belge silme onayı (alertdialog) */}
      <Dialog
        role="alertdialog"
        open={pendingDelete() !== null}
        onClose={(returnValue) => {
          if (returnValue === "confirm") {
            void confirmDeleteDoc();
          } else {
            setPendingDelete(null);
          }
        }}
        title="Belgeyi sil"
        description={`«${pendingDelete()?.title.trim() || "Adsız belge"}» bu cihazdan kalıcı olarak silinecek.`}
        footer={
          <>
            <Button type="submit" value="cancel">
              Vazgeç
            </Button>
            <Button type="submit" value="confirm" tone="danger">
              Sil
            </Button>
          </>
        }
      />

      {/* Geri alma ve işlem bildirimleri */}
      <Toaster />
    </div>
  );
}
