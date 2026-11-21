import type { ContextModel, RunModel } from "../../src/context.ts";

/** Dışarıya açılan Türkçe otomatik düzeltme türleri. */
export type FixKind = "turkce-karakter" | "kesme" | "bitisik-ayri" | "yazim" | "kisaltma";

/** Desteklenen tüm düzeltme türleri. */
export const ALL_FIX_KINDS: readonly FixKind[] = [
  "turkce-karakter",
  "kesme",
  "bitisik-ayri",
  "yazim",
  "kisaltma",
];

/**
 * `kinds` verilmediğinde uygulanan türler. "kisaltma" (noldu → ne oldu, burda → burada) bir üslup tercihi olduğu için
 * varsayılan olarak kapalı; açıkça istenince uygulanır.
 */
export const DEFAULT_FIX_KINDS: readonly FixKind[] = ["turkce-karakter", "kesme", "bitisik-ayri", "yazim"];

/** Düzeltme hassasiyet kipi: "careful" daha temkinli, "balanced" biraz daha cesur. */
export type Mode = "careful" | "balanced";

/**
 * Düzeltmenin neye bakılarak yapıldığı:
 * - "kelime": yalnızca kelimenin kendisi ("cok" → "çok", "herkez" → "herkes", "Ankaraya" → "Ankara'ya");
 * - "baglam": çevresindeki kelimeler de ("hiç bir" → "hiçbir", "yerler de" → "yerlerde", "geldinmi?" → "geldin mi?").
 */
export type FixScope = "kelime" | "baglam";

/** Metin üzerinde önerilen tek bir düzeltme. */
export interface Fix {
  /** Düzeltilecek parçanın başlangıç dizini (UTF-16 kod birimi). */
  from: number;
  /** Düzeltilecek parçanın bitiş dizini (dahil değil). */
  to: number;
  /** Kullanıcının yazdığı metin. */
  original: string;
  /** Önerilen doğru biçim. */
  replacement: string;
  /** Düzeltme türü. */
  kind: FixKind;
  /** 0 ile 1 arasında güven puanı (motorun margin değerinden türetilir). */
  confidence: number;
  /** Kararın yalnızca kelimeye mi, çevresine de mi dayandığı. */
  scope: FixScope;
  /** Kararı bağlam modeli verdi (yalnızca bağlam modeli yüklüyken). */
  byContext?: boolean;
}

/** İsteğe bağlı bağlam modeli dosya adı. */
export const CONTEXT_MODEL_FILE = "context.onnx" as const;

/** Bağlam modeli dosya adı türü. */
export type ContextModelFileName = typeof CONTEXT_MODEL_FILE;

/** İndirilen sözlük, biçimbilim ve bağlam modeli dosyalarının adları. */
export type DataFileName =
  | "lexicon.bin"
  | "morph.bin"
  | "known.tsv"
  | "unigrams.tsv"
  | "bigrams.tsv"
  | ContextModelFileName;

/** Bellekteki ham TSV sözlük verisi. */
export interface RawData {
  unigrams: string;
  bigrams: string;
  known: string;
  /** İsteğe bağlı biçimbilim verisi (`morph.bin` baytları veya Zemberek `.dict` metinleri). */
  morphology?: Uint8Array | string | readonly string[];
}

/** Bellekteki sıkıştırılmış ikili sözlük verisi (`lexicon.bin` + `morph.bin` + `known.tsv`). */
export interface BinaryData {
  lexicon: Uint8Array;
  morphology?: Uint8Array;
  known: string;
}

/** Açık bir bağlam modeli oturumu ve kaynak serbest bırakma işlevi. */
export interface ContextSession {
  model: ContextModel;
  dispose(): Promise<void>;
}

/** İndirilen `context.onnx` baytlarından bağlam modeli oturumu oluşturan işlev. */
export type ContextSessionLoader = (
  modelBytes: Uint8Array,
  options: { wasmPaths?: string },
) => Promise<ContextSession>;

/** Veri yükleme aşamasını ve oranını bildiren nesne. */
export interface LoadProgress {
  /** 0 ile 1 arasında genel ilerleme oranı. */
  ratio: number;
  /** Şu ana kadar indirilen toplam bayt sayısı. */
  loaded: number;
  /** Biliniyorsa toplam bayt sayısı; sıkıştırılmış veya belirsiz akışlarda null. */
  total: number | null;
  /** Mevcut yükleme aşaması. */
  stage: "downloading" | "parsing" | "ready";
  /** İndirme veya hazırlama aşamasındaysa o an işlenen dosya. */
  file?: DataFileName;
}

/** Yükleme ilerlemesi için geri çağırma işlevi. */
export type ProgressCallback = (progress: LoadProgress) => void;

/** İsteğe bağlı bileşenlerle ilgili uyarıları alan geri çağırma işlevi. */
export type WarningCallback = (message: string) => void;

