/** Uygulama adı tek bir sabitte tutulur; ileride marka değiştiğinde yalnızca burası güncellenir. */
export const APP_NAME = "tdkai";
export const APP_TAGLINE = "İnternetsiz Türkçe yazı alanı";
export const MODELS_BASE_URL = "./models/";
export const ORT_WASM_BASE_URL = "./ort/";
/**
 * Tarayıcıdaki kayıt anahtarları eski adla ("autr") kalır: değişirse kullanıcıların belgeleri ve ayarları kaybolur.
 * `index.html` içindeki tema betiği de aynı ayar anahtarını okur.
 */
const STORAGE_PREFIX = "autr";
export const SETTINGS_STORAGE_KEY = `${STORAGE_PREFIX}:settings:v1`;
export const ACTIVE_DOC_STORAGE_KEY = `${STORAGE_PREFIX}:active-doc:v1`;
export const DOCS_DB_NAME = `${STORAGE_PREFIX}-documents`;
