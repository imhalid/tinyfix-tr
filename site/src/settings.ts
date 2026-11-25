import { ALL_FIX_KINDS, type FixKind, type Mode } from "tinyfix-tr";
import { SETTINGS_STORAGE_KEY } from "./brand";

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface AppSettings {
  enabled: boolean;
  contextModel: boolean;
  mode: Mode;
  kinds: Record<FixKind, boolean>;
  ignoredWords: string[];
  theme: Theme;
}

export const FIX_KIND_META: Record<
  FixKind,
  { label: string; description: string; example: string }
> = {
  "turkce-karakter": {
    label: "Türkçe karakter",
    description: "Eksik ç, ğ, ı, ö, ş, ü harflerini tamamlar.",
    example: "cok → çok, nasil → nasıl",
  },
  kesme: {
    label: "Kesme işareti",
    description: "Özel adlara gelen çekim eklerini kesmeyle ayırır.",
    example: "Ankaraya → Ankara'ya",
  },
  "bitisik-ayri": {
    label: "Bitişik / ayrı yazım",
    description: "Soru eki, ki, de/da ve kalıplaşmış birleşik kelimeleri düzeltir.",
    example: "birşey → bir şey, hiç bir → hiçbir",
  },
  yazim: {
    label: "Yazım ve klavye hatası",
    description: "Bilinen yazım yanlışlarını ve tek harflik klavye kaymalarını düzeltir.",
    example: "herkez → herkes, yapabiliur → yapabilir",
  },
  noktalama: {
    label: "Noktalama ve büyük harf",
    description: "Cümle başını ve özel adları büyük harfle başlatır, noktadan sonra unutulan boşluğu ekler.",
    example: "merhaba.ben → Merhaba. Ben, dr. ahmet → Dr. Ahmet",
  },
  kisaltma: {
    label: "Konuşma dili kısaltmaları",
    description: "Konuşur gibi yazılan kısaltmaları açar. Kapalıyken bu kelimelere hiç dokunulmaz.",
    example: "noldu → ne oldu, burda → burada",
  },
};

export function detectSystemTheme(): ResolvedTheme {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? detectSystemTheme() : theme;
}

function defaultKinds(): Record<FixKind, boolean> {
  return {
    "turkce-karakter": true,
    kesme: true,
    "bitisik-ayri": true,
    yazim: true,
    noktalama: true,
    // Üslup tercihi: varsayılan olarak kapalı.
    kisaltma: false,
  };
}

export function defaultSettings(): AppSettings {
  return {
    enabled: true,
    // Kapalı: ilk bağlam modeli yanlış alarmları artırdı (README, 2026-11-21). İyi bir model gelince açılacak.
    contextModel: false,
    mode: "careful",
    kinds: defaultKinds(),
    ignoredWords: [],
    theme: "system",
  };
}

export function normalizeWordTr(word: string): string {
  return word.trim().replaceAll("I", "ı").replaceAll("İ", "i").toLowerCase();
}

export function loadSettings(): AppSettings {
  const defaults = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const kinds = defaultKinds();
    if (parsed.kinds && typeof parsed.kinds === "object") {
      for (const kind of ALL_FIX_KINDS) {
        if (typeof parsed.kinds[kind] === "boolean") {
          kinds[kind] = parsed.kinds[kind];
        }
      }
    }
    const ignoredSet = new Set<string>();
    if (Array.isArray(parsed.ignoredWords)) {
      for (const item of parsed.ignoredWords) {
        if (typeof item === "string") {
          const normalized = normalizeWordTr(item);
          if (normalized) ignoredSet.add(normalized);
        }
      }
    }
    const theme: Theme =
      parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
        ? parsed.theme
        : defaults.theme;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      contextModel:
        typeof parsed.contextModel === "boolean" ? parsed.contextModel : defaults.contextModel,
      mode: parsed.mode === "careful" || parsed.mode === "balanced" ? parsed.mode : defaults.mode,
      kinds,
      ignoredWords: [...ignoredSet].sort((a, b) => a.localeCompare(b, "tr")),
      theme,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Depolama kotası veya gizli sekme kısıtı varsa sessizce geç.
  }
}

/** Mizan'da tema yalnızca color-scheme'dir; sistem seçiminde data-theme kaldırılır. */
export function applyTheme(theme: Theme): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export function getActiveKinds(settings: AppSettings): FixKind[] {
  return ALL_FIX_KINDS.filter((kind) => settings.kinds[kind]);
}
