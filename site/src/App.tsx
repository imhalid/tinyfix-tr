import { loadTdkai, type Tdkai, type FixKind, type LoadProgress, type Mode } from "tinyfix-tr";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import {
  applyFlagSuggestion,
  dismissFlag,
  flagAllText,
  undoAppliedFix,
  type AppliedFix,
  type BatchProgress,
  type FlaggedWord,
} from "./autocorrectExtension";
import { APP_NAME, APP_TAGLINE, MODELS_BASE_URL, ORT_WASM_BASE_URL } from "./brand";
import { DocumentsList } from "./components/DocumentsDrawer";
import { EditorPane } from "./components/EditorPane";
import { FixPopover, type PopoverFix } from "./components/FixPopover";
import { BoldIcon, HeadingIcon, ItalicIcon, ListIcon, QuoteIcon, ScanIcon, UndoIcon } from "./components/Icons";
import { Modal, PrivacyDialog } from "./components/PrivacyDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { AnalysisPanel, type IssueGroup } from "./components/AnalysisPanel";
import { IMPORT_ACCEPT, ImportError, importFile } from "./importFiles";
import { analyzeDoc, applyIssues, docFromJson, getIssues, removeIssues, setIssues, summarize, type Issue, type ReviewSummary } from "./review";
import { Drawer } from "./kit/Drawer";
import { formatBytesTr, formatLongDateTr, formatNumberTr, isMacPlatform } from "./kit/format";
import { Toasts, toast } from "./kit/toast";
import type { EditorController } from "./editor";
import { downloadTextFile, serializeMarkdown, serializePlainText } from "./export";
import { waitForServiceWorker, watchOfflineStatus, type OfflineState } from "./offline";
import { deleteStoredData, redownloadData, storedDataSize } from "./storedData";
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

  const [autr, setAutr] = createSignal<Tdkai | null>(null);
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
  /** Tıklanan işaretli kelime: pencerede önerileri gösterilir. */
  const [openFlag, setOpenFlag] = createSignal<{ flag: FlaggedWord; anchor: HTMLElement } | null>(null);

  /** Pencere aynı nesneyi görsün diye bir kez kurulur (her okumada yeni nesne pencereyi açtırmaz). */
  const flagPopoverFix = createMemo((): PopoverFix | null => {
    const open = openFlag();
    if (!open) return null;
    const { flag } = open;
    return { original: flag.original, replacement: flag.suggestions[0] ?? flag.original, kind: "yazim", scope: "kelime" };
  });

  /** Açık belgedeki şüpheli kelimelerin altını çizer (metne dokunmaz). */
  const flagOpenDocument = (instance: Tdkai | null = autr()) => {
    const view = editorController?.editor.view;
    if (!view || !instance || !settings().enabled) return;
    void flagAllText(view, instance, getActiveKinds(settings()));
  };

  const chooseSuggestion = (flag: FlaggedWord, replacement: string) => {
    setOpenFlag(null);
    const view = editorController?.editor.view;
    if (!view || !applyFlagSuggestion(view, flag.id, replacement)) return;
    setLastActivity({ text: `«${flag.original}» → «${replacement}»`, showUndoHint: true });
  };

  const dismissFlagFromPopover = (flag: FlaggedWord, never: boolean) => {
    setOpenFlag(null);
    const view = editorController?.editor.view;
    if (!view) return;
    dismissFlag(view, flag.id);
    if (never) addIgnoredWord(flag.original);
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

  // Analiz: açık belgedeki öneriler, durum ve sıralı denetim kuyruğu.
  const [liveIssues, setLiveIssues] = createSignal<readonly Issue[]>([]);
  const [activeReview, setActiveReview] = createSignal<"idle" | "checking" | "done">("idle");
  const [reviewProgress, setReviewProgress] = createSignal<{ done: number; total: number } | null>(null);
  const [analysisOpen, setAnalysisOpen] = createSignal(false);
  const [openIssue, setOpenIssue] = createSignal<{ issue: Issue; anchor: HTMLElement } | null>(null);
  const [reviewQueue, setReviewQueue] = createSignal<string[]>([]);
  const [queueTotal, setQueueTotal] = createSignal(0);
  const [checkingId, setCheckingId] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal(false);
  let controllerDocId: string | null = null;
  let queueRunning = false;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  // Kuyruğun asıl kaydı düz dizi: Solid 2'de yazılan sinyal aynı turda okunamıyor. Sinyal yalnızca görünüm için.
  const queue: string[] = [];
  const queuedDocs = new Map<string, DocRecord>();
  const syncQueue = () => setReviewQueue([...queue]);
  let importInput: HTMLInputElement | undefined;

  const [storedBytes, setStoredBytes] = createSignal<number | null>(null);
  const [dataBusy, setDataBusy] = createSignal<"redownload" | "delete" | null>(null);

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
      const instance = await loadTdkai({
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
      setTimeout(() => void runQueue(), 0);
      setTimeout(() => flagOpenDocument(instance), 0);
      // Sözlük yüklenirken yazılanları denetle. Solid 2'de yazılan sinyal bir sonraki turda okunur, o yüzden bekletiyoruz.
      setTimeout(() => editorController?.checkWaitingText(), 0);
    } catch (error) {
      if (disposed || loadSeq !== engineLoadSeq || abortController.signal.aborted) return;
      console.error("autr: sözlük yüklenemedi", error);
      setEngineStatus("error");
    }
  };

  const updateReviewSummary = (id: string, review: ReviewSummary) => {
    setDocs((prev) => prev.map((doc) => (doc.id === id ? { ...doc, review } : doc)));
    const doc = docs().find((item) => item.id === id) ?? queuedDocs.get(id);
    if (doc) void saveDocument({ ...doc, review }).catch(() => {});
  };

  /** Açık belgeyi analiz eder ve önerileri editörde işaretler. Motor ya da belge değişirse false döner. */
  const analyzeActive = async (): Promise<boolean> => {
    const engine = autr();
    const controller = editorController;
    const docId = controllerDocId;
    if (!engine || !controller || !docId) return false;
    const view = controller.editor.view;
    setActiveReview("checking");
    setReviewProgress(null);
    // Analiz sürerken yazılırsa konumlar eskir: belge değiştiyse baştan alınır.
    for (let attempt = 0; attempt < 3; attempt++) {
      const startDoc = view.state.doc;
      const issues = await analyzeDoc(engine, startDoc, {
        kinds: getActiveKinds(settings()),
        shouldStop: () => autr() !== engine || controllerDocId !== docId,
        onProgress: (done, total) => setReviewProgress({ done, total }),
      });
      if (!issues) {
        if (controllerDocId === docId) setActiveReview(docs().find((doc) => doc.id === docId)?.review ? "done" : "idle");
        return false;
      }
      if (view.state.doc !== startDoc) continue;
      setIssues(view, issues);
      setActiveReview("done");
      updateReviewSummary(docId, summarize(issues));
      return true;
    }
    setActiveReview("idle");
    return false;
  };

  /** Kuyruktaki belgeleri sırayla denetler. Açık olmayan belgeler editör açılmadan, kayıtlı içerikten denetlenir. */
  const runQueue = async () => {
    if (queueRunning) return;
    queueRunning = true;
    try {
      for (;;) {
        const engine = autr();
        const id = queue[0];
        if (!engine || !id) break;
        setCheckingId(id);
        const doc = docs().find((item) => item.id === id) ?? queuedDocs.get(id);
        let ok = true;
        if (doc && id === controllerDocId) {
          ok = await analyzeActive();
        } else if (doc) {
          const issues = await analyzeDoc(engine, docFromJson(doc.content), {
            kinds: getActiveKinds(settings()),
            shouldStop: () => autr() !== engine,
          });
          if (issues) updateReviewSummary(id, summarize(issues));
          ok = issues !== null;
          // Belge bu sırada açıldıysa öneriler editörde de işaretlensin.
          if (ok && id === controllerDocId) ok = await analyzeActive();
        }
        if (!ok && autr() !== engine) break;
        queue.shift();
        queuedDocs.delete(id);
        syncQueue();
      }
    } finally {
      setCheckingId(null);
      queueRunning = false;
      if (queue.length === 0) setQueueTotal(0);
    }
  };

  const enqueueReview = (ids: readonly string[]) => {
    const fresh = ids.filter((id) => !queue.includes(id));
    queue.push(...fresh);
    syncQueue();
    setQueueTotal((total) => (queueRunning ? total : 0) + fresh.length);
    void runQueue();
  };

  const handleImportFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    await persistActiveDocNow();
    const created: DocRecord[] = [];
    const now = Date.now();
    for (const file of files) {
      try {
        const imported = await importFile(file);
        const doc = createEmptyDocument(imported.title);
        const text = docFromJson(imported.content).textBetween(0, docFromJson(imported.content).content.size, "\n\n", " ");
        // İlk dosya listenin en üstünde dursun: sıraya göre azalan zaman.
        const stamp = now - created.length;
        created.push({ ...doc, content: imported.content, preview: extractPreview(text), wordCount: countWords(text), createdAt: stamp, updatedAt: stamp });
      } catch (error) {
        const reason = error instanceof ImportError ? error.message : "Dosya okunamadı.";
        toast({ title: `«${file.name}»: ${reason}`, duration: 6000 });
      }
    }
    if (created.length === 0) return;
    for (const doc of created) {
      queuedDocs.set(doc.id, doc);
      await saveDocument(doc).catch(() => {});
    }
    setDocs((prev) => [...created, ...prev]);
    const first = created[0]!;
    setActiveDocId(first.id);
    saveLastActiveDocId(first.id);
    setLastActivity(null);
    setBatchProgress(null);
    setDocsOpen(false);
    toast({
      title: created.length === 1 ? `«${first.title}» içe aktarıldı` : `${created.length} belge içe aktarıldı`,
      duration: 3500,
    });
    enqueueReview(created.map((doc) => doc.id));
  };

  const pickImportFiles = () => importInput?.click();

  /** Bir önerinin çevresindeki metin (panelde bağlam olarak gösterilir). */
  const issueContext = (issue: Issue) => {
    const doc = editorController?.editor.state.doc;
    if (!doc || issue.to > doc.content.size) return { before: "", after: "", cutBefore: false, cutAfter: false };
    const $from = doc.resolve(issue.from);
    const start = Math.max($from.start(), issue.from - 36);
    const end = Math.min($from.end(), issue.to + 36);
    let before = doc.textBetween(start, issue.from, " ", " ");
    let after = doc.textBetween(issue.to, end, " ", " ");
    if (start > $from.start()) before = before.replace(/^\S*\s/, "");
    if (end < $from.end()) after = after.replace(/\s\S*$/, "");
    return { before, after, cutBefore: start > $from.start(), cutAfter: end < $from.end() };
  };

  const jumpToIssue = (issue: Issue) => {
    setAnalysisOpen(false);
    const editor = editorController?.editor;
    if (!editor) return;
    editor.chain().focus().setTextSelection(issue.to).scrollIntoView().run();
    setTimeout(() => {
      const element = editor.view.dom.querySelector<HTMLElement>(`[data-autr-issue-id="${issue.id}"]`);
      if (element) {
        element.scrollIntoView({ block: "center" });
        setTimeout(() => setOpenIssue({ issue, anchor: element }), 60);
      }
    }, 30);
  };

  const applyIssueIds = (ids: readonly string[]) => {
    setOpenIssue(null);
    const view = editorController?.editor.view;
    if (!view) return;
    const applied = applyIssues(view, ids);
    if (applied > 0) {
      setLastActivity({
        text: applied === 1 ? "Öneri uygulandı" : `${formatNumberTr(applied)} öneri uygulandı`,
        showUndoHint: true,
      });
    }
  };

  const ignoreIssueIds = (ids: readonly string[]) => {
    setOpenIssue(null);
    const view = editorController?.editor.view;
    if (view) removeIssues(view, ids);
  };

  const neverSuggest = (original: string) => {
    setOpenIssue(null);
    addIgnoredWord(original);
    const view = editorController?.editor.view;
    if (!view) return;
    const key = normalizeWordTr(original);
    removeIssues(
      view,
      getIssues(view.state)
        .filter((issue) => normalizeWordTr(issue.original) === key)
        .map((issue) => issue.id),
    );
  };

  const reviewBadge = (doc: DocRecord): string | null => {
    if (checkingId() === doc.id) return "denetleniyor";
    if (reviewQueue().includes(doc.id)) return "sırada";
    const total = doc.id === activeDocId() && activeReview() === "done" ? liveIssues().length : doc.review?.total ?? 0;
    return total > 0 ? formatNumberTr(total) : null;
  };

  const refreshStoredSize = () => {
    storedDataSize()
      .then((bytes) => setStoredBytes(bytes))
      .catch(() => setStoredBytes(null));
  };

  const openSettings = () => {
    refreshStoredSize();
    setSettingsOpen(true);
  };

  const handleRedownloadData = async () => {
    if (dataBusy()) return;
    setDataBusy("redownload");
    try {
      const sizes: Record<string, number> = await fetch(`${MODELS_BASE_URL}manifest.json`, { cache: "reload" }).then((r) => r.json());
      // Bağlam modeli yalnızca açıksa indirilir; ORT dosyalarını motor kendisi ister.
      const files = Object.keys(sizes).filter((name) => name !== "context.onnx" || settings().contextModel);
      await redownloadData([`${MODELS_BASE_URL}manifest.json`, ...files.map((name) => `${MODELS_BASE_URL}${name}`)]);
      await initAutrEngine();
      toast({ title: "Veriler yeniden indirildi", duration: 3500 });
    } catch (error) {
      console.error("autr: veriler yeniden indirilemedi", error);
      toast({ title: "İndirme başarısız; internet bağlantınızı kontrol edin", duration: 5000 });
    } finally {
      setDataBusy(null);
      refreshStoredSize();
    }
  };

  const handleDeleteData = async () => {
    if (dataBusy()) return;
    setDataBusy("delete");
    try {
      await deleteStoredData();
      toast({ title: "İndirilen veriler silindi", duration: 4000 });
    } finally {
      setDataBusy(null);
      refreshStoredSize();
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

    // Dosyayı sayfaya sürükleyip bırakarak içe aktarma.
    let dragDepth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth++;
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      void handleImportFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

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
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
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
          onImport={pickImportFiles}
          reviewBadge={reviewBadge}
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
          <button type="button" class="text-button" aria-haspopup="dialog" onClick={() => setAnalysisOpen(true)}>
            Analiz
            <Show when={activeReview() === "done" && liveIssues().length > 0}>
              <span class="count-pill">{formatNumberTr(liveIssues().length)}</span>
            </Show>
          </button>
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
          <button type="button" class="text-button" aria-haspopup="dialog" onClick={openSettings}>
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
                controllerDocId = controller ? doc().id : null;
                setOpenIssue(null);
                setLiveIssues([]);
                setReviewProgress(null);
                if (controller) {
                  setTimeout(() => flagOpenDocument(), 0);
                  // Daha önce analiz edilmiş belge açılınca öneriler yeniden işaretlenir (konumlar saklanmaz).
                  if (doc().review && !queue.includes(doc().id)) {
                    setActiveReview("checking");
                    if (engineStatus() === "ready") void analyzeActive();
                    else enqueueReview([doc().id]);
                  } else {
                    setActiveReview(queue.includes(doc().id) ? "checking" : "idle");
                  }
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
              onSettled={(fixes) => {
                const first = fixes[0];
                if (!first) return;
                setLastActivity({
                  text:
                    fixes.length === 1
                      ? `Paragraf tarandı: «${first.original}» → «${first.replacement}»`
                      : `Paragraf tarandı: ${fixes.length} kelime değişti`,
                  showUndoHint: true,
                });
              }}
              onFixClick={(fix: AppliedFix, element: HTMLElement) => setOpenFix({ fix, anchor: element })}
              onFlagClick={(flag, element) => setOpenFlag({ flag, anchor: element })}
              onFlagsChange={(flags) => {
                const open = openFlag();
                if (open && !flags.some((flag) => flag.id === open.flag.id)) setOpenFlag(null);
              }}
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
              onIssueClick={(issue, element) => setOpenIssue({ issue, anchor: element })}
              onHistoryChange={() => {
                // Geri alınan öneriler yeniden işaretlensin: analiz edilmiş belgede kısa bir gecikmeyle yenilenir.
                if (!doc().review || queue.includes(doc().id)) return;
                if (historyTimer !== null) clearTimeout(historyTimer);
                historyTimer = setTimeout(() => {
                  historyTimer = null;
                  void analyzeActive();
                }, 400);
              }}
              onIssuesChange={(issues) => {
                setLiveIssues(issues);
                const id = controllerDocId;
                if (id && activeReview() === "done") {
                  const current = docs().find((item) => item.id === id)?.review;
                  if (current && current.total !== issues.length) {
                    setDocs((prev) => prev.map((item) => (item.id === id ? { ...item, review: summarize(issues) } : item)));
                    scheduleSave();
                  }
                }
              }}
            />
          )}
        </Show>
      </main>

      <footer class="footnote" aria-live="polite">
        <span>{saveLabel()}</span>
        <Show when={reviewQueue().length > 0 && queueTotal() > 1}>
          <span class="footnote-activity">
            Belgeler denetleniyor · {formatNumberTr(queueTotal() - reviewQueue().length)}/{formatNumberTr(queueTotal())}
          </span>
        </Show>
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
          onImport={pickImportFiles}
          reviewBadge={reviewBadge}
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
          storedBytes={storedBytes()}
          dataBusy={dataBusy()}
          onRedownloadData={() => void handleRedownloadData()}
          onDeleteData={() => void handleDeleteData()}
        />
      </Drawer>

      <FixPopover
        fix={openFix()?.fix ?? null}
        anchor={openFix()?.anchor ?? null}
        actions={[
          { label: "Geri al", primary: true, onClick: () => { const fix = openFix()?.fix; if (fix) undoFromPopover(fix, false); } },
          { label: "Bir daha değiştirme", onClick: () => { const fix = openFix()?.fix; if (fix) undoFromPopover(fix, true); } },
        ]}
        onClose={() => setOpenFix(null)}
      />

      <FixPopover
        fix={openIssue()?.issue ?? null}
        anchor={openIssue()?.anchor ?? null}
        note="Öneri: siz uygulayana kadar metin değişmez."
        actions={[
          { label: "Uygula", primary: true, onClick: () => { const issue = openIssue()?.issue; if (issue) applyIssueIds([issue.id]); } },
          { label: "Yoksay", onClick: () => { const issue = openIssue()?.issue; if (issue) ignoreIssueIds([issue.id]); } },
          { label: "Bir daha önerme", onClick: () => { const issue = openIssue()?.issue; if (issue) neverSuggest(issue.original); } },
        ]}
        onClose={() => setOpenIssue(null)}
      />

      <FixPopover
        fix={flagPopoverFix()}
        anchor={openFlag()?.anchor ?? null}
        note="Bu kelime hatalı görünüyor. Emin olamadığım için değiştirmedim; bir öneri seçin."
        actions={[
          ...(openFlag()?.flag.suggestions ?? []).map((suggestion, index) => ({
            label: suggestion,
            primary: index === 0,
            onClick: () => {
              const flag = openFlag()?.flag;
              if (flag) chooseSuggestion(flag, suggestion);
            },
          })),
          { label: "Yoksay", onClick: () => { const flag = openFlag()?.flag; if (flag) dismissFlagFromPopover(flag, false); } },
          { label: "Bir daha işaretleme", onClick: () => { const flag = openFlag()?.flag; if (flag) dismissFlagFromPopover(flag, true); } },
        ]}
        onClose={() => setOpenFlag(null)}
      />

      <Drawer
        open={analysisOpen()}
        onClose={() => setAnalysisOpen(false)}
        side="end"
        title="Analiz"
        description="Öneriler siz uygulayana kadar metni değiştirmez."
      >
        <AnalysisPanel
          issues={liveIssues()}
          status={activeReview()}
          progress={reviewProgress()}
          wordCount={wordCount()}
          engineReady={engineStatus() === "ready"}
          contextOf={issueContext}
          onAnalyze={() => void analyzeActive()}
          onJump={jumpToIssue}
          onApply={applyIssueIds}
          onIgnore={ignoreIssueIds}
          onNeverChange={(group: IssueGroup) => neverSuggest(group.original)}
        />
      </Drawer>

      <input
        ref={(el) => (importInput = el)}
        type="file"
        multiple
        accept={IMPORT_ACCEPT}
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void handleImportFiles(files);
        }}
      />

      <Show when={dragging()}>
        <div class="drop-overlay" aria-hidden="true">
          <p>Bırakın, içe aktarılsın</p>
          <span>.docx · .txt · .md</span>
        </div>
      </Show>

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
