import { For, Show } from "solid-js";
import { formatShortDateTr } from "../kit/format";
import type { DocRecord } from "../storage";
import { PlusIcon, ShieldIcon, TrashIcon } from "./Icons";

export interface DocumentsListProps {
  docs: readonly DocRecord[];
  activeDocId: string;
  onNewDoc: () => void;
  onSelectDoc: (id: string) => void;
  onRequestDeleteDoc: (doc: DocRecord) => void;
  onOpenPrivacy: () => void;
}

/** Belge listesi: geniş ekranda hep açık sol panelde, telefonda çekmecede gösterilir. */
export function DocumentsList(props: DocumentsListProps) {
  return (
    <div class="docs">
      <button type="button" class="new-doc" onClick={props.onNewDoc}>
        <PlusIcon />
        <span>Yeni belge</span>
      </button>

      <div class="docs-head">
        <span class="section-label">Belgeler</span>
      </div>

      <ul class="doc-list" aria-label="Belgeler">
        <For each={props.docs} keyed={(doc) => doc.id}>
          {(doc) => {
            const title = () => doc().title.trim() || "Adsız belge";
            return (
              <li class="doc-item" aria-current={doc().id === props.activeDocId ? "page" : undefined}>
                <button type="button" class="doc-open" onClick={() => props.onSelectDoc(doc().id)}>
                  <span class="doc-head">
                    <span class="doc-name">{title()}</span>
                    <span class="doc-date">{formatShortDateTr(doc().updatedAt)}</span>
                  </span>
                  <Show when={doc().preview}>
                    <span class="doc-preview">{doc().preview}</span>
                  </Show>
                </button>
                <button
                  type="button"
                  class="icon-button doc-delete"
                  aria-label={`«${title()}» belgesini sil`}
                  title="Belgeyi sil"
                  onClick={() => props.onRequestDeleteDoc(doc())}
                >
                  <TrashIcon />
                </button>
              </li>
            );
          }}
        </For>
      </ul>

      <button type="button" class="privacy-note" onClick={props.onOpenPrivacy}>
        <ShieldIcon />
        <span>Yazılan hiçbir şey cihazdan çıkmaz</span>
      </button>
    </div>
  );
}
