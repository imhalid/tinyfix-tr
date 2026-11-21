import { CAREFUL, Corrector, type Correction, type Settings, type SpellFlag } from "../../src/corrector.ts";
import { lowerTr } from "../../src/turkish.ts";
import type { LoadedData } from "./data.ts";
import type { CheckOptions, ContextSession, Fix, FixKind, FixScope, Flag, InspectResult, Mode } from "./types.ts";

/** Temkinli kip: motorun doğrulanan varsayılan eşikleri. */
export { CAREFUL };

/** Dengeli kip: `CAREFUL` ayarından biraz daha cesur eşikler. */
export const BALANCED: Settings = {
  ...CAREFUL,
  threshold: { marks: 1.8, apostrophe: 2.0, split: 2.0, join: 2.0, typo: 2.3, known: 0.7, context: 2.5, contraction: 0.7 },
  cost: { marks: 0.4, apostrophe: 0.5, split: 0.4, join: 0.4, typo: 1.7, known: 0, context: 0, contraction: 0 },
  ambiguity: 0.7,
  knownWord: 5,
  knownMarked: 15,
  markedOverride: 4.5,
  minName: 12,
};

/** Kipin eşikleri; kısaltmalar yalnızca "kisaltma" türü açıkça istendiğinde açılır. */
function settingsFor(mode: Mode, kinds: ReadonlySet<FixKind> | null): Settings {
  return { ...SETTINGS_BY_MODE[mode], contractions: kinds?.has("kisaltma") ?? false };
}

const SETTINGS_BY_MODE: Record<Mode, Settings> = {
  careful: CAREFUL,
  balanced: BALANCED,
};

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*(?:`|$)/gm;

function findCodeRanges(text: string): Array<readonly [number, number]> {
  if (!text.includes("`")) return [];
  const ranges: Array<readonly [number, number]> = [];
  for (const pattern of [FENCED_CODE, INLINE_CODE]) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

/** Motorun iç düzeltme türünü dışarıya açılan anlaşılır Türkçe türe eşler. */
/**
 * Birleştirme, ayırma ve bağlam modeli kararları komşu kelimelere ya da kelime çiftlerinin sıklığına bakar; iki
 * kelimeyi kapsayan her düzeltme de öyledir ("hiç bir" → "hiçbir"). Geri kalanı yalnızca kelimeye bakar.
 */
export function correctionScope(correction: Pick<Correction, "kind" | "original">): FixScope {
  if (correction.kind === "join" || correction.kind === "split" || correction.kind === "context") return "baglam";
  return correction.original.includes(" ") ? "baglam" : "kelime";
}

export function mapCorrectionKind(correction: Pick<Correction, "kind" | "original" | "replacement">): FixKind {
  switch (correction.kind) {
    case "marks":
      return "turkce-karakter";
    case "apostrophe":
      return "kesme";
    case "split":
    case "join":
      return "bitisik-ayri";
    case "typo":
      return "yazim";
    case "contraction":
      return "kisaltma";
    case "context":
    case "known": {
      const originalHasSpace = correction.original.includes(" ");
      const replacementHasSpace = correction.replacement.includes(" ");
      if (originalHasSpace !== replacementHasSpace) return "bitisik-ayri";
      const strip = (value: string) => lowerTr(value).replace(/\s+/g, "");
      if (strip(correction.original) === strip(correction.replacement)) return "bitisik-ayri";
      const fold = (value: string) => lowerTr(value).replace(/[çğıöşüâîû]/g, (char) => "cgiosuaiu"["çğıöşüâîû".indexOf(char)]!);
      if (fold(correction.original) === fold(correction.replacement)) return "turkce-karakter";
      return "yazim";
    }
  }
}

/** Motorun doğal logaritmik `margin` değerini 0–1 aralığında güven puanına dönüştürür. */
export function marginToConfidence(margin: number): number {
  if (!Number.isFinite(margin)) return margin > 0 ? 1 : 0;
  const raw = 1 / (1 + Math.exp(-margin / 2));
  return Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000));
}

function normalizeIgnoredWord(word: string): string {
  return lowerTr(word.trim());
}

