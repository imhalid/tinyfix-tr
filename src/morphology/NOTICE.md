# Third-Party Notices

This directory (`src/morphology/`) contains TypeScript code adapted from **Zemberek-NLP**, licensed under the Apache License, Version 2.0.

- **Upstream project:** Zemberek-NLP (`https://github.com/ahmetaa/zemberek-nlp`)
- **Copyright:** Copyright 2018 Ahmet A. Akın, Mehmet D. Akın
- **License:** Apache License, Version 2.0 (full license text is included in the repository at `data/morph/LICENSE-zemberek`)

## Adapted Components

The implementation in `src/morphology/` was rewritten in TypeScript and simplified for fast spellchecking validation, adapting data structures, rules, and algorithms from the following Zemberek source files (found under `reference/zemberek/`):

1. **`src/morphology/types.ts` & `src/morphology/phonetics.ts`**
   - Adapted from `AttributesHelper.java`, `SurfaceTransition.java`, `SuffixTransition.java`, and Zemberek's root/phonetic attribute definitions (`RootAttribute`, `PhoneticAttribute`).
   - Uses 32-bit bitmasks for root and phonetic attributes and preserves Zemberek's suffix template notation (`A`, `I`, `+x`, `>x`, `~x`, `!x`).

2. **`src/morphology/morphotactics.ts`**
   - Adapted from `TurkishMorphotactics.java` and `Conditions.java`.
   - Implements the Turkish finite-state morphotactics graph for nouns, compounds (`CompoundP3sg`), `su`/`akarsu`, adjectives, numerals, nominal predicates (`ek-fiil` and `değil`), pronouns, adverbs, postpositives, verbs (tenses, compound tenses, negation, ability/unable, voice, verbal nouns, participles, converbs, and irregular `demek`/`yemek`), standalone question particles, and `imek`.
   - Modified for formal spellchecking precision: colloquial vowel-dropped locative/ablative contractions (`connectLastVowelDropWords`: *burda, içerde, ilerde*...) are omitted, nominalization of closed-class function adjectives (*nasıl, öyle, her...*) and locative on *daha* are restricted, pronominal `-ki` routes nominal cases through `pronAfterRel_S` to reject non-buffer forms (*\*evdekiyi*), and productive `-daş` (`>dAş`) derivation is added.

3. **`src/morphology/dictionary.ts`**
   - Adapted from `StemTransitionsBase.java` and Zemberek's `.dict` lexicon format (`data/morph/master-dictionary.dict`, `non-tdk.dict`, `informal.dict`, `proper.dict`).
   - Implements `.dict` parsing, automatic Turkish root attribute inference (`Aorist_A`/`Aorist_I`, `Passive_In`, `Causative_t`, `ProgressiveVowelDrop`, non-verb `Voicing`), `CompoundP3sgRoot` dummy stem generation, and special root stem alternation (`ben/ban`, `sen/san`, `de/di`, `ye/yi`, `birbiri/birbir`, `çoğu/çok`, etc.).
   - Excludes `[A:Ext]` and `[A:Informal]` lexicon entries and a small set of non-TDK entries present in `master-dictionary.dict` to avoid accepting common misspellings.

4. **`src/morphology/analyzer.ts`**
   - Adapted from `RuleBasedAnalyzer.java`, `SearchPath.java`, and `StemTransitionsMapBased.java`.
   - Redesigned for low-allocation forward DFS validation (`isWord`) with zero-substring offset tracking, linked `PathNode` chains, 64-entry per-transition phonetic surface caches, circumflex verification, and a bounded result cache.
