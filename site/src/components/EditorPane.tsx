import type { JSONContent } from "@tiptap/core";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { AppliedFix, AutocorrectRuntime, BatchProgress } from "../autocorrectExtension";
import { mountEditor, type EditorController } from "../editor";

export interface EditorPaneProps {
  docId: string;
  title: string;
  /** Yeni belge açıldığında başlık alanını seçmek için artan sayaç. */
  focusTitleSeq: number;
  getInitialContent: () => JSONContent;
  getRuntime: () => AutocorrectRuntime;
  onTitleInput: (title: string) => void;
  onUpdate: (payload: { json: JSONContent; text: string }) => void;
  onSelectionChange: () => void;
  onController: (controller: EditorController | null) => void;
  onApplied: (fix: AppliedFix) => void;
  onBatchApplied: (fixes: readonly AppliedFix[]) => void;
  onUndo: (fix: AppliedFix) => void;
  onBatchUndo: (fixes: readonly AppliedFix[]) => void;
  onBatchProgress: (progress: BatchProgress | null) => void;
}

export function EditorPane(props: EditorPaneProps) {
  const [hostEl, setHostEl] = createSignal<HTMLDivElement | undefined>(undefined);
  let titleInputEl: HTMLInputElement | undefined;
  let activeController: EditorController | null = null;

  // Aktif belge değiştiğinde Tiptap örneğini temizleyip yeniden kurar. Belge nesnesi her kayıtta yenilendiği için
  // anahtar bir memo: yalnızca belge kimliği gerçekten değişince haber verir. Gövde de izlenmez; içinde çağrılan
  // App geri çağırmaları (kelime sayısı, biçim durumu) sinyal okur ve editörü yazarken yeniden kurdurup odağı
  // kaybettirirdi.
  const mountKey = createMemo(() => (hostEl() ? props.docId : undefined));
  createEffect(mountKey, (docId) =>
    untrack(() => {
      const el = hostEl();
      if (!docId || !el) return;
      el.replaceChildren();
      const controller = mountEditor({
        element: el,
        content: props.getInitialContent(),
        getRuntime: () => untrack(() => props.getRuntime()),
        onUpdate: (payload) => props.onUpdate(payload),
        onSelectionChange: () => props.onSelectionChange(),
        onApplied: (fix) => props.onApplied(fix),
        onBatchApplied: (fixes) => props.onBatchApplied(fixes),
        onUndo: (fix) => props.onUndo(fix),
        onBatchUndo: (fixes) => props.onBatchUndo(fixes),
        onBatchProgress: (progress) => props.onBatchProgress(progress),
      });
      activeController = controller;
      props.onController(controller);
      return () => {
        activeController = null;
        props.onController(null);
        controller.destroy();
      };
    }),
  );

  // Yeni belge oluşturulduğunda başlığı seç.
  createEffect(
    () => props.focusTitleSeq,
    (seq) => {
      if (seq > 0 && titleInputEl) {
        titleInputEl.focus();
        titleInputEl.select();
      }
    },
  );

  return (
    <div class="editor-canvas">
      <input
        ref={(el) => {
          titleInputEl = el;
        }}
        type="text"
        class="doc-title"
        value={props.title}
        placeholder="Adsız belge"
        aria-label="Belge başlığı"
        autocomplete="off"
        onInput={(e) => props.onTitleInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            activeController?.editor.commands.focus("start");
          }
        }}
      />
      <div ref={setHostEl} class="editor-host" />
    </div>
  );
}
