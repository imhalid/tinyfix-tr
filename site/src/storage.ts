import type { JSONContent } from "@tiptap/core";
import { ACTIVE_DOC_STORAGE_KEY, APP_NAME, DOCS_DB_NAME } from "./brand";
import type { ReviewSummary } from "./review";

export interface DocRecord {
  id: string;
  title: string;
  content: JSONContent;
  preview: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
  /** Son analizin özeti (yalnızca sayılar). Analiz edilmemiş belgede yok. */
  review?: ReviewSummary;
}

const STORE_NAME = "documents";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DOCS_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("IndexedDB açılamadı."));
    };
  });
  return dbPromise;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function extractPreview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 96 ? `${singleLine.slice(0, 96)}…` : singleLine;
}

export function createEmptyDocument(title = "Adsız belge"): DocRecord {
  const now = Date.now();
  return {
    id: generateId(),
    title,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    preview: "",
    wordCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createWelcomeDocument(): DocRecord {
  const now = Date.now();
  const intro1 =
    "Burası tamamen cihazınızda çalışan, internetsiz bir Türkçe yazı alanı. Yazdığınız tek bir harf bile sunucuya gitmez; belgeleriniz tarayıcınızın kendi yerel deposunda saklanır.";
  const intro2 =
    "Sözlük yüklendiğinde yazarken düzeltme otomatik başlar. Denemek için bir satır açıp «cok», «Ankaraya», «birşey», «herkez» veya «geldinmi?» yazıp boşluk bırakın. Düzeltilen bir kelimeyi tek tıkla ya da Ctrl/Cmd+Z ile geri alabilirsiniz.";

  const fullText = `${intro1} ${intro2}`;
  return {
    id: generateId(),
    title: `${APP_NAME} ile ilk not`,
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: intro1 }] },
        { type: "paragraph", content: [{ type: "text", text: intro2 }] },
        { type: "paragraph" },
      ],
    },
    preview: extractPreview(fullText),
    wordCount: countWords(fullText),
    createdAt: now,
    updatedAt: now,
  };
}

export async function listDocuments(): Promise<DocRecord[]> {
  const db = await openDb();
  return new Promise<DocRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const docs = (request.result as DocRecord[]).sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(docs);
    };
    request.onerror = () => reject(request.error ?? new Error("Belgeler okunamadı."));
  });
}

export async function saveDocument(doc: DocRecord): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(doc);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Belge kaydedilemedi."));
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Belge silinemedi."));
  });
}

export function loadLastActiveDocId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_DOC_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveLastActiveDocId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_DOC_STORAGE_KEY, id);
  } catch {
    // Sessizce geç.
  }
}
