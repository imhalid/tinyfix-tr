import type { Mark, Node as PMNode } from "@tiptap/pm/model";

function renderTextWithMarks(text: string, marks: readonly Mark[]): string {
  let out = text;
  const hasCode = marks.some((mark) => mark.type.name === "code");
  if (hasCode) {
    const fence = out.includes("`") ? "``" : "`";
    return `${fence}${out}${fence}`;
  }
  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
        out = `**${out}**`;
        break;
      case "italic":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInlineMarkdown(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) {
      out += renderTextWithMarks(child.text ?? "", child.marks);
    } else if (child.type.name === "hardBreak") {
      out += "  \n";
    } else {
      out += renderInlineMarkdown(child);
    }
  });
  return out;
}

function renderBlocksMarkdown(node: PMNode, indent = ""): string[] {
  const blocks: string[] = [];

  node.forEach((child) => {
    switch (child.type.name) {
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(child.attrs["level"] ?? 1)));
        blocks.push(`${indent}${"#".repeat(level)} ${renderInlineMarkdown(child)}`);
        break;
      }
      case "paragraph": {
        blocks.push(`${indent}${renderInlineMarkdown(child)}`);
        break;
      }
      case "codeBlock": {
        const lang = typeof child.attrs["language"] === "string" ? child.attrs["language"] : "";
        const code = child.textContent;
        blocks.push(`${indent}\`\`\`${lang}\n${code}\n${indent}\`\`\``);
        break;
      }
      case "blockquote": {
        const inner = renderBlocksMarkdown(child, "").join("\n\n");
        const quoted = inner
          .split("\n")
          .map((line) => `${indent}> ${line}`)
          .join("\n");
        blocks.push(quoted);
        break;
      }
      case "bulletList": {
        const items: string[] = [];
        child.forEach((item) => {
          const itemLines = renderBlocksMarkdown(item, "");
          const first = itemLines[0] ?? "";
          const rest = itemLines
            .slice(1)
            .map((line) => `${indent}  ${line}`)
            .join("\n");
          items.push(rest ? `${indent}- ${first}\n${rest}` : `${indent}- ${first}`);
        });
        blocks.push(items.join("\n"));
        break;
      }
      case "orderedList": {
        const start = Number(child.attrs["start"] ?? 1);
        const items: string[] = [];
        let index = 0;
        child.forEach((item) => {
          const num = start + index++;
          const itemLines = renderBlocksMarkdown(item, "");
          const first = itemLines[0] ?? "";
          const rest = itemLines
            .slice(1)
            .map((line) => `${indent}   ${line}`)
            .join("\n");
          items.push(rest ? `${indent}${num}. ${first}\n${rest}` : `${indent}${num}. ${first}`);
        });
        blocks.push(items.join("\n"));
        break;
      }
      case "horizontalRule": {
        blocks.push(`${indent}---`);
        break;
      }
      default: {
        const text = child.textContent;
        if (text) blocks.push(`${indent}${text}`);
        break;
      }
    }
  });

  return blocks;
}

/** ProseMirror belgesini okunabilir Markdown metnine çevirir. */
export function serializeMarkdown(doc: PMNode): string {
  return renderBlocksMarkdown(doc).join("\n\n").trimEnd() + "\n";
}

/** ProseMirror belgesini düz metne (.txt) çevirir. */
export function serializePlainText(doc: PMNode): string {
  const blocks: string[] = [];
  doc.forEach((child) => {
    if (child.type.name === "bulletList" || child.type.name === "orderedList") {
      let idx = Number(child.attrs["start"] ?? 1);
      const lines: string[] = [];
      child.forEach((item) => {
        const prefix = child.type.name === "orderedList" ? `${idx++}. ` : "- ";
        lines.push(`${prefix}${item.textBetween(0, item.content.size, "\n", "\n")}`);
      });
      blocks.push(lines.join("\n"));
    } else if (child.type.name === "horizontalRule") {
      blocks.push("---");
    } else {
      blocks.push(child.textBetween(0, child.content.size, "\n", "\n"));
    }
  });
  return blocks.join("\n\n").trimEnd() + "\n";
}

function safeFileBaseName(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 64);
  return cleaned || "belge";
}

/** Belgeyi cihazda doğrudan indirir (ağ isteği yapmaz). */
export function downloadTextFile(title: string, content: string, ext: "txt" | "md"): void {
  const mime = ext === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileBaseName(title)}.${ext}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
