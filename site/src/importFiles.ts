import { generateJSON, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/** Belgenin yapısını (başlık, liste, alıntı…) tanımlayan eklentiler: editör ve içe aktarma aynı şemayı kullanır. */
export const SCHEMA_EXTENSIONS = [StarterKit.configure({ heading: { levels: [1, 2, 3] } })];

export const IMPORT_ACCEPT = ".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface ImportedFile {
  title: string;
  content: JSONContent;
}

export class ImportError extends Error {}

/**
 * Metin dosyasını doğru kodlamayla okur. Windows'ta kaydedilmiş Türkçe .txt dosyaları çoğu zaman UTF-8 değil,
 * Windows-1254'tür; `file.text()` onlarda ş/ğ/ı harflerini � yapar.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1254").decode(bytes);
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Boş satırlar paragrafları ayırır; paragraf içindeki tek satır sonları satır sonu olarak kalır. */
function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

async function markdownToHtml(text: string): Promise<string> {
  const { default: MarkdownIt } = await import("markdown-it");
  // Ham HTML kapalı: dosyadaki etiketler metin olarak kalır.
  return new MarkdownIt({ html: false, linkify: false, breaks: false }).render(text);
}

async function docxToHtml(buffer: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await (mammoth.default ?? mammoth).convertToHtml({ arrayBuffer: buffer });
  return result.value;
}

function titleFromName(name: string): string {
  return name.replace(/\.(txt|md|markdown|docx)$/i, "").replace(/[_]+/g, " ").trim() || "Adsız belge";
}

/** Bir dosyayı editörün belge biçimine çevirir. Desteklenmeyen biçimde `ImportError` fırlatır. */
export async function importFile(file: File): Promise<ImportedFile> {
  const name = file.name.toLowerCase();
  let html: string;
  if (name.endsWith(".docx")) {
    html = await docxToHtml(await file.arrayBuffer());
  } else if (name.endsWith(".md") || name.endsWith(".markdown")) {
    html = await markdownToHtml(decodeText(new Uint8Array(await file.arrayBuffer())));
  } else if (name.endsWith(".txt") || file.type === "text/plain") {
    html = plainTextToHtml(decodeText(new Uint8Array(await file.arrayBuffer())));
  } else if (name.endsWith(".doc")) {
    throw new ImportError("Eski Word (.doc) desteklenmiyor; Word'de .docx olarak kaydedip yeniden deneyin.");
  } else {
    throw new ImportError("Yalnızca .docx, .txt ve .md dosyaları içe aktarılabilir.");
  }
  const content = generateJSON(html || "<p></p>", SCHEMA_EXTENSIONS) as JSONContent;
  if (!content.content || content.content.length === 0) content.content = [{ type: "paragraph" }];
  return { title: titleFromName(file.name), content };
}
