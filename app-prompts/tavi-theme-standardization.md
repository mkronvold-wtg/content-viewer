# Prompt: update Tavi to use mkronvold/themes

Update `mkronvold/tavi` to use the shared theme standard from `mkronvold/themes`.

## Goal

Replace Tavi's local handwritten theme CSS with canonical `--theme-*` variables from `mkronvold/themes/theme.css`. Do not build an adapter layer. Update Tavi's app CSS and theme metadata so the app speaks the shared token standard directly.

## Source of truth

Use these files from `mkronvold/themes`:

- `theme.json` for theme IDs, labels, modes, aliases, and token values.
- `theme.css` for generated CSS variables.

The canonical theme IDs are:

`light`, `sepia`, `spring`, `summer`, `sunshower`, `ocean`, `forest`, `autumn`, `autumn-light`, `coyote`, `coyote-dark`, `guinness`, `night`, `midnight`, `pine`, `obsidian`.

Preserve `dark` as a legacy alias for `ocean`.

## Implementation guidance

1. Import, copy, or vendor `theme.css` from `mkronvold/themes` into `apps/web`.
2. Remove the local theme blocks from `apps/web/src/index.css`.
3. Replace local app variables with canonical variables wherever practical:
   - app/page background -> `--theme-bg`
   - top/sidebar chrome -> `--theme-chrome`
   - cards/readable panels -> `--theme-surface`
   - muted panels/code/table headers -> `--theme-surface-muted`
   - primary text -> `--theme-text`
   - muted text -> `--theme-muted-text`
   - links -> `--theme-link`
   - borders -> `--theme-border` / `--theme-border-muted`
   - selected item background/border -> `--theme-active-bg` / `--theme-active-border`
   - focus outline -> `--theme-focus-ring`
4. Update the Tavi theme list in `apps/web/src/App.tsx` to use the canonical IDs and labels from `theme.json`.
5. Keep any Tavi-specific layout, markdown rendering, routing, and data behavior unchanged.
6. If Tavi keeps local semantic variables for readability, define them as direct aliases to `--theme-*` in one place; do not keep duplicate color values.

## Validation

Run existing Tavi checks:

```sh
corepack pnpm --filter ./apps/web typecheck
corepack pnpm --filter ./apps/web test
corepack pnpm --filter ./apps/web build
```

Visually verify at least `light`, `spring`, `ocean`, `guinness`, and `obsidian`.
