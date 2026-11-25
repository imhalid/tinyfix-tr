import { Extension, getSchema, type JSONContent } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Tdkai, FixKind, FixScope } from "tinyfix-tr";
import { SCHEMA_EXTENSIONS } from "./importFiles";

/**
 * Analiz: belge baştan sona denetlenir ama hiçbir şey kendiliğinden değiştirilmez. Bulunanlar "öneri" olarak
 * işaretlenir; kullanıcı tek tek, gruplar hâlinde ya da hepsini birden uygular veya yoksayar.
 */
export interface Issue {
  id: string;
  from: number;
  to: number;
  original: string;
  replacement: string;
  kind: FixKind;
  scope: FixScope;
}

/** Belge kaydında saklanan özet: konum tutulmaz, yalnızca sayılar. */
export interface ReviewSummary {
  total: number;
  byKind: Partial<Record<FixKind, number>>;
  checkedAt: number;
}

export const REVIEW_META = "autr-review-meta";

type ReviewMeta = { type: "set"; issues: readonly Issue[] } | { type: "remove"; ids: readonly string[] };

interface ReviewState {
  issues: Issue[];
  decorations: DecorationSet;
  /** Geri al / yinele ile belge değişti: uygulama analizi yeniler (öneriler geri gelsin). */
  historyStamp: number;
}

const REVIEW_KEY = new PluginKey<ReviewState>("autrReview");
const LETTER = /[A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû]/;

let issueCounter = 1;

interface TextBlock {
  text: string;
  /** positions[i]: metnin i. karakterinin belgedeki konumu; positions[text.length] bloğun içeriğinin sonu. */
  positions: number[];
}

/** Belgedeki metin blokları. Kod blokları atlanır, satır içi kod boşlukla örtülür (denetlenmez). */
function textBlocks(doc: PMNode): TextBlock[] {
  const blocks: TextBlock[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    let text = "";
    const positions: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const value = child.text ?? "";
        const isCode = child.marks.some((mark) => mark.type.spec.code);
        for (let i = 0; i < value.length; i++) positions.push(start + i);
        text += isCode ? " ".repeat(value.length) : value;
      } else {
        positions.push(start);
        text += "\n";
      }
    });
    positions.push(pos + 1 + node.content.size);
    if (LETTER.test(text)) blocks.push({ text, positions });
    return false;
  });
  return blocks;
}

