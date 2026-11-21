import assert from "node:assert/strict";
import test from "node:test";
import { applySentenceRules } from "./sentence.ts";

const WORDS = new Set([
  "merhaba", "ben", "geldim", "sonra", "gittik", "bugün", "çok", "güzel", "nasılsın", "iyiyim", "ahmet", "sınıf",
  "kez", "dosya", "site", "şeyler", "bir", "ne", "oldu", "dedi", "evet", "hayır", "gel", "hemen", "dün", "ilk",
  "istanbul", "uygulama", "inanılmaz", "ile", "bu", "aynı", "onlar",
]);
const isWord = (lower: string) => WORDS.has(lower);
const NAMES = new Map([
  ["bell", "Bell"],
  ["hatay", "Hatay"],
  ["cola", "Cola"],
  ["ahmet", "Ahmet"],
  ["istanbul", "İstanbul"],
  ["türkçe", "Türkçe"],
]);
const nameFor = (lower: string) => NAMES.get(lower);
const STEMS: Record<string, string[]> = {
  istanbula: ["istanbul"],
  ahmetle: ["ahmet"],
  türkçeyi: ["türkçe"],
  belli: ["bel", "belli"],
  hatayı: ["hata"],
};
const stemsOf = (lower: string) => STEMS[lower] ?? [];

function fix(text: string, corrections: { start: number; end: number; original: string; replacement: string }[] = []) {
  let out = "";
  let cursor = 0;
  for (const c of applySentenceRules(text, corrections, isWord, nameFor, stemsOf)) {
    out += text.slice(cursor, c.start) + c.replacement;
    cursor = c.end;
  }
  return out + text.slice(cursor);
}

test("sentence rules: missing space after a full stop and capitals", () => {
  assert.equal(fix("merhaba.ben geldim"), "Merhaba. Ben geldim");
  assert.equal(fix("nasılsın?iyiyim"), "Nasılsın? İyiyim");
  assert.equal(fix("gel!hemen"), "Gel! Hemen");
  assert.equal(fix("dün geldim. sonra gittik."), "Dün geldim. Sonra gittik.");
  assert.equal(fix("evet. ilk kez"), "Evet. İlk kez");
  assert.equal(fix("Bugün çok güzel."), "Bugün çok güzel.");
  assert.equal(fix("“ne oldu?” dedi."), "“Ne oldu?” dedi.");
});

test("sentence rules: leave abbreviations, numbers, ellipses and addresses alone", () => {
  // "Dr." is not a sentence end, but "ahmet" is a name: it gets a capital anyway.
  assert.equal(fix("Dr. ahmet geldi"), "Dr. Ahmet geldi");
  assert.equal(fix("Bir dr. lazım"), "Bir dr. lazım");
  assert.equal(fix("Dr. ali geldi"), "Dr. ali geldi");
  assert.equal(fix("Kalem, defter vb. şeyler aldık"), "Kalem, defter vb. şeyler aldık");
  assert.equal(fix("Bu 3. sınıf, ilk kez geldim."), "Bu 3. sınıf, ilk kez geldim.");
  assert.equal(fix("Değer 3.5 oldu"), "Değer 3.5 oldu");
  assert.equal(fix("Bilmiyorum... belki gelir"), "Bilmiyorum... belki gelir");
  assert.equal(fix("Bilmiyorum… belki gelir"), "Bilmiyorum… belki gelir");
  assert.equal(fix("Siteye tdkai.halid.dev üzerinden girin"), "Siteye tdkai.halid.dev üzerinden girin");
  assert.equal(fix("Bunu dosya.pdf olarak gönder"), "Bunu dosya.pdf olarak gönder");
  assert.equal(fix("Bkz. site.com adresi"), "Bkz. site.com adresi");
  assert.equal(fix("ahmet@site.com yazdı"), "Ahmet@site.com yazdı".replace("Ahmet", "ahmet"));
  assert.equal(fix("A. Yılmaz geldi. sonra gittik"), "A. Yılmaz geldi. Sonra gittik");
  assert.equal(fix("iPhone aldım"), "iPhone aldım");
  assert.equal(fix("XVIII. yüzyıl boyunca"), "XVIII. yüzyıl boyunca");
  assert.equal(fix("Hızı 217 km. yaptı"), "Hızı 217 km. yaptı");
  assert.equal(fix("Frekans 5.75 MHz. tir"), "Frekans 5.75 MHz. tir");
  assert.equal(fix("Ruiz & Pav. ex Dunal"), "Ruiz & Pav. ex Dunal");
  assert.equal(fix("Filipina Hola! magazin dergisi"), "Filipina Hola! magazin dergisi");
  assert.equal(fix("Merhaba! nasılsın"), "Merhaba! Nasılsın");
  assert.equal(fix("Hey Ocean! ve diğerleri"), "Hey Ocean! ve diğerleri");
  assert.equal(fix("ს. ყაუხჩიშვილი. ბერძნული"), "ს. ყაუხჩიშვილი. ბერძნული");
  // Only real words on both sides: "istanbul.xyz" and "abc.def" are not sentences.
  assert.equal(fix("Adres abc.def olsun"), "Adres abc.def olsun");
});

test("sentence rules: proper names", () => {
  assert.equal(fix("Dün ahmet ile istanbula gittik."), "Dün Ahmet ile İstanbul'a gittik.");
  assert.equal(fix("Bunu ahmet'e sor, türkçe biliyor."), "Bunu Ahmet'e sor, Türkçe biliyor.");
  assert.equal(fix("Bu ahmetle ilgili"), "Bu Ahmet'le ilgili");
  assert.equal(fix("Bugün dr. ahmet geldi"), "Bugün Dr. Ahmet geldi");
  assert.equal(fix("Onlar türkçeyi seviyor"), "Onlar Türkçeyi seviyor");
  // Ordinary words that only start like a name: "bel + li", "hata + yı".
  assert.equal(fix("Bu belli değil"), "Bu belli değil");
  assert.equal(fix("Aynı hatayı yaptım"), "Aynı hatayı yaptım");
  assert.equal(fix("Bir pina colada istedim"), "Bir pina colada istedim");
  assert.equal(fix("Adres istanbul.com olsun"), "Adres istanbul.com olsun");
  assert.equal(fix("Jyutping: ahmet2 olur"), "Jyutping: ahmet2 olur");
  assert.equal(fix('Bu "i" harfi'), 'Bu "i" harfi');
});

test("sentence rules: merge with a fix another rule makes to the same word", () => {
  // "cok" -> "çok" by the marks rule; at a sentence start it becomes "Çok".
  assert.equal(fix("cok güzel", [{ start: 0, end: 3, original: "cok", replacement: "çok" }]), "Çok güzel");
  // Missing space before a word that another rule fixes: "merhaba.cok" -> "Merhaba. Çok".
  assert.equal(
    fix("merhaba.cok güzel", [{ start: 8, end: 11, original: "cok", replacement: "çok" }]),
    "Merhaba. Çok güzel",
  );
});
