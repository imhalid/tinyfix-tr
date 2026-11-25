import type { FixKind } from "tinyfix-tr";
import { For, Show, createMemo, createSignal } from "solid-js";
import { formatNumberTr } from "../kit/format";
import type { Issue } from "../review";
import { FIX_KIND_META } from "../settings";

export interface IssueGroup {
  key: string;
  original: string;
  replacement: string;
  kind: FixKind;
  issues: Issue[];
}

export interface AnalysisPanelProps {
  issues: readonly Issue[];
  /** "idle": bu belge henüz analiz edilmedi. */
  status: "idle" | "checking" | "done";
  progress: { done: number; total: number } | null;
  wordCount: number;
  engineReady: boolean;
  contextOf: (issue: Issue) => { before: string; after: string; cutBefore: boolean; cutAfter: boolean };
  onAnalyze: () => void;
  onJump: (issue: Issue) => void;
  onApply: (ids: readonly string[]) => void;
  onIgnore: (ids: readonly string[]) => void;
  onNeverChange: (group: IssueGroup) => void;
}

/** Analiz paneli: toplam, türlere göre sayılar ve aynı düzeltmeler bir arada gruplanmış öneri listesi. */
export function AnalysisPanel(props: AnalysisPanelProps) {
  const [filter, setFilter] = createSignal<FixKind | null>(null);

  const byKind = createMemo(() => {
    const counts = new Map<FixKind, number>();
    for (const issue of props.issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });

  const groups = createMemo(() => {
    const map = new Map<string, IssueGroup>();
    for (const issue of props.issues) {
      if (filter() && issue.kind !== filter()) continue;
      const key = `${issue.kind}\u0000${issue.original}\u0000${issue.replacement}`;
      let group = map.get(key);
      if (!group) {
        group = { key, original: issue.original, replacement: issue.replacement, kind: issue.kind, issues: [] };
        map.set(key, group);
      }
      group.issues.push(issue);
    }
    // Belgedeki ilk görünüş sırasıyla.
    return [...map.values()].sort((a, b) => a.issues[0]!.from - b.issues[0]!.from);
  });

  const visibleIds = () => groups().flatMap((group) => group.issues.map((issue) => issue.id));
  const per100 = () =>
    props.wordCount > 0 ? (props.issues.length / props.wordCount) * 100 : 0;

  return (
    <div class="analysis">
      <Show
        when={props.status !== "idle"}
        fallback={
          <div class="analysis-empty">
            <p>Belge baştan sona denetlenir; hiçbir şey kendiliğinden değiştirilmez. Önerileri tek tek ya da topluca uygularsınız.</p>
            <button type="button" class="button button-primary" disabled={!props.engineReady} onClick={() => props.onAnalyze()}>
              {props.engineReady ? "Belgeyi analiz et" : "Sözlük hazırlanıyor…"}
            </button>
          </div>
        }
      >
        <div class="analysis-summary">
          <Show
            when={props.status === "done"}
            fallback={
              <p class="analysis-count">
                <span class="analysis-number">{props.progress ? Math.round((props.progress.done / Math.max(1, props.progress.total)) * 100) : 0}%</span>
                <span class="analysis-unit">denetleniyor</span>
              </p>
            }
          >
            <p class="analysis-count">
              <span class="analysis-number">{formatNumberTr(props.issues.length)}</span>
              <span class="analysis-unit">öneri</span>
            </p>
            <p class="settings-note">
              {formatNumberTr(props.wordCount)} kelime
              <Show when={props.issues.length > 0 && props.wordCount >= 100}>
                {" "}· 100 kelimede {per100().toLocaleString("tr-TR", { maximumFractionDigits: 1 })}
              </Show>
            </p>
          </Show>
        </div>

        <Show when={props.status === "done" && props.issues.length === 0}>
          <p class="analysis-clean">Bu belgede öneri yok.</p>
        </Show>

        <Show when={byKind().length > 1}>
          <div class="analysis-filters" role="group" aria-label="Türe göre süz">
            <button type="button" class="chip" aria-pressed={filter() === null ? "true" : "false"} onClick={() => setFilter(null)}>
              Tümü <span class="chip-count">{props.issues.length}</span>
            </button>
            <For each={byKind()}>
              {([kind, count]) => (
                <button
                  type="button"
                  class="chip"
                  aria-pressed={filter() === kind ? "true" : "false"}
                  onClick={() => setFilter(filter() === kind ? null : kind)}
                >
                  {FIX_KIND_META[kind].label} <span class="chip-count">{count}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={groups().length > 0}>
          <div class="analysis-bulk">
            <button type="button" class="button button-primary" onClick={() => props.onApply(visibleIds())}>
              {filter() ? `${FIX_KIND_META[filter()!].label}: tümünü uygula` : "Tümünü uygula"}
            </button>
          </div>
          <ul class="issue-list">
            <For each={groups()}>
              {(group) => {
                const first = () => group.issues[0]!;
                const context = () => props.contextOf(first());
                return (
                  <li class="issue">
                    <button type="button" class="issue-main" onClick={() => props.onJump(first())} title="Belgede göster">
                      <span class="issue-change">
                        <span class="issue-original">{group.original}</span>
                        <span class="issue-arrow" aria-hidden="true">→</span>
                        <span class="visually-hidden">yerine</span>
                        <span class="issue-replacement">{group.replacement}</span>
                        <Show when={group.issues.length > 1}>
                          <span class="issue-times">×{group.issues.length}</span>
                        </Show>
                        <span class="issue-kind">{FIX_KIND_META[group.kind].label}</span>
                      </span>
                      <span class="issue-context">
                        {context().cutBefore ? "…" : ""}
                        {context().before}
                        <mark>{group.original}</mark>
                        {context().after}
                        {context().cutAfter ? "…" : ""}
                      </span>
                    </button>
                    <div class="issue-actions">
                      <button type="button" class="text-link" onClick={() => props.onIgnore(group.issues.map((issue) => issue.id))}>
                        Yoksay
                      </button>
                      <button type="button" class="text-link" onClick={() => props.onNeverChange(group)}>
                        Bir daha önerme
                      </button>
                      <button type="button" class="button issue-apply" onClick={() => props.onApply(group.issues.map((issue) => issue.id))}>
                        Uygula
                      </button>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
