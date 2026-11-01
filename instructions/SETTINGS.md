# Settings and creator profile

Open `node scripts/studio.mjs settings` for first-run profile setup or an explicit request to change defaults. Keep the process and browser open. Saved preferences are the starting point for new work; a one-video choice does not rewrite them.

Removed style ids are accepted on load and resolve to their merged replacement with a notice; saved profiles stay intact until an explicit save. New choices list only current styles. Migrated manifests retain optional `styleAlias` provenance so an existing explicit PiP or animated caption keeps its recorded policy after a save; the replacement style keeps its normal policy for new projects. Remove `styleAlias` when deliberately choosing a different style.

## Settings and profile (PROFILE.json, schema 3)

«افتح إعداداتي» or a request to change defaults: open `node scripts/studio.mjs settings` as a long-running command and open its printed local URL. Verify the save with `node scripts/profile.mjs check`. Preserve profiles at session start. Schema 2 is readable without rewriting; screen saves migrate and back up. On a stale save, reload instead of overwriting a newer change.

Each preference independently uses `{"mode":"auto","value":null}` or `{"mode":"fixed","value":"<listed choice>"}`:

| Preference | Fixed choices |
| --- | --- |
| `style` | Any style id in the table in `instructions/STYLES.md` |
| `captionsGrouping` | `compact`, `clauses`, `single` |
| `captionsPresentation` | `pill`, `minimal`, `ink-strip` |
| `captionsSkin` | Optional: `spoken-box`, `karaoke`, `bold-outline`, `soft-shadow`, `paper-tag`. Missing or `auto` uses the basic presentation. A fixed skin overrides its drawing. |
| `font` | `Cairo`, `Tajawal`, `Noto Naskh Arabic`, `Plex Display`, `Grid Sans`, `Noto Kufi Arabic`, `Readex Pro`, `El Messiri`, `Lalezar`, `Aref Ruqaa`, `Aref Ruqaa Ink`, `Reem Kufi`, `Amiri`, `Alexandria`, `Marhey`, `Almarai` |
| `writingStyle` | `short`, `educational`, `storytelling` |
| `digits` | `latin` (1 2 3), `arabic-indic` (١ ٢ ٣). Optional: `auto` or no entry keeps every number as written. |
| `palette` | `brand` (colours on supported styles). With `auto` each style keeps its own colours and the profile's brand colours are not used; set `fixed` `brand` for them to apply. |
| `character` | Optional, for the `cartoon` style: `{"mode":"fixed","value":{...}}` with `skin`, `hair` (`style` `short`, `quiff`, `long` or `none`, `color`), `headwear` (`kind` `none`, `hijab` or `cap`, `color`), `beard` (`kind` `none` or `full`, `color`), `glasses` (`kind` `none` or `rect`, `frame`), `eyes` (`iris`) and `outfit` (`kind` `tee` or `overshirt`, `top`, `base`); colours are `#RRGGBB`. No entry (or `auto`) uses the generic default figure. |

The seven fonts after `El Messiri` (OFL, downloaded by setup like the rest) suit display Arabic: `Lalezar` and `Marhey` are heavy and playful headline faces, `Aref Ruqaa` and `Aref Ruqaa Ink` are Ruq'ah calligraphy for short titles (never body captions), and `Aref Ruqaa Ink` is a colour font that always draws its own red ink with coloured dots: the text, accent and brand colours do not change it, and it reads best on a light background, `Reem Kufi` is a clean Kufi for titles, `Amiri` is a classical Naskh for quotes and long lines, `Alexandria` is a neutral geometric sans for captions and numbers. Before a video uses one, check its files are installed (`node scripts/studio.mjs doctor --quick`); a video that asks for a font that is not installed stops with the setup step that fixes it.

With the style on automatic, the assistant chooses each video's style from the styles' "Best for" lines and fit rules and says why in one line; `editor.mjs recommend` is only a second opinion. Explicit choices win. Style cards are illustrations; font previews use installed fonts and label missing downloads.

The assistant writes `preferences.character` only when the creator asks for their narrator, from the presets the creator picks; it is saved only in `PROFILE.json`, never a photo, and every cartoon video uses it unless a scene sets its own character. See [the cartoon guide](styles/cartoon.md).

**One video only:** keep PROFILE.json. Copy **all fields** printed by `node scripts/profile.mjs brief` into that video's brief. Add explicit `style`, `fontFamily`, `captionsGrouping`, `captionsPresentation`, `captionsSkin`, `writingStyle` or `digits` only for a user-requested override; these win over saved defaults. In an open edit, the editor's «المظهر» tab changes this video's font, caption grouping, shape, skin and digits without touching PROFILE.json. Reset the skin to remove `captions.skin` and use the basic presentation again. The same tab sets a whole-video look (`look` at the manifest root: `riso` with two optional inks, or `blueprint`), which is never a saved preference. Example: saved paper-collage/Tajawal + «الفيديو ده بس خطوات منظمة» → brief `style: "section-deck"`, retain `preferences`, omit `fontFamily` override so Tajawal stays fixed. Explain the chosen style in the preview; don't repeat settled questions.

### Fallback when this host cannot open a browser

Ask, one at a time, and never invent an answer:

1. Name (person or brand).
2. Social handle — optional; `null` if they have none.
3. Follow card at the end? Needs the handle.
4. Default comment keyword for the CTA — optional; they can change it for each video.
5. Their recorded sign-off — the exact words they say at the very end, optional.
6. Brand colours: primary and accent (`#RRGGBB`); background and text are optional (`null` keeps each style's own). Offer the example's colours if they have none.
7. Platforms: Instagram, TikTok and/or YouTube Shorts. Preserve existing selections; do not add a platform the creator did not choose.
8. Each preference above: automatic or fixed from its listed choices. Offer automatic when undecided.

Write it like `PROFILE.example.json` (schema 3, `language` "ar-EG", all six required `preferences`, plus `digits` when the creator chose one) and validate with `node scripts/profile.mjs check`. Relay Arabic errors and fix the answer. A request to change defaults authorizes that change; preserve all other fields. Prefer the screen's backed-up save.