/** Verilen düzeltmeleri metne uygular. Çakışma veya uyuşmazlık durumunda hata fırlatır. */
export function applyFixes(text: string, fixes: readonly Fix[]): string {
  if (fixes.length === 0) return text;
  const ordered = [...fixes].sort((first, second) => first.from - second.from);
  let output = "";
  let cursor = 0;

  for (const fix of ordered) {
    if (fix.from < 0 || fix.to < fix.from || fix.to > text.length) {
      throw new Error(`autr: Geçersiz düzeltme aralığı [${fix.from}, ${fix.to}).`);
    }
    if (fix.from < cursor) {
      throw new Error(`autr: Çakışan düzeltmeler uygulanamaz (${fix.from} < ${cursor}).`);
    }
    const actual = text.slice(fix.from, fix.to);
    if (actual !== fix.original) {
      throw new Error(
        `autr: ${fix.from} konumunda "${fix.original}" bekleniyordu, metinde "${actual}" bulundu.`,
      );
    }
    output += text.slice(cursor, fix.from) + fix.replacement;
    cursor = fix.to;
  }

  return output + text.slice(cursor);
}

/** Çekirdek motoru (ve isteğe bağlı bağlam modelini) paket API'si ile sarmalayan çalışma motoru. */
export class TdkaiEngine {
  private readonly corrector: Corrector;
  private readonly ignored = new Set<string>();
  private contextSession: ContextSession | null;
  private asyncQueue: Promise<unknown> = Promise.resolve();
  private mode: Mode;
  private disposed = false;

  constructor(
    data: LoadedData,
    mode: Mode = "careful",
    ignored?: Iterable<string>,
    contextSession: ContextSession | null = data.contextSession ?? null,
  ) {
    this.mode = mode;
    this.contextSession = contextSession;
    this.corrector = new Corrector(data.lexicon, SETTINGS_BY_MODE[mode], data.known, data.morphology);
    if (ignored) {
      for (const word of ignored) this.ignore(word);
    }
  }

