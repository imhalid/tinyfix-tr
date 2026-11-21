import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Mapping, ReplaceStep, type StepMap } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Autr, Fix, FixKind, FixScope } from "autr";
import { FIX_KIND_META } from "./settings";

export interface AppliedFix {
  id: string;
  from: number;
  to: number;
  original: string;
  replacement: string;
  kind: FixKind;
  /** Karar yalnızca kelimeye mi ("kelime"), çevresine de mi ("baglam") dayanıyor; alt çizginin stili buna göre. */
  scope: FixScope;
}

export interface BatchProgress {
  processed: number;
  total: number;
}

export interface AutocorrectRuntime {
  autr: Autr | null;
  enabled: boolean;
  activeKinds: readonly FixKind[];
}

export interface AutocorrectExtensionOptions {
  getRuntime: () => AutocorrectRuntime;
  onApplied?: (fix: AppliedFix) => void;
  onBatchApplied?: (fixes: readonly AppliedFix[]) => void;
  onUndo?: (fix: AppliedFix) => void;
  onBatchUndo?: (fixes: readonly AppliedFix[]) => void;
  onBatchProgress?: (progress: BatchProgress | null) => void;
  /** Düzeltilmiş kelimeye tıklanınca: uygulama ayrıntıyı ve geri alma seçeneğini bir pencerede gösterir. */
  onFixClick?: (fix: AppliedFix, element: HTMLElement) => void;
  /** Alt çizginin ne kadar sonra kaybolacağı (ms). Varsayılan: kaybolmaz. */
  highlightDurationMs?: number;
}

interface WordSpan {
  start: number;
  end: number;
}

interface PendingParagraphCheck {
  blockStart: number;
  paragraphText: string;
  checkFrom: number;
  checkTo: number;
  allowedMaxEnd: number;
  finishedWords: readonly WordSpan[];
}

interface PendingBatch {
  id: number;
  paragraphs: readonly PendingParagraphCheck[];
  totalChars: number;
}

interface TrackedJobMaps {
  id: number;
  maps: readonly StepMap[];
}

interface CollectedFix {
  origAbsFrom: number;
  origAbsTo: number;
  fix: Fix;
}

type AutocorrectMeta =
  | { type: "add"; records: readonly AppliedFix[]; finishJobId?: number }
  | { type: "remove"; ids: readonly string[] }
  | { type: "finish-job"; jobId: number }
  | { type: "clear" };

interface PluginState {
  records: AppliedFix[];
  decorations: DecorationSet;
  pendingBatch: PendingBatch | null;
  activeJobMaps: readonly TrackedJobMaps[];
  undoneByHistory: AppliedFix[];
}

const AUTOCORRECT_KEY = new PluginKey<PluginState>("autrAutocorrect");
const AUTOCORRECT_META = "autr-autocorrect-meta";

