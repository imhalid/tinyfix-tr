/** Turkish-aware casing and letter helpers. JavaScript's own toLowerCase gets I/ı and İ/i wrong for Turkish. */

export const LETTERS = "A-Za-zÇĞİÖŞÜçğıöşüÂÎÛâîû";
const LETTER = new RegExp(`^[${LETTERS}]$`);

export function lowerTr(text: string): string {
  return text.replaceAll("I", "ı").replaceAll("İ", "i").toLowerCase().replaceAll("’", "'");
}

export function upperTr(text: string): string {
  return text.replaceAll("i", "İ").replaceAll("ı", "I").toUpperCase();
}

export function isLetter(char: string): boolean {
  return LETTER.test(char);
}

export function isUpperInitial(word: string): boolean {
  const first = word[0] ?? "";
  return first !== lowerTr(first);
}

export function isAllUpper(word: string): boolean {
  return word.length > 1 && word === upperTr(word) && word !== lowerTr(word);
}

/** Gives the replacement the typed word's casing: "Cok" becomes "Çok", "COK" becomes "ÇOK". */
export function matchCase(typed: string, replacement: string): string {
  if (isAllUpper(typed)) return upperTr(replacement);
  if (isUpperInitial(typed)) return upperTr(replacement.slice(0, 1)) + replacement.slice(1);
  return replacement;
}

/** Letters that lose their marks when typed on a keyboard without Turkish characters, and back. */
const TOGGLE: Record<string, string> = { c: "ç", g: "ğ", i: "ı", o: "ö", s: "ş", u: "ü", ı: "i", ç: "c", ğ: "g", ö: "o", ş: "s", ü: "u" };
const ASCII_SIDE = new Set(["c", "g", "i", "o", "s", "u"]);

/**
 * Words that differ from a lowercase word only in Turkish marks: "cok" gives "çok", "çök", "cök", "çok"...
 * Only ASCII letters are toggled to Turkish ones, except a leading "ı" which is how a typed capital "I" lowercases
 * ("Istanbul" lowercases to "ıstanbul" and should be able to reach "istanbul").
 */
export function markVariants(word: string, limit = 512): string[] {
  const positions: number[] = [];
  for (let index = 0; index < word.length; index++) {
    const char = word[index]!;
    if (ASCII_SIDE.has(char) || (char === "ı" && index === 0)) positions.push(index);
  }
  const variants: string[] = [];
  const count = Math.min(2 ** positions.length, limit);
  for (let mask = 1; mask < count; mask++) {
    const chars = [...word];
    positions.forEach((position, bit) => {
      if (mask & (1 << bit)) chars[position] = TOGGLE[chars[position]!]!;
    });
    variants.push(chars.join(""));
  }
  return variants;
}

export function hasTurkishMarks(text: string): boolean {
  return /[çğıöşüÇĞİÖŞÜ]/.test(text);
}

/** Turkish Q keyboard rows, used to judge how likely a slip of the fingers is. */
const KEYBOARD_ROWS = ["qwertyuıopğü", "asdfghjklşi", "zxcvbnmöç"];
const NEAR = new Map<string, Set<string>>();
KEYBOARD_ROWS.forEach((row, rowIndex) => {
  [...row].forEach((key, keyIndex) => {
    const near = new Set<string>();
    for (const [r, c] of [
      [rowIndex, keyIndex - 1],
      [rowIndex, keyIndex + 1],
      [rowIndex - 1, keyIndex],
      [rowIndex - 1, keyIndex + 1],
      [rowIndex + 1, keyIndex],
      [rowIndex + 1, keyIndex - 1],
    ] as const) {
      const key2 = KEYBOARD_ROWS[r]?.[c];
      if (key2) near.add(key2);
    }
    NEAR.set(key, near);
  });
});

export function areNearKeys(first: string, second: string): boolean {
  return NEAR.get(first)?.has(second) ?? false;
}

export const ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyz";
