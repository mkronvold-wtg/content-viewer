# Prompt: update Revu to use mkronvold/themes

Update `mkronvold/revu` to use the shared theme standard from `mkronvold/themes`.

## Goal

Move Revu away from its app-specific `ThemePalette` color constants and generated runtime theme CSS, and toward the canonical `--theme-*` variables from `mkronvold/themes/theme.css`. Do not make other apps adapt to Revu's TypeScript palette model. Revu should consume the shared CSS variables directly and keep TypeScript only for theme selection metadata or app logic that cannot be represented in CSS.

## Source of truth

Use these files from `mkronvold/themes`:

- `theme.json` for theme IDs, labels, modes, aliases, and token values.
- `theme.css` for generated CSS variables.

The canonical theme IDs are:

`light`, `sepia`, `spring`, `summer`, `sunshower`, `ocean`, `forest`, `autumn`, `autumn-light`, `coyote`, `coyote-dark`, `guinness`, `night`, `midnight`, `pine`, `obsidian`.

Map old Revu themes as follows:

- `summer-nights` -> `coyote`
- `winter-nights` -> `midnight`
- `autumn` -> `autumn-light`

`midnight` should use Whiplash Midnight Blue's flat tokens, not Revu's gradients.

## Implementation guidance

1. Import, copy, or vendor `theme.css` from `mkronvold/themes` into `apps/web`.
2. Update `apps/web/src/theme.ts` so it no longer owns color values for each theme.
3. Keep or replace `themePreferences` with the canonical theme IDs and labels from `theme.json`.
4. Replace Revu palette fields with CSS variables:
   - `appBackground` / `loginBackground` -> `--theme-bg`
   - `sidebarBackground` -> `--theme-chrome`
   - `surfaceBackground` / `modalSurfaceBackground` -> `--theme-surface` / `--theme-modal-surface-bg`
   - `surfaceText` / `appText` -> `--theme-text`
   - `mutedText` -> `--theme-muted-text`
   - `surfaceBorder` / nav borders -> `--theme-border`, `--theme-border-muted`, `--theme-active-border`
   - `inputBackground` -> `--theme-input-bg`
   - `primaryButtonStart` / `primaryButtonEnd` -> use flat `--theme-button-primary-bg`
   - `successText` / `successBackground` -> `--theme-success-text` / `--theme-success-bg`
   - `errorText` / `errorBackground` -> `--theme-error-text` / `--theme-error-bg`
   - `warningText` / `warningBackground` / `warningBorder` -> `--theme-warning-text` / `--theme-warning-bg` / `--theme-warning-border`
   - `noteText` / `noteBackground` / `sidebarNoteBackground` -> `--theme-note-text` / `--theme-note-bg` / `--theme-sidebar-note-bg`
   - `badgeText` / `badgeBackground` -> `--theme-badge-text` / `--theme-badge-bg`
   - `pillText` / `pillBackground` -> `--theme-pill-text` / `--theme-pill-bg`
   - `modalBackdrop` -> `--theme-modal-backdrop`
5. Preserve all Revu UI behavior, forms, review flows, status pills, warning banners, notes, badges, pills, and modal behavior.
6. Remove gradient-only assumptions from button and page backgrounds unless they are purely decorative and use no theme-specific color literals.

## Validation

Run existing Revu checks:

```sh
npm run typecheck
npm test
npm run build
```

Visually verify warning banners, form errors, success/status pills, toolbar notes, sidebar notes, badges, pills, modals, and active nav state in `light`, `summer`, `autumn-light`, `midnight`, and `obsidian`.
