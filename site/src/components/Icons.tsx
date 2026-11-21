import { Svg } from "../ui";

export function SidebarIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={15} height={15}>
      <rect x={2} y={2.5} width={12} height={11} rx={2} />
      <path d="M6 2.5v11" />
    </Svg>
  );
}

export function PlusIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Svg>
  );
}

export function DocIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M4 2.5h5.5L12.5 5.5v8a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9.5 2.5v3h3" />
    </Svg>
  );
}

export function HeadingIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M3.5 3.5v9M12.5 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function BoldIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M4.5 3.2h4a2.4 2.4 0 0 1 0 4.8h-4V3.2z" />
      <path d="M4.5 8h4.5a2.4 2.4 0 0 1 0 4.8H4.5V8z" />
    </Svg>
  );
}

export function ItalicIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M9.5 3.5h-3M9.5 12.5h-3M9 3.5l-2 9" />
    </Svg>
  );
}

export function ListIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M6 4.5h7M6 8h7M6 11.5h7" />
      <circle cx={3.2} cy={4.5} r={0.7} fill="currentColor" stroke="none" />
      <circle cx={3.2} cy={8} r={0.7} fill="currentColor" stroke="none" />
      <circle cx={3.2} cy={11.5} r={0.7} fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function QuoteIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M3 4v8M6.5 5.5h6.5M6.5 8.5h5M6.5 11.5h3.5" />
    </Svg>
  );
}

export function UndoIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M6 4.5L3 7.5l3 3" />
      <path d="M3.5 7.5H10a3 3 0 0 1 0 6H7.5" />
    </Svg>
  );
}

export function DownloadIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={14} height={14}>
      <path d="M8 2.8v7.4M5 7.5l3 3 3-3M3 13h10" />
    </Svg>
  );
}

export function ChevronDownIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={12} height={12}>
      <path d="M4.5 6.5L8 10l3.5-3.5" />
    </Svg>
  );
}

export function SettingsIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={15} height={15}>
      <path d="M2.5 5h4.5M10 5h3.5M2.5 11h7M12.5 11h1" />
      <circle cx={8.5} cy={5} r={1.5} />
      <circle cx={11} cy={11} r={1.5} />
    </Svg>
  );
}

export function ShieldIcon() {
  return (
    <Svg viewBox="0 0 16 16" width={13} height={13}>
      <path d="M8 2l5 2v3.8c0 3.2-2.1 5.3-5 6.2-2.9-.9-5-3-5-6.2V4l5-2z" />
    </Svg>
  );
}
