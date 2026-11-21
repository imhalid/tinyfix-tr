import { For, Show } from "solid-js";
import { formatShortDateTr } from "../kit/format";
import type { DocRecord } from "../storage";
import { ImportIcon, PlusIcon, ShieldIcon, TrashIcon } from "./Icons";

export interface DocumentsListProps {
  docs: readonly DocRecord[];
  activeDocId: string;
  onNewDoc: () => void;
  onImport: () => void;
  /** Belgenin analiz durumu: öneri sayısı, "sırada" ya da "denetleniyor"; yoksa null (tarih gösterilir). */
  reviewBadge: (doc: DocRecord) => string | null;
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
      <button type="button" class="import-doc" onClick={props.onImport} title=".docx, .txt ya da .md dosyası; sürükleyip bırakabilirsiniz">
        <ImportIcon />
        <span>İçe aktar</span>
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
                    <Show
                      when={props.reviewBadge(doc())}
                      fallback={<span class="doc-date">{formatShortDateTr(doc().updatedAt)}</span>}
                    >
                      {(badge) => (
                        <span class="doc-badge" data-busy={/^\d/.test(badge()) ? undefined : ""} title={/^\d/.test(badge()) ? `${badge()} öneri` : undefined}>
                          {badge()}
                        </span>
                      )}
                    </Show>
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
      {/* Kelime verisinin kaynakları: OpenSubtitles verisi bu bağlantı koşuluyla paylaşıldı. */}
      <p class="credits">
        Kelime verisi:{" "}
        <a href="https://tr.wikipedia.org/" target="_blank" rel="noopener">
          Vikipedi
        </a>{" "}
        ·{" "}
        <a href="http://www.opensubtitles.org/" target="_blank" rel="noopener">
          OpenSubtitles.org
        </a>
        <br />
        Model:{" "}
        <a href="https://huggingface.co/imhalid/tdk-ai" target="_blank" rel="noopener">
          Hugging Face
        </a>
      </p>
    </div>
  );
}