const TURKISH_LETTER = /[A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû]/;
const WORD_REGEX = /[A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû]+(?:['’][A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû]+)*/g;
// Kesme işareti (' ve ’) bilinçli olarak hariç: "Ankara'ya" gibi ekler tek kelimedir.
const WORD_BOUNDARY = /^[\s.,;:!?()[\]"{}“”»«…—–\-/]$/;

/** Bu eşiği aşan toplu eklemelerde ilerleme bildirilir ve paragraf/parça arasında arayüze nefes verilir. */
const LONG_PASTE_CHARS = 5000;
/** Tek bir paragraf bu sınırı aşarsa cümle/kelime sınırlarından bölünerek işlenir. */
const MAX_PARAGRAPH_CHUNK = 2000;
const CHUNK_LEFT_CONTEXT = 120;
const CHUNK_RIGHT_CONTEXT = 80;

let fixCounter = 1;
function nextFixId(): string {
  return `autr-fix-${fixCounter++}`;
}

let jobCounter = 1;
function nextJobId(): number {
  return jobCounter++;
}

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function buildDecorations(doc: EditorState["doc"], records: readonly AppliedFix[]): DecorationSet {
  if (records.length === 0) return DecorationSet.empty;
  const decorations = records.map((record) => {
    const kindLabel = FIX_KIND_META[record.kind].label;
    return Decoration.inline(record.from, record.to, {
      class: "autr-fix",
      "data-autr-fix-id": record.id,
      "data-autr-scope": record.scope,
      "aria-description": `${kindLabel}: «${record.original}» yerine «${record.replacement}»`,
    });
  });
  return DecorationSet.create(doc, decorations);
}

/** Bir işlemde `ReplaceStep` ile eklenen tüm belge aralıklarını birleştirilmiş biçimde döndürür. */
function collectInsertedSpans(tr: Transaction, docSize: number): Array<readonly [number, number]> {
  const raw: Array<[number, number]> = [];

  for (let stepIndex = 0; stepIndex < tr.steps.length; stepIndex++) {
    const step = tr.steps[stepIndex];
    if (!(step instanceof ReplaceStep)) continue;
    if (step.slice.size === 0) continue;

    const tailMapping = tr.mapping.slice(stepIndex + 1);
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      const from = Math.max(0, Math.min(docSize, tailMapping.map(newStart, -1)));
      const to = Math.max(from, Math.min(docSize, tailMapping.map(newEnd, 1)));
      if (to > from) {
        raw.push([from, to]);
      }
    });
  }

  if (raw.length === 0) return [];
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const [from, to] = raw[i]!;
    const last = merged[merged.length - 1]!;
    if (from <= last[1]) {
      if (to > last[1]) last[1] = to;
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

/**
 * İşlemde eklenen aralıklarla kesişen tüm metin bloklarındaki **bitmiş** kelimeleri toplar.
 * Bitmiş kelime: arkasından boşluk/noktalama (veya paragraf kapanışı) gelen ve imlecin hemen solunda olmayan kelime.
 */
function detectPendingBatch(tr: Transaction, newState: EditorState): PendingBatch | null {
  if (!tr.docChanged) return null;
  if (tr.getMeta(AUTOCORRECT_META) || tr.getMeta("history$")) return null;

  const doc = newState.doc;
  const spans = collectInsertedSpans(tr, doc.content.size);
  if (spans.length === 0) return null;

  const minFrom = spans[0]![0];
  const maxTo = spans[spans.length - 1]![1];
  const selectionFrom = newState.selection.from;
  const paragraphs: PendingParagraphCheck[] = [];
  let totalChars = 0;

  doc.nodesBetween(minFrom, maxTo, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === "codeBlock") return false;

    const blockStart = pos + 1;
    const blockEnd = blockStart + node.content.size;
    if (node.content.size === 0) return false;

    const localSpans: Array<readonly [number, number]> = [];
    let blockClosedByInsert = false;

    for (const [spanFrom, spanTo] of spans) {
      if (spanFrom > blockEnd || spanTo < blockStart) continue;
      const localFrom = Math.max(0, spanFrom - blockStart);
      const localTo = Math.min(node.content.size, spanTo - blockStart);
      localSpans.push([localFrom, localTo]);
      if (spanTo > blockEnd) {
        blockClosedByInsert = true;
      }
    }

    if (localSpans.length === 0) return false;

    const paragraphText = node.textBetween(0, node.content.size, "\n", "\n");
    const cursorOffset =
      selectionFrom >= blockStart && selectionFrom <= blockEnd ? selectionFrom - blockStart : null;

    const finishedWords: WordSpan[] = [];
    WORD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = WORD_REGEX.exec(paragraphText)) !== null) {
      const wStart = match.index;
      const wEnd = wStart + match[0].length;
      if (wEnd - wStart < 2) continue;

      // İmlecin hemen solundaki veya içindeki yarım kelimeye dokunma.
      if (cursorOffset !== null && cursorOffset > wStart && cursorOffset <= wEnd) continue;

      // Bu işlemle eklenen veya tamamlanan bir kelime mi?
      const touched = localSpans.some(
        ([localFrom, localTo]) =>
          (wStart < localTo && wEnd > localFrom) ||
          (wEnd === localFrom && (localTo > localFrom || blockClosedByInsert)),
      );
      if (!touched) continue;

      // Bitmiş kelime kontrolü: arkasından boşluk/noktalama ya da ekleme ile kapanan paragraf sonu gelmeli.
      let finished = false;
      if (wEnd < paragraphText.length) {
        finished = WORD_BOUNDARY.test(paragraphText[wEnd] ?? "");
      } else if (blockClosedByInsert) {
        finished = true;
      }

      if (finished) {
        finishedWords.push({ start: wStart, end: wEnd });
      }
    }

    if (finishedWords.length === 0) return false;

    const checkFrom = finishedWords[0]!.start;
    const checkTo = finishedWords[finishedWords.length - 1]!.end;
    totalChars += checkTo - checkFrom;

    paragraphs.push({
      blockStart,
      paragraphText,
      checkFrom,
      checkTo,
      allowedMaxEnd: checkTo,
      finishedWords,
    });

    return false;
  });

  if (paragraphs.length === 0) return null;

  return {
    id: nextJobId(),
    paragraphs,
    totalChars,
  };
}

