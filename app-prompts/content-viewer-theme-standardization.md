# Prompt: update content-viewer to use mkronvold/themes

Update `mkronvold-wtg/content-viewer` to use the shared theme standard from `mkronvold/themes`.

## Goal

Replace content-viewer's local handwritten theme tokens with the canonical `--theme-*` CSS variables from `mkronvold/themes/theme.css`. Do not add a separate adapter package or a parallel theme model. Update content-viewer's own CSS to use the shared token names directly.

## Source of truth

Use these files from `mkronvold/themes`:

- `theme.json` for theme IDs, labels, modes, aliases, and token values.
- `theme.css` for generated CSS variables.

The canonical theme IDs are:

`sunshower`, `light`, `sepia`, `summer`, `autumn-light`, `spring`, `coyote`, `autumn`, `coyote-dark`, `pine`, `midnight`, `forest`, `guinness`, `ocean`, `obsidian`.

Preserve `dark` as a legacy alias for `ocean` if existing URLs or local storage may still contain it.

## Implementation guidance

1. Import, copy, or vendor `theme.css` from `mkronvold/themes` into content-viewer.
2. Remove the old per-theme `--dashboard-*` definitions from `server.mjs` and `extension.mjs`.
3. Replace dashboard variables with canonical variables:
   - `--dashboard-bg` -> `--theme-chrome`
   - text rendered on the top/search/list chrome -> `--theme-chrome-text`
   - muted text rendered on the top/search/list chrome -> `--theme-chrome-muted-text`
   - `--dashboard-surface` -> `--theme-surface`
   - `--dashboard-text` -> `--theme-text`
   - `--dashboard-muted` -> `--theme-muted-text`
   - `--dashboard-border` -> `--theme-border`
   - `--dashboard-border-muted` -> `--theme-border-muted`
   - `--dashboard-link` -> `--theme-link`
   - `--dashboard-active-bg` -> `--theme-active-bg`
   - `--dashboard-active-border` -> `--theme-active-border`
   - `--dashboard-code-bg` -> `--theme-surface-muted`
   - `--dashboard-input-bg` -> `--theme-input-bg`
   - `--dashboard-button-bg` -> `--theme-button-bg`
   - `--dashboard-button-hover-bg` -> `--theme-button-hover-bg`
   - `--dashboard-mark-bg` -> `--theme-mark-bg`
   - `--dashboard-mark-text` -> `--theme-mark-text`
4. Update the theme picker to expose every canonical theme label.
5. Keep presentation mode behavior intact; its top band should use `--theme-chrome` and reading panel should use `--theme-surface`.
6. Keep `server.mjs`, committed `extension.mjs`, and the live session extension in parity if working in an active sidebar session.

## Validation

Run the existing checks:

```sh
npm run check
```

If the sidebar canvas is active, reload the extension and visually verify at least `light`, `ocean`, `coyote-dark`, and `obsidian`.