  get hasContext(): boolean {
    return this.contextSession !== null;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("autr: Örnek kapatıldı (dispose edildi) ve artık kullanılamaz.");
    }
  }

  setMode(mode: Mode): void {
    this.assertActive();
    this.mode = mode;
    this.corrector.settings = SETTINGS_BY_MODE[mode];
  }

  ignore(word: string): void {
    this.assertActive();
    const normalized = normalizeIgnoredWord(word);
    if (normalized) this.ignored.add(normalized);
  }

  unignore(word: string): void {
    this.assertActive();
    const normalized = normalizeIgnoredWord(word);
    if (normalized) this.ignored.delete(normalized);
  }

  private filterCorrections(
    text: string,
    corrections: readonly Correction[],
    range: readonly [number, number] | undefined,
    kindFilter: Set<FixKind> | null,
  ): Fix[] {
    if (corrections.length === 0) return [];

    const codeRanges = findCodeRanges(text);
    const fixes: Fix[] = [];
    let lastEnd = -1;

    for (const correction of corrections) {
      if (correction.original === correction.replacement) continue;
      if (correction.start < lastEnd) continue;

      if (range) {
        const [rangeFrom, rangeTo] = range;
        if (!(correction.start < rangeTo && correction.end > rangeFrom)) continue;
      }

      if (
        codeRanges.length > 0 &&
        codeRanges.some(([codeStart, codeEnd]) => correction.start < codeEnd && correction.end > codeStart)
      ) {
        continue;
      }

      if (this.ignored.has(normalizeIgnoredWord(correction.original))) continue;

      const kind = mapCorrectionKind(correction);
      if (kindFilter && !kindFilter.has(kind)) continue;

      fixes.push({
        from: correction.start,
        to: correction.end,
        original: correction.original,
        replacement: correction.replacement,
        kind,
        confidence: marginToConfidence(correction.margin),
        scope: correctionScope(correction),
        ...(correction.kind === "context" ? { byContext: true } : {}),
      });
      lastEnd = correction.end;
    }

    return fixes;
  }

  private filterFlags(
    text: string,
    rawFlags: readonly SpellFlag[],
    rawCorrections: readonly Correction[],
    range: readonly [number, number] | undefined,
    kindFilter: Set<FixKind> | null,
  ): Flag[] {
    if (rawFlags.length === 0) return [];
    if (kindFilter && !kindFilter.has("yazim")) return [];

    const codeRanges = findCodeRanges(text);
    const flags: Flag[] = [];
    let lastEnd = -1;

    for (const flag of rawFlags) {
      if (flag.start < lastEnd) continue;

      if (range) {
        const [rangeFrom, rangeTo] = range;
        if (!(flag.start < rangeTo && flag.end > rangeFrom)) continue;
      }

      if (
        codeRanges.length > 0 &&
        codeRanges.some(([codeStart, codeEnd]) => flag.start < codeEnd && flag.end > codeStart)
      ) {
        continue;
      }

      if (this.ignored.has(normalizeIgnoredWord(flag.original))) continue;

      if (
        rawCorrections.some(
          (c) => c.original !== c.replacement && flag.start < c.end && flag.end > c.start,
        )
      ) {
        continue;
      }

      flags.push({
        from: flag.start,
        to: flag.end,
        original: flag.original,
        suggestions: flag.suggestions.slice(0, 5),
        reason: flag.reason,
      });
      lastEnd = flag.end;
    }

    return flags;
  }

  private enqueueAsync<T>(task: () => Promise<T>): Promise<T> {
    const next = this.asyncQueue.then(task, task);
    this.asyncQueue = next.catch(() => {});
    return next;
  }

  async check(text: string, options: CheckOptions = {}): Promise<Fix[]> {
    this.assertActive();
    if (!text) return [];

    const range = options.range;
    if (range) {
      const [rangeFrom, rangeTo] = range;
      if (rangeFrom >= rangeTo) return [];
    }

    const kindFilter = options.kinds ? new Set<FixKind>(options.kinds) : null;
    if (kindFilter && kindFilter.size === 0) return [];

    const session = this.contextSession;
    const settings = settingsFor(options.mode ?? this.mode, kindFilter);
    if (!session) {
      this.corrector.settings = settings;
      let corrections: Correction[];
      try {
        corrections = this.corrector.correct(text, { autoMarked: options.autoMarked }).corrections;
      } finally {
        this.corrector.settings = SETTINGS_BY_MODE[this.mode];
      }
      return this.filterCorrections(text, corrections, range, kindFilter);
    }

    return this.enqueueAsync(async () => {
      this.assertActive();
      const activeSession = this.contextSession;
      this.corrector.settings = settings;
      let corrections: Correction[];
      try {
        corrections = activeSession
          ? (
              await this.corrector.correctAsync(text, activeSession.model, {
                autoMarked: options.autoMarked,
                priorTypoOriginals: options.priorTypoOriginals?.map(({ from, to, original }) => ({
                  start: from,
                  end: to,
                  original,
                })),
              })
            ).corrections
          : this.corrector.correct(text, { autoMarked: options.autoMarked }).corrections;
      } finally {
        this.corrector.settings = SETTINGS_BY_MODE[this.mode];
      }
      this.assertActive();
      return this.filterCorrections(text, corrections, range, kindFilter);
    });
  }

  async inspect(text: string, options: CheckOptions = {}): Promise<InspectResult> {
    this.assertActive();
    if (!text) return { fixes: [], flags: [] };

    const range = options.range;
    if (range) {
      const [rangeFrom, rangeTo] = range;
      if (rangeFrom >= rangeTo) return { fixes: [], flags: [] };
    }

    const kindFilter = options.kinds ? new Set<FixKind>(options.kinds) : null;
    if (kindFilter && kindFilter.size === 0) return { fixes: [], flags: [] };

    const session = this.contextSession;
    const settings = settingsFor(options.mode ?? this.mode, kindFilter);
    if (!session) {
      this.corrector.settings = settings;
      let result: { corrections: Correction[]; flags: SpellFlag[] };
      try {
        result = this.corrector.inspect(text, { autoMarked: options.autoMarked });
      } finally {
        this.corrector.settings = SETTINGS_BY_MODE[this.mode];
      }
      return {
        fixes: this.filterCorrections(text, result.corrections, range, kindFilter),
        flags: this.filterFlags(text, result.flags, result.corrections, range, kindFilter),
      };
    }

    return this.enqueueAsync(async () => {
      this.assertActive();
      const activeSession = this.contextSession;
      this.corrector.settings = settings;
      let result: { corrections: Correction[]; flags: SpellFlag[] };
      try {
        result = activeSession
          ? await this.corrector.inspectAsync(text, activeSession.model, {
              autoMarked: options.autoMarked,
              priorTypoOriginals: options.priorTypoOriginals?.map(({ from, to, original }) => ({
                start: from,
                end: to,
                original,
              })),
            })
          : this.corrector.inspect(text, { autoMarked: options.autoMarked });
      } finally {
        this.corrector.settings = SETTINGS_BY_MODE[this.mode];
      }
      this.assertActive();
      return {
        fixes: this.filterCorrections(text, result.corrections, range, kindFilter),
        flags: this.filterFlags(text, result.flags, result.corrections, range, kindFilter),
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ignored.clear();
    const session = this.contextSession;
    this.contextSession = null;
    if (session) {
      await this.asyncQueue.catch(() => {});
      await session.dispose();
    }
  }
}
