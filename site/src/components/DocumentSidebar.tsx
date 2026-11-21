import { Show, createMemo } from "solid-js";
import { APP_NAME } from "../brand";
import type { ResolvedTheme } from "../settings";
import type { DocRecord } from "../storage";
import {
  Button,
  NavList,
  ThemeToggle,
  Tooltip,
  XIcon,
  formatNumberTr,
  formatShortDateTr,
  type NavItem,
} from "../ui";
import { DocIcon, PlusIcon, ShieldIcon } from "./Icons";

export interface DocumentSidebarProps {
  docs: readonly DocRecord[];
  activeDocId: string;
  resolvedTheme: ResolvedTheme;
  /** true ise mobil Sheet içindedir; üst marka satırı çizilmez (Sheet'in kendi başlığı var). */
  inSheet?: boolean;
  onNewDoc: () => void;
  onSelectDoc: (id: string) => void;
  onRequestDeleteDoc: (doc: DocRecord) => void;
  onToggleTheme: (next: ResolvedTheme) => void;
  onOpenPrivacy: () => void;
}

export function DocumentSidebar(props: DocumentSidebarProps) {
  const navItems = createMemo<NavItem[]>(() =>
    props.docs.map((doc) => {
      const title = doc.title.trim() || "Adsız belge";
      return {
        value: doc.id,
        icon: <DocIcon />,
        label: (
          <span class="doc-nav-text">
            <span class="doc-nav-title">{title}</span>
            <span class="doc-nav-meta">
              {formatShortDateTr(doc.updatedAt)}
            </span>
          </span>
        ),
        badge: doc.wordCount > 0 ? formatNumberTr(doc.wordCount) : undefined,
        trailing: (
          <button
            type="button"
            class="doc-row-delete"
            title="Belgeyi sil"
            aria-label={`«${title}» belgesini sil`}
            onClick={(e) => {
              e.stopPropagation();
              props.onRequestDeleteDoc(doc);
            }}
          >
            <XIcon />
          </button>
        ),
      };
    }),
  );

  return (
    <div class={["sidebar-inner", { "in-sheet": Boolean(props.inSheet) }]}>
      <Show when={!props.inSheet}>
        <div class="sidebar-top">
          <div class="brand">
            <span class="brand-name">{APP_NAME}</span>
          </div>
          <Tooltip
            content={props.resolvedTheme === "dark" ? "Açık tema" : "Koyu tema"}
            side="bottom"
          >
            <ThemeToggle
              size="sm"
              value={props.resolvedTheme}
              onChange={props.onToggleTheme}
            />
          </Tooltip>
        </div>
      </Show>

      <div class="sidebar-create">
        <Button size="sm" block onClick={props.onNewDoc}>
          <PlusIcon />
          <span>Yeni belge</span>
        </Button>
      </div>

      <div class="sidebar-list">
        <NavList
          size="sm"
          label="Belgeler"
          items={navItems()}
          current={props.activeDocId}
          onSelect={props.onSelectDoc}
        />
      </div>

      <div class="sidebar-foot">
        <button
          type="button"
          class="link sidebar-privacy"
          onClick={props.onOpenPrivacy}
        >
          <ShieldIcon />
          <span>Yazılan hiçbir şey cihazdan çıkmaz</span>
        </button>
        <Show when={props.inSheet}>
          <ThemeToggle
            size="sm"
            value={props.resolvedTheme}
            onChange={props.onToggleTheme}
          />
        </Show>
      </div>
    </div>
  );
}