/** Çok uzun tek bir paragraf aralığını cümle/kelime sınırlarından güvenli parçalara böler. */
function splitRangeIntoChunks(
  text: string,
  from: number,
  to: number,
  maxChunk: number,
): Array<readonly [number, number]> {
  if (to - from <= maxChunk) return [[from, to]];

  const chunks: Array<readonly [number, number]> = [];
  let cursor = from;

  while (cursor < to) {
    if (to - cursor <= maxChunk) {
      chunks.push([cursor, to]);
      break;
    }

    const ideal = cursor + maxChunk;
    const minCut = cursor + Math.floor(maxChunk / 2);
    let cut = -1;

    // Önce cümle sonu + boşluk ara.
    for (let i = ideal; i >= minCut; i--) {
      const prev = text[i - 1] ?? "";
      const curr = text[i] ?? "";
      if ((prev === "." || prev === "!" || prev === "?") && /\s/.test(curr)) {
        cut = i;
        break;
      }
    }

    // Cümle sonu bulunamadıysa boşluktan böl.
    if (cut === -1) {
      for (let i = ideal; i >= minCut; i--) {
        if (/\s/.test(text[i] ?? "")) {
          cut = i;
          break;
        }
      }
    }

    if (cut <= cursor) cut = ideal;
    chunks.push([cursor, cut]);

    cursor = cut;
    while (cursor < to && /\s/.test(text[cursor] ?? "")) {
      cursor++;
    }
  }

  return chunks;
}

/** Paragraf içindeki düzeltmeleri (gerekirse parça parça) toplar. */
async function checkParagraph(
  autr: Autr,
  paragraph: PendingParagraphCheck,
  kinds: readonly FixKind[],
  shouldContinue: () => boolean,
): Promise<Fix[]> {
  const { paragraphText, checkFrom, checkTo, allowedMaxEnd, finishedWords } = paragraph;

  const isAllowedFix = (fix: Fix): boolean =>
    fix.to <= allowedMaxEnd &&
    finishedWords.some((word) => fix.from < word.end && fix.to > word.start);

  if (paragraphText.length <= MAX_PARAGRAPH_CHUNK + CHUNK_LEFT_CONTEXT + CHUNK_RIGHT_CONTEXT) {
    const raw = await autr.check(paragraphText, {
      range: [checkFrom, checkTo],
      kinds,
    });
    return raw.filter(isAllowedFix);
  }

  const chunks = splitRangeIntoChunks(paragraphText, checkFrom, checkTo, MAX_PARAGRAPH_CHUNK);
  const collected: Fix[] = [];
  let lastEnd = -1;

  for (let index = 0; index < chunks.length; index++) {
    if (!shouldContinue()) return [];
    const [chunkStart, chunkEnd] = chunks[index]!;

    let winStart = Math.max(0, chunkStart - CHUNK_LEFT_CONTEXT);
    if (winStart > 0) {
      while (winStart < chunkStart && TURKISH_LETTER.test(paragraphText[winStart - 1] ?? "")) {
        winStart++;
      }
    }

    let winEnd = Math.min(paragraphText.length, chunkEnd + CHUNK_RIGHT_CONTEXT);
    if (winEnd < paragraphText.length) {
      while (winEnd < paragraphText.length && TURKISH_LETTER.test(paragraphText[winEnd] ?? "")) {
        winEnd++;
      }
    }

    const slice = paragraphText.slice(winStart, winEnd);
    const raw = await autr.check(slice, {
      range: [chunkStart - winStart, chunkEnd - winStart],
      kinds,
    });

    for (const fix of raw) {
      const shifted: Fix = {
        ...fix,
        from: fix.from + winStart,
        to: fix.to + winStart,
      };
      if (shifted.from < lastEnd) continue;
      if (!isAllowedFix(shifted)) continue;
      collected.push(shifted);
      lastEnd = shifted.to;
    }

    if (index + 1 < chunks.length) {
      await yieldToBrowser();
    }
  }

  return collected;
}

