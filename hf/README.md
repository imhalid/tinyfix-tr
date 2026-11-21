---
language:
  - tr
license: cc-by-sa-4.0
tags:
  - turkish
  - spelling-correction
  - autocorrect
  - spell-checker
  - onnx
  - offline
library_name: onnx
---

# autr: Turkish autocorrect that runs offline

autr fixes Turkish spelling as you type, following TDK spelling rules, with no server: everything runs on the
user's device (browser, Node, or any ONNX-capable runtime). When it is sure, it fixes the word; when it isn't, it
flags the word and suggests corrections.

**Live demo:** [tdkai.halid.dev](https://tdkai.halid.dev)

## Türkçe özet

autr, TDK yazım kurallarına göre çalışan, internetsiz bir Türkçe otomatik düzeltme modelidir. Sunucuya ihtiyaç
duymaz; her şey kullanıcının cihazında çalışır. Emin olduğu hatayı düzeltir (Türkçe karakter, de/da, ki, mi,
bitişik/ayrı yazım, kesme işareti, harf hataları); emin olamadığı hatalı kelimenin altını çizip öneri sunar.

## Files

| File | Size (raw / gzip) | What it is |
|---|---|---|
| `lexicon.bin` | 5.59 MB / 3.30 MB | Word-form and word-pair frequencies (custom `ALX1` format) |
| `morph.bin` | 0.34 MB / 0.15 MB | Turkish morphology (Zemberek-based stems and suffix rules) and a stem/suffix prior (`AMR2`) |
| `known.tsv` | 31 KB / 11 KB | Hand-checked common misspellings ("herkez" → "herkes") |
| `context.onnx` | 3.02 MB / 2.51 MB | Optional context model: a 2.8M-parameter Turkish subword Transformer (int8) that chooses between candidates by meaning (oldu/öldü, de/da, yıllar/yollar) |
| `manifest.json` | — | File sizes, read by the loader |

The core files (`lexicon.bin`, `morph.bin`, `known.tsv`) are 3.46 MB gzipped. `context.onnx` is optional.

These files are read by the autr engine (TypeScript); the binary formats are not a general-purpose format.
`context.onnx` expects the engine's subword tokenizer and candidate features.

## How it works

1. **Core engine:** a count-based noisy channel over a 1M-form lexicon, checked by Turkish morphology. It
   generates candidates for Turkish letters typed in ASCII, typos (missed, extra, swapped and neighbouring keys, up
   to two edits), de/da, ki, mi, joined/split words and apostrophes, and only changes a word when the margin over what
   was typed is clear.
2. **Detection:** a word that morphology rejects and the lexicon doesn't know is flagged with up to five ranked
   suggestions. Proper names, foreign words, abbreviations, numbers, URLs and code are left alone.
3. **Context model (optional):** re-scores the competing candidates using the whole sentence. In the demo it re-reads
   the current paragraph while you type, so a word can change once the rest of the sentence arrives
   ("Ondan hiç hber" → "her" → "haber" after "alamadım").

## Results

Measured on held-out sets the model was never tuned on. *Fixed* means corrected automatically; *found* means fixed
or flagged with suggestions.

| Set | Fixed (core) | Fixed (with context) | Found (fixed + flagged) |
|---|---|---|---|
| Wikipedia sentences with typos (test2, 400) | 84.0% | 89.3% | 98.3% |
| Wikipedia sentences with typos (test, 400) | 84.0% | 87.3% | 96.3% |
| Chat-style sentences, missed letters (811 words) | 69.7% | 83.6% | 99.4% |
| Chat-style sentences, mixed errors (602 words) | 68.8% | 75.2% | 99.5% |

False alarms on correct text: about 2 changed words per 1,000 on Wikipedia sentences (mostly rare names and
technical terms), 0.1 per 1,000 on clean chat-style sentences.

## Limitations

- Errors where the typed word is itself a valid word in the wrong place (a missing apostrophe, de/da) are not
  flagged; they are only fixed when the engine is sure.
- Colloquial spellings ("buluşcaz") get flagged but suggestions can be weak.
- Rare technical and foreign words may be flagged.

## Attribution and license

The model files are released under **CC BY-SA 4.0**.

- Word frequencies come from **Turkish Wikipedia** (CC BY-SA 4.0).
- Conversational word frequencies come from movie and TV subtitles from
  **[OpenSubtitles.org](http://www.opensubtitles.org/)**, via the OPUS corpus:
  P. Lison and J. Tiedemann, 2016, *OpenSubtitles2016: Extracting Large Parallel Corpora from Movie and TV
  Subtitles*, LREC 2016. Only word counts are distributed; no subtitle text is included.
- Morphology is derived from **[Zemberek-NLP](https://github.com/ahmetaa/zemberek-nlp)** (Apache 2.0).
- No training text is distributed with this model.
