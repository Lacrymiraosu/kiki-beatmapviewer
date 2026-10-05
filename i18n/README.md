# Translations

Every piece of text on the site is looked up here. One file per language, keyed by the English text:

| File | Language |
|---|---|
| `en.json` | English: the list of every key (each value is the key itself) |
| `th.json` | ไทย |
| `ms.json` | Bahasa Melayu |
| `id.json` | Bahasa Indonesia |
| `ko.json` | 한국어 |
| `ja.json` | 日本語 |

```json
"Download": "ดาวน์โหลด",
"{n} projects": "{n} โปรเจกต์"
```

## Fixing or improving a translation

1. Open the language's file on GitHub and press the pencil (Edit) button.
2. Change only the text on the **right** of the colon. Never change the English key on the left.
3. Keep every `{placeholder}` exactly as it is (for example `{n}`, `{d}`, `{s}`); they are replaced with numbers, dates and names.
4. Keep the quotes, commas and `\"` escapes valid JSON. Propose the change as a pull request.

An empty value (`""`) means "not translated yet": the site shows the English text there.

osu! terms (circle, slider, spinner, BPM, SV, kiai, snap, stack, combo, hitsound, mod…) usually stay in English, the way the community uses them.

## Adding a new language

1. Copy `th.json` to `<code>.json` (two-letter code, e.g. `vi.json`) and translate every value (or set values to `""`).
2. Add the language to `LANGS` at the top of `js/i18n.js`.

## For developers

- New UI text: write it in English inside `tr("…")` or `data-i18n="…"`, then add the key to **every** file here. The quickest way:
  ```bash
  node scripts/i18n.mjs add rows.json
  ```
  where `rows.json` is `[["English", "ไทย", "Melayu", "Indonesia", "한국어", "日本語"], …]`.
- `node scripts/i18n.mjs status` shows untranslated entries and any UI string missing from `en.json`.
- The tests (`npm --prefix tests test`) fail if a language file is missing a key, has an unknown key, changes a `{placeholder}`, or if the code uses a string that isn't in `en.json`.
- The files are cached for a year: bump `?v=N` in `index.html` after changing them (the site loads `i18n/<lang>.json?v=N` with the same number as its scripts).