export interface AnalyzeOptions {
  kinds: readonly FixKind[];
  /** Her bloktan sonra çağrılır; true dönerse analiz yarıda bırakılır. */
  shouldStop?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Belgeyi paragraf paragraf denetler. Arayüz donmasın diye bloklar arasında tarayıcıya nefes verilir. */
export async function analyzeDoc(autr: Tdkai, doc: PMNode, options: AnalyzeOptions): Promise<Issue[] | null> {
  const blocks = textBlocks(doc);
  const issues: Issue[] = [];
  for (let index = 0; index < blocks.length; index++) {
    if (options.shouldStop?.()) return null;
    const block = blocks[index]!;
    const fixes = await autr.check(block.text, { kinds: options.kinds });
    for (const fix of fixes) {
      const from = block.positions[fix.from];
      const to = fix.to < block.positions.length ? block.positions[fix.to - 1]! + 1 : undefined;
      if (from === undefined || to === undefined || to <= from) continue;
      issues.push({
        id: `autr-issue-${issueCounter++}`,
        from,
        to,
        original: fix.original,
        replacement: fix.replacement,
        kind: fix.kind,
        scope: fix.scope,
      });
    }
    options.onProgress?.(index + 1, blocks.length);
    if (index % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return issues;
}

let schema: ReturnType<typeof getSchema> | null = null;

/** Açık olmayan bir belgeyi kayıtlı içeriğinden denetler (editör açmadan). */
export function docFromJson(content: JSONContent): PMNode {
  schema ??= getSchema(SCHEMA_EXTENSIONS);
  return PMNode.fromJSON(schema, content);
}

export function summarize(issues: readonly Issue[]): ReviewSummary {
  const byKind: Partial<Record<FixKind, number>> = {};
  for (const issue of issues) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;
  return { total: issues.length, byKind, checkedAt: Date.now() };
}

function buildDecorations(doc: PMNode, issues: readonly Issue[]): DecorationSet {
  if (issues.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    issues.map((issue) =>
      Decoration.inline(issue.from, issue.to, {
        class: "autr-issue",
        "data-autr-issue-id": issue.id,
        "data-kind": issue.kind,
      }),
    ),
  );
}

export function getIssues(state: EditorState): readonly Issue[] {
  return REVIEW_KEY.getState(state)?.issues ?? [];
}

export function setIssues(view: EditorView, issues: readonly Issue[]): void {
  view.dispatch(view.state.tr.setMeta(REVIEW_META, { type: "set", issues } satisfies ReviewMeta).setMeta("addToHistory", false));
}

export function removeIssues(view: EditorView, ids: readonly string[]): void {
  view.dispatch(view.state.tr.setMeta(REVIEW_META, { type: "remove", ids } satisfies ReviewMeta).setMeta("addToHistory", false));
}

/**
 * Önerileri tek işlemde uygular (sondan başa, konumlar kaymasın). Geri alma (Ctrl/Cmd+Z) hepsini birlikte geri alır.
 * Otomatik düzeltme bu işlemi yazma saymaz.
 */
export function applyIssues(view: EditorView, ids: readonly string[]): number {
  const wanted = new Set(ids);
  const targets = getIssues(view.state)
    .filter((issue) => wanted.has(issue.id))
    .sort((a, b) => b.from - a.from);
  if (targets.length === 0) return 0;
  const tr = view.state.tr;
  let applied = 0;
  let lastFrom = Infinity;
  for (const issue of targets) {
    if (issue.to > lastFrom) continue;
    if (tr.doc.textBetween(issue.from, issue.to) !== issue.original) continue;
    tr.insertText(issue.replacement, issue.from, issue.to);
    lastFrom = issue.from;
    applied++;
  }
  tr.setMeta(REVIEW_META, { type: "remove", ids } satisfies ReviewMeta);
  view.dispatch(tr);
  return applied;
}

export interface ReviewExtensionOptions {
  onIssueClick?: (issue: Issue, element: HTMLElement) => void;
  onIssuesChange?: (issues: readonly Issue[]) => void;
  onHistoryChange?: () => void;
}

export const ReviewExtension = Extension.create<ReviewExtensionOptions>({
  name: "autrReview",

  addOptions() {
    return {};
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<ReviewState>({
        key: REVIEW_KEY,
        state: {
          init: () => ({ issues: [], decorations: DecorationSet.empty, historyStamp: 0 }),
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(REVIEW_META) as ReviewMeta | undefined;
            let issues = prev.issues;
            if (tr.docChanged) {
              // Konumlar düzenlemeyle kayar; üzerine yazılan ya da değişen öneri düşer.
              issues = issues.flatMap((issue) => {
                const from = tr.mapping.mapResult(issue.from, 1);
                const to = tr.mapping.mapResult(issue.to, -1);
                if (from.deleted || to.deleted || to.pos <= from.pos) return [];
                if (newState.doc.textBetween(from.pos, to.pos) !== issue.original) return [];
                return [{ ...issue, from: from.pos, to: to.pos }];
              });
            }
            if (meta?.type === "set") issues = [...meta.issues];
            if (meta?.type === "remove") {
              const drop = new Set(meta.ids);
              issues = issues.filter((issue) => !drop.has(issue.id));
            }
            const historyStamp = tr.docChanged && tr.getMeta("history$") ? prev.historyStamp + 1 : prev.historyStamp;
            if (issues === prev.issues && historyStamp === prev.historyStamp) return prev;
            const decorations = issues === prev.issues ? prev.decorations : buildDecorations(newState.doc, issues);
            return { issues, decorations, historyStamp };
          },
        },
        props: {
          decorations: (state) => REVIEW_KEY.getState(state)?.decorations,
          handleClick(view, _pos, event) {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-autr-issue-id]");
            if (!target) return false;
            const issue = getIssues(view.state).find((item) => item.id === target.dataset.autrIssueId);
            if (!issue) return false;
            options.onIssueClick?.(issue, target);
            return false;
          },
        },
        view: () => {
          let last: readonly Issue[] | null = null;
          let lastStamp = 0;
          return {
            update(view) {
              const issues = getIssues(view.state);
              if (issues !== last) {
                last = issues;
                options.onIssuesChange?.(issues);
              }
              const stamp = REVIEW_KEY.getState(view.state)?.historyStamp ?? 0;
              if (stamp !== lastStamp) {
                lastStamp = stamp;
                options.onHistoryChange?.();
              }
            },
          };
        },
      }),
    ];
  },
});
