/** Türkçe sayı, boyut ve tarih biçimleri; platform algılama. */

const trInt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const trShortDate = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short" });
const trLongDate = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" });

export function formatNumberTr(n: number): string {
  return trInt.format(n);
}

export function formatShortDateTr(timestamp: number): string {
  try {
    return trShortDate.format(new Date(timestamp));
  } catch {
    return "";
  }
}

export function formatLongDateTr(timestamp: number): string {
  try {
    return trLongDate.format(new Date(timestamp));
  } catch {
    return "";
  }
}

export function formatBytesTr(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index++;
  }
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return new Intl.NumberFormat("tr-TR", {
    style: "unit",
    unit: units[index] ?? "byte",
    unitDisplay: "short",
    maximumFractionDigits: digits,
  }).format(value);
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}
