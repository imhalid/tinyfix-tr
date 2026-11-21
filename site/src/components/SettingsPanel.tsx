import { ALL_FIX_KINDS, type FixKind, type Mode } from "autr";
import { For, Show, createSignal } from "solid-js";
import { Choice, Switch, type ChoiceOption } from "../kit/controls";
import { FIX_KIND_META, type AppSettings, type Theme } from "../settings";

export interface SettingsPanelProps {
  settings: AppSettings;
  contextWarning: string | null;
  /** Bağlam modeli dosyası sitede var mı (models/manifest.json). Yoksa anahtar hiç gösterilmez. */
  contextAvailable: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleContextModel: (enabled: boolean) => void;
  onChangeMode: (mode: Mode) => void;
  onToggleKind: (kind: FixKind, enabled: boolean) => void;
  onAddIgnoredWord: (word: string) => void;
  onRemoveIgnoredWord: (word: string) => void;
  onChangeTheme: (theme: Theme) => void;
}

const MODE_OPTIONS: readonly ChoiceOption<Mode>[] = [
  { value: "careful", label: "Temkinli" },
  { value: "balanced", label: "Dengeli" },
];

const THEME_OPTIONS: readonly ChoiceOption<Theme>[] = [
  { value: "system", label: "Sistem" },
  { value: "light", label: "Açık" },
  { value: "dark", label: "Koyu" },
];

/** Ayarlar çekmecesinin içi. Tüm tercihler yalnızca bu cihazda saklanır. */
export function SettingsPanel(props: SettingsPanelProps) {
  const [wordDraft, setWordDraft] = createSignal("");

  const modeHint = () =>
    props.settings.mode === "careful"
      ? "Yalnızca çok emin olduğu hataları düzeltir."
      : "Daha fazla hatayı yakalar, biraz daha cesurdur.";

  const handleAddWord = (event: SubmitEvent) => {
    event.preventDefault();
    const raw = wordDraft().trim();
    if (!raw) return;
    props.onAddIgnoredWord(raw);
    setWordDraft("");
  };

  return (
    <div class="settings">
      <section class="settings-section">
        <h3 class="section-label">Otomatik düzeltme</h3>
        <Switch
          checked={props.settings.enabled}
          onChange={props.onToggleEnabled}
          label="Yazarken otomatik düzelt"
          description="Kelime bittiğinde (boşluk ya da noktalama) düzeltmeyi uygular."
        />
        <Show when={props.contextAvailable}>
          <Switch
            checked={props.settings.contextModel}
            onChange={props.onToggleContextModel}
            label="Bağlam modeli"
            description="«bende / ben de», «oldu / öldü» gibi bağlama bağlı seçimleri yerel modelle çözer."
          />
          <Show when={props.settings.contextModel && props.contextWarning}>
            <p class="settings-note">Bağlam modeli şu an yüklenemedi; sözlük kurallarıyla devam ediliyor.</p>
          </Show>
        </Show>
      </section>

      <section class="settings-section">
        <h3 class="section-label">Hassasiyet</h3>
        <Choice label="Hassasiyet" options={MODE_OPTIONS} value={props.settings.mode} onChange={props.onChangeMode} />
        <p class="settings-note">{modeHint()}</p>
      </section>

      <section class="settings-section">
        <h3 class="section-label">Düzeltme türleri</h3>
        <For each={ALL_FIX_KINDS}>
          {(kind) => {
            const meta = FIX_KIND_META[kind];
            return (
              <Switch
                checked={props.settings.kinds[kind]}
                onChange={(checked) => props.onToggleKind(kind, checked)}
                label={meta.label}
                description={
                  <>
                    {meta.description} <span class="example">{meta.example}</span>
                  </>
                }
              />
            );
          }}
        </For>
      </section>

      <section class="settings-section">
        <h3 class="section-label">Bu kelimeleri bir daha değiştirme</h3>
        <form class="ignore-form" onSubmit={handleAddWord}>
          <input
            class="text-input"
            value={wordDraft()}
            placeholder="Kelime ekle"
            spellcheck={false}
            autocomplete="off"
            aria-label="Yoksayılacak kelime"
            onInput={(event) => setWordDraft(event.currentTarget.value)}
          />
          <button type="submit" class="button" disabled={!wordDraft().trim()}>
            Ekle
          </button>
        </form>
        <Show
          when={props.settings.ignoredWords.length > 0}
          fallback={<p class="settings-note">Henüz yoksayılan kelime yok. Bir düzeltmeyi geri alırken de ekleyebilirsiniz.</p>}
        >
          <ul class="word-chips" aria-label="Yoksayılan kelimeler">
            <For each={props.settings.ignoredWords}>
              {(word) => (
                <li class="word-chip">
                  <span>{word}</span>
                  <button
                    type="button"
                    class="chip-remove"
                    aria-label={`«${word}» kelimesini listeden çıkar`}
                    onClick={() => props.onRemoveIgnoredWord(word)}
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="settings-section">
        <h3 class="section-label">Görünüm</h3>
        <Choice label="Tema" options={THEME_OPTIONS} value={props.settings.theme} onChange={props.onChangeTheme} />
      </section>
    </div>
  );
}
