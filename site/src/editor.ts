import { Editor, type JSONContent } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  AutocorrectExtension,
  type AppliedFix,
  type AutocorrectRuntime,
  type BatchProgress,
} from "./autocorrectExtension";

export interface EditorMountOptions {
  element: HTMLElement;
  content: JSONContent;
  getRuntime: () => AutocorrectRuntime;
  onUpdate: (payload: { json: JSONContent; text: string }) => void;
  onSelectionChange: () => void;
  onApplied?: (fix: AppliedFix) => void;
  onBatchApplied?: (fixes: readonly AppliedFix[]) => void;
  onUndo?: (fix: AppliedFix) => void;
  onFixClick?: (fix: AppliedFix, element: HTMLElement) => void;
  onBatchUndo?: (fixes: readonly AppliedFix[]) => void;
  onBatchProgress?: (progress: BatchProgress | null) => void;
}

export interface EditorController {
  editor: Editor;
  getDocNode: () => PMNode;
  destroy: () => void;
}

export function mountEditor(options: EditorMountOptions): EditorController {
  const editor = new Editor({
    element: options.element,
    content: options.content,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: "Yazmaya başlayın…",
      }),
      AutocorrectExtension.configure({
        getRuntime: options.getRuntime,
        onApplied: options.onApplied,
        onBatchApplied: options.onBatchApplied,
        onUndo: options.onUndo,
        onFixClick: options.onFixClick,
        onBatchUndo: options.onBatchUndo,
        onBatchProgress: options.onBatchProgress,
      }),
    ],
    editorProps: {
      attributes: {
        class: "editor-prose",
        spellcheck: "false",
        lang: "tr",
        "aria-label": "Belge düzenleyici",
      },
    },
    onUpdate({ editor: instance }) {
      options.onUpdate({
        json: instance.getJSON(),
        text: instance.getText({ blockSeparator: "\n\n" }),
      });
    },
    onSelectionUpdate() {
      options.onSelectionChange();
    },
    onTransaction() {
      options.onSelectionChange();
    },
  });

  return {
    editor,
    getDocNode: () => editor.state.doc,
    destroy: () => editor.destroy(),
  };
}