/** Kimliği verilen düzeltmeyi geri alır (yazılan biçim geri gelir). Geri alınan kaydı ya da null döner. */
export function undoAppliedFix(view: EditorView, id: string): AppliedFix | null {
  const record = AUTOCORRECT_KEY.getState(view.state)?.records.find((item) => item.id === id);
  if (!record) return null;
  return revertAppliedFix(view, record) ? record : null;
}

function revertAppliedFix(view: EditorView, record: AppliedFix): boolean {
  const { doc } = view.state;
  if (record.from < 0 || record.to > doc.content.size) return false;
  const current = doc.textBetween(record.from, record.to, "\n", "\n");
  if (current !== record.replacement) return false;

  view.dispatch(closeHistory(view.state.tr));
  let tr = view.state.tr.insertText(record.original, record.from, record.to);
  tr = closeHistory(tr);
  tr.setMeta(AUTOCORRECT_META, { type: "remove", ids: [record.id] } satisfies AutocorrectMeta);
  view.dispatch(tr);
  view.focus();
  return true;
}

export const AutocorrectExtension = Extension.create<AutocorrectExtensionOptions>({
  name: "autrAutocorrect",

  addOptions() {
    return {
      getRuntime: () => ({ autr: null, enabled: false, activeKinds: [] }),
      highlightDurationMs: Number.POSITIVE_INFINITY,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const durationMs = options.highlightDurationMs ?? Number.POSITIVE_INFINITY;

    return [
      new Plugin<PluginState>({
        key: AUTOCORRECT_KEY,

        state: {
          init(): PluginState {
            return {
              records: [],
              decorations: DecorationSet.empty,
              pendingBatch: null,
              activeJobMaps: [],
              undoneByHistory: [],
            };
          },

          apply(tr, prev, _oldState, newState): PluginState {
            const meta = tr.getMeta(AUTOCORRECT_META) as AutocorrectMeta | undefined;
            const isHistory = Boolean(tr.getMeta("history$"));
            const undoneByHistory: AppliedFix[] = [];
            let records: AppliedFix[] = [];

            if (meta?.type === "clear") {
              records = [];
            } else {
              const removedIds = meta?.type === "remove" ? new Set(meta.ids) : null;
              for (const record of prev.records) {
                if (removedIds?.has(record.id)) continue;
                const mappedFrom = tr.mapping.map(record.from, 1);
                const mappedTo = tr.mapping.map(record.to, -1);
                if (mappedFrom >= 0 && mappedTo > mappedFrom && mappedTo <= newState.doc.content.size) {
                  const text = newState.doc.textBetween(mappedFrom, mappedTo, "\n", "\n");
                  if (text === record.replacement) {
                    records.push({ ...record, from: mappedFrom, to: mappedTo });
                    continue;
                  }
                }
                if (isHistory) {
                  const origStart = tr.mapping.map(record.from, -1);
                  const origEnd = origStart + record.original.length;
                  if (
                    origStart >= 0 &&
                    origEnd <= newState.doc.content.size &&
                    newState.doc.textBetween(origStart, origEnd, "\n", "\n") === record.original
                  ) {
                    undoneByHistory.push(record);
                  }
                }
              }

              if (meta?.type === "add" && meta.records.length > 0) {
                records.push(...meta.records);
              }
            }

            let activeJobMaps: TrackedJobMaps[];
            if (meta?.type === "clear") {
              activeJobMaps = [];
            } else {
              const finishedJobId =
                meta?.type === "finish-job"
                  ? meta.jobId
                  : meta?.type === "add"
                    ? meta.finishJobId
                    : undefined;

              activeJobMaps = [];
              for (const job of prev.activeJobMaps) {
                if (finishedJobId !== undefined && job.id === finishedJobId) continue;
                if (tr.docChanged && tr.mapping.maps.length > 0) {
                  activeJobMaps.push({ id: job.id, maps: [...job.maps, ...tr.mapping.maps] });
                } else {
                  activeJobMaps.push(job);
                }
              }
            }

            const runtime = options.getRuntime();
            const pendingBatch =
              runtime.enabled && runtime.autr && runtime.activeKinds.length > 0
                ? detectPendingBatch(tr, newState)
                : null;

            if (pendingBatch) {
              activeJobMaps.push({ id: pendingBatch.id, maps: [] });
            }

            return {
              records,
              decorations: buildDecorations(newState.doc, records),
              pendingBatch,
              activeJobMaps,
              undoneByHistory,
            };
          },
        },

        props: {
          decorations(state) {
            return AUTOCORRECT_KEY.getState(state)?.decorations ?? DecorationSet.empty;
          },

          handleClick(view, _pos, event) {
            const target = event.target instanceof HTMLElement ? event.target : null;
            const span = target?.closest<HTMLElement>("[data-autr-fix-id]");
            const fixId = span?.dataset["autrFixId"];
            if (!fixId) return false;

            const pluginState = AUTOCORRECT_KEY.getState(view.state);
            const record = pluginState?.records.find((item) => item.id === fixId);
            if (!record || !span) return false;

            if (options.onFixClick) {
              options.onFixClick(record, span);
              return true;
            }
            if (revertAppliedFix(view, record)) {
              options.onUndo?.(record);
              return true;
            }
            return false;
          },
        },

        view() {
          const timers = new Set<ReturnType<typeof setTimeout>>();
          let destroyed = false;

          const scheduleExpiryBatch = (view: EditorView, ids: readonly string[]) => {
            if (ids.length === 0 || !Number.isFinite(durationMs)) return;
            const timer = setTimeout(() => {
              timers.delete(timer);
              if (destroyed) return;
              const current = AUTOCORRECT_KEY.getState(view.state);
              if (!current) return;
              const existingIds = ids.filter((id) => current.records.some((item) => item.id === id));
              if (existingIds.length === 0) return;
              const tr = view.state.tr;
              tr.setMeta("addToHistory", false);
              tr.setMeta(AUTOCORRECT_META, { type: "remove", ids: existingIds } satisfies AutocorrectMeta);
              view.dispatch(tr);
            }, durationMs);
            timers.add(timer);
          };

          const cleanupJob = (view: EditorView, jobId: number) => {
            if (destroyed) return;
            const current = AUTOCORRECT_KEY.getState(view.state);
            if (!current?.activeJobMaps.some((job) => job.id === jobId)) return;
            const tr = view.state.tr;
            tr.setMeta("addToHistory", false);
            tr.setMeta(AUTOCORRECT_META, { type: "finish-job", jobId } satisfies AutocorrectMeta);
            view.dispatch(tr);
          };

          const runBatch = async (view: EditorView, batch: PendingBatch) => {
            const isLongBatch = batch.totalChars > LONG_PASTE_CHARS;
            const shouldYieldBetweenParagraphs = isLongBatch || batch.paragraphs.length > 1;
            let finishedInApply = false;

            try {
              const collected: CollectedFix[] = [];
              const totalParagraphs = batch.paragraphs.length;

              for (let i = 0; i < totalParagraphs; i++) {
                if (destroyed) return;
                const runtime = options.getRuntime();
                if (!runtime.enabled || !runtime.autr || runtime.activeKinds.length === 0) return;

                if (isLongBatch) {
                  options.onBatchProgress?.({ processed: i + 1, total: totalParagraphs });
                }

                const paragraph = batch.paragraphs[i]!;
                let fixes: Fix[];
                try {
                  fixes = await checkParagraph(
                    runtime.autr,
                    paragraph,
                    runtime.activeKinds,
                    () => !destroyed && options.getRuntime().enabled,
                  );
                } catch {
                  continue;
                }

                for (const fix of fixes) {
                  collected.push({
                    origAbsFrom: paragraph.blockStart + fix.from,
                    origAbsTo: paragraph.blockStart + fix.to,
                    fix,
                  });
                }

                if (shouldYieldBetweenParagraphs && i + 1 < totalParagraphs) {
                  await yieldToBrowser();
                }
              }

              if (destroyed || collected.length === 0) return;
              const latestRuntime = options.getRuntime();
              if (!latestRuntime.enabled) return;

              const pluginState = AUTOCORRECT_KEY.getState(view.state);
              const jobEntry = pluginState?.activeJobMaps.find((job) => job.id === batch.id);
              const mapping = new Mapping(jobEntry ? [...jobEntry.maps] : []);

              const { doc, selection } = view.state;
              const codeMarkType = doc.type.schema.marks["code"];
              const validFixes: Array<{ absFrom: number; absTo: number; fix: Fix }> = [];

              for (const item of collected) {
                const mappedFrom = mapping.mapResult(item.origAbsFrom, 1);
                const mappedTo = mapping.mapResult(item.origAbsTo, -1);
                if (mappedFrom.deleted || mappedTo.deleted) continue;

                const absFrom = mappedFrom.pos;
                const absTo = mappedTo.pos;
                if (absTo - absFrom !== item.fix.original.length) continue;
                if (absFrom < 0 || absTo > doc.content.size || absFrom >= absTo) continue;

                // Kullanıcı düzeltilecek kelimenin içine geri döndüyse müdahale etme.
                if (selection.from <= absTo && selection.to >= absFrom) continue;

                // Satır içi kod biçimlendirmesine dokunma.
                if (codeMarkType && doc.rangeHasMark(absFrom, absTo, codeMarkType)) continue;

                const actual = doc.textBetween(absFrom, absTo, "\n", "\n");
                if (actual !== item.fix.original) continue;

                validFixes.push({ absFrom, absTo, fix: item.fix });
              }

              if (validFixes.length === 0) return;

              // Artan sırayla çakışmasız düzeltmeleri tek işlemde (tek geri alma adımında) uygula.
              validFixes.sort((a, b) => a.absFrom - b.absFrom || a.absTo - b.absTo);
              const nonOverlapping: Array<{ absFrom: number; absTo: number; fix: Fix }> = [];
              let prevTo = -1;
              for (const item of validFixes) {
                if (item.absFrom < prevTo) continue;
                nonOverlapping.push(item);
                prevTo = item.absTo;
              }

              if (nonOverlapping.length === 0) return;

              view.dispatch(closeHistory(view.state.tr));

              let tr = view.state.tr;
              const records: AppliedFix[] = [];
              let delta = 0;

              for (const item of nonOverlapping) {
                const from = item.absFrom + delta;
                const to = item.absTo + delta;
                tr.insertText(item.fix.replacement, from, to);
                const newTo = from + item.fix.replacement.length;
                records.push({
                  id: nextFixId(),
                  from,
                  to: newTo,
                  original: item.fix.original,
                  replacement: item.fix.replacement,
                  kind: item.fix.kind,
                  scope: item.fix.scope,
                });
                delta += item.fix.replacement.length - (item.absTo - item.absFrom);
              }

              tr = closeHistory(tr);
              tr.setMeta(AUTOCORRECT_META, {
                type: "add",
                records,
                finishJobId: batch.id,
              } satisfies AutocorrectMeta);
              finishedInApply = true;
              view.dispatch(tr);

              scheduleExpiryBatch(
                view,
                records.map((record) => record.id),
              );

              if (records.length === 1) {
                options.onApplied?.(records[0]!);
              } else if (options.onBatchApplied) {
                options.onBatchApplied(records);
              } else {
                for (const record of records) {
                  options.onApplied?.(record);
                }
              }
            } finally {
              if (isLongBatch && !destroyed) {
                options.onBatchProgress?.(null);
              }
              if (!finishedInApply) {
                cleanupJob(view, batch.id);
              }
            }
          };

          return {
            update(view, prevState) {
              const current = AUTOCORRECT_KEY.getState(view.state);
              const previous = AUTOCORRECT_KEY.getState(prevState);
              if (!current) return;

              if (current.undoneByHistory.length > 0 && current.undoneByHistory !== previous?.undoneByHistory) {
                if (current.undoneByHistory.length === 1) {
                  options.onUndo?.(current.undoneByHistory[0]!);
                } else if (options.onBatchUndo) {
                  options.onBatchUndo(current.undoneByHistory);
                } else {
                  for (const record of current.undoneByHistory) {
                    options.onUndo?.(record);
                  }
                }
              }

              if (current.pendingBatch && current.pendingBatch !== previous?.pendingBatch) {
                void runBatch(view, current.pendingBatch);
              }
            },

            destroy() {
              destroyed = true;
              for (const timer of timers) clearTimeout(timer);
              timers.clear();
            },
          };
        },
      }),
    ];
  },
});
