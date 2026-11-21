import type { JSONContent } from "@tiptap/core";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { AppliedFix, AutocorrectRuntime, BatchProgress } from "../autocorrectExtension";
import { mountEditor, type EditorController } from "../editor";

export interface EditorPaneProps {
  docId: string;
  title: string;
  /** Yeni belge açıldığında başlık alanını seçmek için artan sayaç. */
  focusTitleSeq: number;
  /** Başlığın altındaki ince bilgi satırı (tarih, kelime sayısı). */
  meta?: JSX.Element;
  getInitialContent: () => JSONContent;
  getRuntime: () => AutocorrectRuntime;
  onTitleInput: (title: string) => void;
  onUpdate: (payload: { json: JSONContent; text: string }) => void;
  onSelectionChange: () => void;
  onController: (controller: EditorController | null) => void;
  onApplied: (fix: AppliedFix) => void;
  onBatchApplied: (fixes: readonly AppliedFix[]) => void;
  onUndo: (fix: AppliedFix) => void;
  onFixClick: (fix: AppliedFix, element: HTMLElement) => void;
  onBatchUndo: (fixes: readonly AppliedFix[]) => void;
  onBatchProgress: (progress: BatchProgress | null) => void;
}

export function EditorPane(props: EditorPaneProps) {
  const [hostEl, setHostEl] = createSignal<HTMLDivElement | undefined>(undefined);
  let titleInputEl: HTMLTextAreaElement | undefined;
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
        onFixClick: (fix, element) => props.onFixClick(fix, element),
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

  // Başlık uzunsa alt satıra geçer: textarea'nın yüksekliği içeriğe göre ayarlanır.
  const fitTitle = () => {
    const el = titleInputEl;
    if (!el) return;
    el.style.blockSize = "auto";
    el.style.blockSize = `${el.scrollHeight}px`;
  };
  createEffect(
    () => props.title,
    () => {
      requestAnimationFrame(fitTitle);
    },
  );
  const titleResize = new ResizeObserver(() => fitTitle());
  // Serif yazı tipi geç yüklenirse yedek yazı tipiyle ölçülen yükseklik yanlış kalır; yüklenince yeniden ölç.
  document.fonts.addEventListener("loadingdone", fitTitle);
  void document.fonts.ready.then(fitTitle);
  onCleanup(() => {
    titleResize.disconnect();
    document.fonts.removeEventListener("loadingdone", fitTitle);
  });

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
      <textarea
        ref={(el) => {
          titleInputEl = el;
          titleResize.observe(el);
        }}
        class={props.title.length > 32 ? "doc-title is-long" : "doc-title"}
        rows={1}
        value={props.title}
        placeholder="Adsız belge"
        aria-label="Belge başlığı"
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => {
          const el = e.currentTarget;
          // Başlık tek paragraftır: yapıştırılan satır sonları boşluğa çevrilir.
          if (/[\r\n]/.test(el.value)) el.value = el.value.replace(/[\r\n]+/g, " ");
          props.onTitleInput(el.value);
          fitTitle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            activeController?.editor.commands.focus("start");
          }
        }}
      />
      {props.meta ? <p class="doc-meta-line">{props.meta}</p> : null}
      <div ref={setHostEl} class="editor-host" />
    </div>
  );
}
