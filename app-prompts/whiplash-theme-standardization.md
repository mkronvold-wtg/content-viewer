# Prompt: update Whiplash to use mkronvold/themes

Update `mkronvold-wtg/whiplash` to use the shared theme standard from `mkronvold/themes`.

## Goal

Replace Whiplash's local handwritten theme CSS blocks with canonical `--theme-*` variables from `mkronvold/themes/theme.css`. Do not add a separate adapter layer. Update Whiplash's local tokens and selectors so they use the shared standard directly.

## Source of truth

Use these files from `mkronvold/themes`:

- `theme.json` for theme IDs, labels, modes, aliases, and token values.
- `theme.css` for generated CSS variables.

The canonical theme IDs are:

`light`, `sepia`, `spring`, `summer`, `sunshower`, `ocean`, `forest`, `autumn`, `autumn-light`, `coyote`, `coyote-dark`, `guinness`, `night`, `midnight`, `pine`, `obsidian`.

Map old Whiplash themes as follows:

- `dawn` -> `light`
- `linen` -> `sepia`
- `mist` -> `coyote`
- `coyote-dark` -> `coyote-dark`
- `guinness` -> `guinness`
- `midnight` -> `midnight`
- `pine` -> `pine`
- `obsidian` -> `obsidian`
- `sunshower` -> `sunshower`

Retire or manually map old themes not included in the canonical pack: `evening-beach`, `misty`, `thunderstorm`, and `signal`.

## Implementation guidance

1. Import, copy, or vendor `theme.css` from `mkronvold/themes` into the app.
2. Remove old `:root[data-theme='...']` color blocks from `src/index.css`.
3. Replace Whiplash variables with canonical variables:
   - `--app-bg` -> `--theme-bg`
   - `--sidebar-bg` -> `--theme-chrome`
   - `--panel-bg` -> `--theme-surface`
   - `--week-bg` -> `--theme-surface-muted`
   - `--input-bg` -> `--theme-input-bg`
   - `--panel-border` -> `--theme-border`
   - `--text-main` -> `--theme-text`
   - `--text-muted` -> `--theme-muted-text`
   - `--text-link` -> `--theme-link`
   - `--button-primary-bg` -> `--theme-button-primary-bg`
   - `--button-primary-border` -> `--theme-button-primary-border`
   - `--button-primary-text` -> `--theme-button-primary-text`
   - `--overlay-bg` -> `--theme-overlay-bg`
   - `--ring` -> `--theme-focus-ring`
   - `--pill-shadow` -> `--theme-shadow`
4. Update `src/plannerData.ts` and `src/types.ts` to use canonical theme IDs and labels.
5. Preserve environment colors for dev/staging/prod unless a separate shared status-color standard is introduced later.
6. Preserve planner behavior, drag-and-drop behavior, imports/exports, and persisted settings. Add migration for old stored theme IDs if needed.

## Validation

Run existing Whiplash checks:

```sh
npm run lint
npm run build
```

Visually verify `light`, `sunshower`, `coyote`, `coyote-dark`, `guinness`, `midnight`, `pine`, and `obsidian`.
