import { ALL_FIX_KINDS, type FixKind, type Mode } from "autr";
import { For, Show, createMemo, createSignal } from "solid-js";
import { FIX_KIND_META, type AppSettings, type Theme } from "../settings";
import {
  Alert,
  Button,
  Chips,
  Field,
  Input,
  Segmented,
  Separator,
  Sheet,
  Switch,
  type ChipOption,
  type SegmentedOption,
} from "../ui";

export interface SettingsSheetProps {
  open: boolean;
  settings: AppSettings;
  contextWarning: string | null;
  onClose: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleContextModel: (enabled: boolean) => void;
  onChangeMode: (mode: Mode) => void;
  onToggleKind: (kind: FixKind, enabled: boolean) => void;
  onAddIgnoredWord: (word: string) => void;
  onRemoveIgnoredWord: (word: string) => void;
  onChangeTheme: (theme: Theme) => void;
}

const MODE_OPTIONS: readonly SegmentedOption<Mode>[] = [
  { value: "careful", label: "Temkinli" },
  { value: "balanced", label: "Dengeli" },
];

const THEME_OPTIONS: readonly SegmentedOption<Theme>[] = [
  { value: "system", label: "Sistem" },
  { value: "light", label: "Açık" },
  { value: "dark", label: "Koyu" },
];

export function SettingsSheet(props: SettingsSheetProps) {
  const [wordDraft, setWordDraft] = createSignal("");

  const ignoredChips = createMemo<ChipOption[]>(() =>
    props.settings.ignoredWords.map((word) => ({ value: word, label: word })),
  );

  const modeHint = () =>
    props.settings.mode === "careful"
      ? "Yalnızca çok emin olduğu hataları düzeltir."
      : "Daha fazla hatayı yakalar, biraz daha cesurdur.";

  const handleAddWord = (e: SubmitEvent) => {
    e.preventDefault();
    const raw = wordDraft().trim();
    if (!raw) return;
    props.onAddIgnoredWord(raw);
    setWordDraft("");
  };

  return (
    <Sheet
      open={props.open}
      onClose={() => props.onClose()}
      side="auto"
      title="Ayarlar"
      description="Tüm tercihler yalnızca bu cihazda saklanır."
    >
      <div class="settings-stack">
        <section class="settings-group">
          <h3 class="settings-group-title">Otomatik düzeltme</h3>
          <Switch
            class="settings-switch"
            checked={props.settings.enabled}
            onChange={props.onToggleEnabled}
            label="Yazarken otomatik düzelt"
            description="Kelime bittiğinde (boşluk veya noktalama) düzeltmeyi uygular."
          />
          <Switch
            class="settings-switch"
            checked={props.settings.contextModel}
            onChange={props.onToggleContextModel}
            label="Bağlam modeli"
            description="«bende / ben de», «oldu / öldü» gibi bağlama bağlı seçimleri yerel modelle (~2 MB) çözer."
          />
          <Show when={props.settings.contextModel && props.contextWarning}>
            <Alert tone="neutral">
              Bağlam modeli şu an yüklenemedi; sözlük kurallarıyla devam ediliyor.
            </Alert>
          </Show>
        </section>

        <Separator decorative />

        <section class="settings-group">
          <Field label="Hassasiyet kipi" hint={modeHint()}>
            <Segmented
              fill
              size="sm"
              options={MODE_OPTIONS}
              value={props.settings.mode}
              onChange={props.onChangeMode}
            />
          </Field>
        </section>

        <Separator decorative />

        <section class="settings-group">
          <h3 class="settings-group-title">Düzeltme türleri</h3>
          <For each={ALL_FIX_KINDS}>
            {(kind) => {
              const meta = FIX_KIND_META[kind];
              return (
                <Switch
                  class="settings-switch"
                  checked={props.settings.kinds[kind]}
                  onChange={(checked) => props.onToggleKind(kind, checked)}
                  label={meta.label}
                  description={
                    <>
                      <span>{meta.description}</span>
                      <span class="settings-example">{meta.example}</span>
                    </>
                  }
                />
              );
            }}
          </For>
        </section>

        <Separator decorative />

        <section class="settings-group">
          <Field
            label="Bu kelimeleri bir daha değiştirme"
            hint="Geri aldığınız kelimeleri bildirimden de ekleyebilirsiniz."
          >
            <form class="ignore-form" onSubmit={handleAddWord}>
              <Input
                size="sm"
                clearable
                value={wordDraft()}
                placeholder="Kelime ekle…"
                spellcheck="false"
                autocomplete="off"
                onInput={(e) => setWordDraft(e.currentTarget.value)}
                onClear={() => setWordDraft("")}
              />
              <Button type="submit" size="sm" disabled={!wordDraft().trim()}>
                Ekle
              </Button>
            </form>
          </Field>

          <Show
            when={ignoredChips().length > 0}
            fallback={<p class="settings-empty t-caption muted">Henüz yoksayılan kelime yok.</p>}
          >
            <Chips
              size="sm"
              label="Yoksayılan kelimeler"
              options={ignoredChips()}
              onRemove={props.onRemoveIgnoredWord}
            />
          </Show>
        </section>

        <Separator decorative />

        <section class="settings-group">
          <Field label="Görünüm">
            <Segmented
              fill
              size="sm"
              options={THEME_OPTIONS}
              value={props.settings.theme}
              onChange={props.onChangeTheme}
            />
          </Field>
        </section>
      </div>
    </Sheet>
  );
}