/** `loadAutr` seçenekleri. */
export interface LoadOptions {
  /** Sözlük (ve `context: true` ise `context.onnx`) dosyalarının bulunduğu temel URL. Varsayılan: "/models/". */
  baseUrl?: string | URL;
  /** Ağ isteği yapmadan doğrudan bellek içi sözlük verisi (ikili veya ham TSV) kullanmak için. */
  data?: RawData | BinaryData;
  /** Düzeltme hassasiyeti. Varsayılan: "careful". */
  mode?: Mode;
  /** true verilirse sözlük yükleme, bağlam modeli ve denetim ayrı bir Web Worker içinde çalışır. */
  worker?: boolean;
  /** İsteğe bağlı özel Worker üreticisi (özel paketleyici veya testler için). */
  createWorker?: () => Worker;
  /** true verilirse `baseUrl` altından `context.onnx` indirilir ve `onnxruntime-web` ile bağlam modeli açılır. Varsayılan: false. */
  context?: boolean;
  /** `onnxruntime-web` `.wasm`/`.mjs` dosyalarının bulunduğu dizin URL'si. Verilmezse paketleyicinin varsayılan yolu kullanılır. */
  wasmPaths?: string | URL;
  /** Testler veya özel çalışma zamanları için `context.onnx` yerine doğrudan bellekteki bağlam modeli ya da `RunModel` işlevi. */
  contextModel?: ContextModel | RunModel;
  /** Testler veya özel çalışma zamanları için indirilen `context.onnx` baytlarından oturum açan özel yükleyici. */
  loadContextSession?: ContextSessionLoader;
  /** Sözlük ve model indirme/ayrıştırma ilerlemesini bildiren geri çağırma. */
  onProgress?: ProgressCallback;
  /** İsteğe bağlı bağlam modeli yüklenemediğinde oluşan uyarıyı bildiren geri çağırma. */
  onWarning?: WarningCallback;
  /** İsteğe bağlı özel fetch işlevi (yalnızca ana iş parçacığı yüklemesinde). */
  fetch?: typeof globalThis.fetch;
  /** Yüklemeyi iptal etmek için AbortSignal. */
  signal?: AbortSignal;
  /** Sözlüğe alınacak en düşük kelime sıklığı. Varsayılan: 1. */
  minCount?: number;
  /** Sözlüğe alınacak en düşük kelime çifti sıklığı. Varsayılan: 1. */
  minPair?: number;
  /** Başlangıçta yoksayılacak kelimeler. */
  ignored?: Iterable<string>;
}

/** `check` ve `fix` çağrıları için seçenekler. */
export interface CheckOptions {
  /** Yalnızca bu [from, to) aralığıyla kesişen düzeltmeler döndürülür; metnin geri kalanı bağlam olarak okunur. */
  range?: readonly [from: number, to: number];
  /** Yalnızca bu türlerdeki düzeltmeler döndürülür. Varsayılan: tüm türler. */
  kinds?: readonly FixKind[];
  /** Yalnızca bu çağrı için geçerli hassasiyet kipi. */
  mode?: Mode;
  /**
   * Metinde otomatik düzeltmenin daha önce yazdığı [from, to) aralıkları. Buradaki Türkçe harfler, kullanıcının
   * Türkçe klavyeyle yazdığına kanıt sayılmaz; böylece "hic bir sey" yazılırken "hiç" düzeltildikten sonra
   * "sey" de düzeltilir.
   */
  autoMarked?: readonly (readonly [from: number, to: number])[];
  /**
   * Yalnızca bağlam modeli yüklüyken: otomatik düzeltmenin yazım hatası olarak değiştirdiği aralıklar ve kullanıcının
   * yazdığı ilk biçim. Arka plan geçişinde model, çekirdeğin seçtiği adayı ("hber" → "her") cümlenin geri kalanına
   * bakarak daha uygun bir adayla ("haber") değiştirebilir. Böyle bir düzeltmenin türü "context" olur.
   */
  priorTypoOriginals?: readonly { readonly from: number; readonly to: number; readonly original: string }[];
}

/** Türkçe otomatik düzeltici örneği. */
export interface Autr {
  /** Bağlam modelinin etkin olarak yüklenip yüklenmediği. */
  readonly hasContext: boolean;
  /** Metindeki düzeltmeleri sırayla ve çakışmayacak biçimde döndürür. */
  check(text: string, options?: CheckOptions): Promise<Fix[]>;
  /** Verilen düzeltmeleri metne uygular. Metin düzeltmeyle uyuşmuyorsa hata fırlatır. */
  apply(text: string, fixes: readonly Fix[]): string;
  /** `check` ve `apply` adımlarını birlikte çalıştırır. */
  fix(text: string, options?: CheckOptions): Promise<string>;
  /** Bu kelimeyi (veya ifadeyi) bir daha değiştirmez. */
  ignore(word: string): void;
  /** Daha önce yoksayılan bir kelimeyi yeniden denetime açar. */
  unignore(word: string): void;
  /** Düzeltme hassasiyet kipini günceller. */
  setMode(mode: Mode): void;
  /** Kaynakları (varsa bağlam modeli oturumunu ve Web Worker'ı) serbest bırakır. */
  dispose(): Promise<void>;
}
