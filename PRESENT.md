# Presentation mode implementation prompt

Use this as a copy/paste prompt when adding presentation mode to another Markdown or document viewer.

````text
Add a presentation mode to this app's document viewer.

Goal:
Turn the existing document reading experience into a lightweight slide/presentation experience without creating a separate presentation file format. The same Markdown/document content should render normally in reading mode and as paginated slides in presentation mode.

Functional requirements:
1. Add a visible "Present" control near the document viewer. When clicked, it enters presentation mode. In presentation mode the same control should read "Exit" and leave presentation mode when clicked again.
2. Hide non-presentation chrome while presenting, including search UI, result lists, document metadata/toolbars, tags, filters, and other navigation panels. Keep only the rendered document and subtle presentation controls visible.
3. Add pagination controls that are only visible in presentation mode:
   - Previous page button.
   - Page indicator such as "1 / 7".
   - Next page button.
   - Pagination mode selector.
4. Support these pagination modes:
   - Heading levels 1 through 6, where a new slide starts at a Markdown heading matching the selected level.
   - Horizontal-rule slides using a line that is exactly `---`, allowing optional surrounding whitespace.
5. When the user enters presentation mode, default the pagination mode selector to `---`.
6. Reset to the first slide when:
   - Entering presentation mode.
   - Changing pagination mode.
   - Opening a different document.
7. Clamp the current slide index after every re-render so it is always in range.
8. Disable Previous on the first slide and Next on the last slide.
9. Strip YAML frontmatter before slide splitting so frontmatter delimited by `---` does not become an empty first slide.
10. Preserve the app's existing Markdown rendering features on each slide, including images, tables, links, code blocks, diagrams, and any existing post-render steps.
11. Preserve normal reading mode behavior. Outside presentation mode, render the full document as one continuous document.
12. Add keyboard shortcuts while presenting:
    - ArrowRight, PageDown, Space: next slide.
    - ArrowLeft, PageUp: previous slide.
    - Home: first slide.
    - End: last slide.
    - Escape: exit presentation mode.
    Do not hijack these keys while the focused element is an input, textarea, select, button, or contenteditable element, except Escape may exit presentation mode.
13. Keep controls accessible:
    - The Present button must use `aria-pressed`.
    - The controls container should have `aria-label="Presentation controls"`.
    - The pagination selector should have a clear label.
    - Buttons must be real `<button>` elements, not clickable divs.
14. Make presentation layout responsive:
    - Use the full viewport height.
    - Center the rendered slide content.
    - Use generous side padding, e.g. `clamp(24px, 7vw, 96px)`.
    - Limit readable width, e.g. `max-width: 1100px`.
    - Keep top padding tight, e.g. `8px`, so the primary heading or title starts in the same vertical band as the overlay controls.
    - Remove the top margin from the first rendered Markdown block while presenting.
15. Make the controls subtle but discoverable:
    - Fixed position in the top-right corner.
    - Low opacity by default.
    - Full opacity on hover or focus-within.
    - Use app theme tokens or existing theme variables for colors.

Implementation guidance:

Add state near the existing document-viewer state:

```js
let currentDocument = null;
let isPresenting = false;
let paginationMode = "---";
let currentPages = [{ title: "Document", content: "" }];
let currentPageIndex = 0;
```

Use the app's actual state management style if it is React, Vue, Svelte, or another framework. The behavior above matters more than these exact variable names.

Add a frontmatter stripper:

```js
function stripFrontmatter(markdown) {
  return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}
```

Add slide splitting:

```js
function getDocumentPages(markdown, mode) {
  const content = stripFrontmatter(markdown);

  if (mode === "---") {
    const pages = content
      .split(/^\s*---\s*$/m)
      .map((page, index) => ({
        title: "Slide " + (index + 1),
        content: page.trim(),
      }))
      .filter((page) => page.content.length > 0);

    return pages.length ? pages : [{ title: "Whole document", content }];
  }

  const level = Number(mode);
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    return [{ title: "Whole document", content }];
  }

  const lines = content.split(/\r?\n/);
  const headingPattern = new RegExp("^#{" + level + "}\\s+(.+)$");
  const pages = [];
  let currentLines = [];
  let currentTitle = "Introduction";

  for (const line of lines) {
    const heading = line.match(headingPattern);
    const currentHasContent = currentLines.some((candidate) => candidate.trim());

    if (heading && currentHasContent) {
      pages.push({ title: currentTitle, content: currentLines.join("\n").trim() });
      currentLines = [line];
      currentTitle = heading[1].trim();
      continue;
    }

    if (heading && !currentHasContent) {
      currentTitle = heading[1].trim();
    }

    currentLines.push(line);
  }

  if (currentLines.some((candidate) => candidate.trim())) {
    pages.push({ title: currentTitle, content: currentLines.join("\n").trim() });
  }

  return pages.length ? pages : [{ title: "Whole document", content }];
}
```

Render with a single function that handles both modes:

```js
async function renderCurrentDocument() {
  if (!currentDocument) {
    currentPages = [{ title: "Document", content: "" }];
    currentPageIndex = 0;
    updatePresentationControls();
    return;
  }

  const markdown = stripFrontmatter(currentDocument.content);

  if (isPresenting) {
    currentPages = getDocumentPages(markdown, paginationMode);
    currentPageIndex = Math.min(Math.max(currentPageIndex, 0), currentPages.length - 1);
    renderMarkdownIntoViewer(currentPages[currentPageIndex].content, currentDocument);
  } else {
    currentPages = [{ title: currentDocument.title || "Document", content: markdown }];
    currentPageIndex = 0;
    renderMarkdownIntoViewer(markdown, currentDocument);
  }

  await runExistingPostRenderSteps();
  updatePresentationControls();
}
```

Replace `renderMarkdownIntoViewer` and `runExistingPostRenderSteps` with the app's existing rendering and post-render hooks. For example, keep Mermaid rendering, syntax highlighting, image hydration, link handling, or math rendering exactly as the app already does.

Add control behavior:

```js
function enterPresentationMode() {
  isPresenting = true;
  paginationMode = "---";
  currentPageIndex = 0;
  document.body.classList.add("presenting");
  renderCurrentDocument();
}

function exitPresentationMode() {
  isPresenting = false;
  currentPageIndex = 0;
  document.body.classList.remove("presenting");
  renderCurrentDocument();
}

function togglePresentationMode() {
  if (isPresenting) {
    exitPresentationMode();
  } else {
    enterPresentationMode();
  }
}

function goToPreviousSlide() {
  if (!isPresenting) return;
  currentPageIndex = Math.max(0, currentPageIndex - 1);
  renderCurrentDocument();
}

function goToNextSlide() {
  if (!isPresenting) return;
  currentPageIndex = Math.min(currentPages.length - 1, currentPageIndex + 1);
  renderCurrentDocument();
}

function updatePresentationControls() {
  presentToggle.textContent = isPresenting ? "Exit" : "Present";
  presentToggle.setAttribute("aria-pressed", String(isPresenting));
  pageIndicator.textContent = (currentPageIndex + 1) + " / " + currentPages.length;
  prevPage.disabled = currentPageIndex <= 0;
  nextPage.disabled = currentPageIndex >= currentPages.length - 1;
}
```

Add keyboard handling:

```js
function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, button, [contenteditable='true']"));
}

document.addEventListener("keydown", (event) => {
  if (!isPresenting) return;

  if (event.key === "Escape") {
    event.preventDefault();
    exitPresentationMode();
    return;
  }

  if (isEditableTarget(event.target)) {
    return;
  }

  if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
    event.preventDefault();
    goToNextSlide();
  } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
    event.preventDefault();
    goToPreviousSlide();
  } else if (event.key === "Home") {
    event.preventDefault();
    currentPageIndex = 0;
    renderCurrentDocument();
  } else if (event.key === "End") {
    event.preventDefault();
    currentPageIndex = currentPages.length - 1;
    renderCurrentDocument();
  }
});
```

Suggested HTML shape for a plain JavaScript app:

```html
<div class="present-controls" aria-label="Presentation controls">
  <button id="present-toggle" type="button" aria-pressed="false" title="Toggle present mode">Present</button>
  <select id="pagination-mode" title="Paginate by heading level or horizontal rule" aria-label="Paginate by heading level or horizontal rule">
    <option value="1">H1</option>
    <option value="2">H2</option>
    <option value="3">H3</option>
    <option value="4">H4</option>
    <option value="5">H5</option>
    <option value="6">H6</option>
    <option value="---">---</option>
  </select>
  <span class="page-controls">
    <button id="prev-page" type="button" title="Previous slide">Prev</button>
    <span id="page-indicator" class="page-indicator">1 / 1</span>
    <button id="next-page" type="button" title="Next slide">Next</button>
  </span>
</div>
```

Suggested CSS:

```css
.present-controls {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.38;
  transition: opacity 120ms ease;
}

.present-controls:hover,
.present-controls:focus-within {
  opacity: 1;
}

.present-controls button,
.present-controls select {
  padding: 5px 7px;
  border: 1px solid var(--border-color-default, #d0d7de);
  border-radius: 999px;
  background: color-mix(in srgb, var(--background-color-default, #ffffff) 88%, transparent);
  color: var(--text-color-muted, #57606a);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  backdrop-filter: blur(8px);
}

.present-controls select,
.present-controls .page-controls {
  display: none;
}

.page-controls {
  align-items: center;
  gap: 4px;
}

.page-indicator {
  min-width: 56px;
  color: var(--text-color-muted, #57606a);
  font-size: 12px;
  text-align: center;
}

body.presenting .app-header,
body.presenting .search-panel,
body.presenting .results-panel,
body.presenting .document-toolbar,
body.presenting .document-metadata {
  display: none;
}

body.presenting .document-shell {
  display: block;
  min-height: 100vh;
}

body.presenting .document-viewer {
  max-height: none;
  min-height: 100vh;
  padding: 8px clamp(24px, 7vw, 96px) 64px;
}

body.presenting .markdown,
body.presenting .rendered-document {
  max-width: 1100px;
  margin: 0 auto;
}

body.presenting .markdown > :first-child,
body.presenting .rendered-document > :first-child {
  margin-top: 0;
}

body.presenting .present-controls select,
body.presenting .present-controls .page-controls {
  display: flex;
}
```

Rename the CSS selectors to match the target app. Do not rely on the exact class names above unless they already exist.

The presentation top spacing is intentionally small. Avoid large top padding such as `44px` unless the app has a fixed header that remains visible in presentation mode. The expected visual result is that the slide's primary heading/title appears inline with the top-right overlay controls, not below them.

Validation requirements:
1. Open a normal document and confirm reading mode still shows the full document.
2. Enter presentation mode and confirm search/results/toolbars are hidden.
3. Confirm entering presentation mode defaults pagination to `---`.
4. Confirm `---` pagination ignores YAML frontmatter and does not create an empty first slide.
5. Confirm heading-level pagination works for H1 through H6.
6. Confirm Previous/Next buttons and keyboard shortcuts move slides and clamp at the ends.
7. Confirm Escape exits presentation mode.
8. Confirm opening another document resets to slide 1.
9. Confirm existing Markdown features still render on slides, especially images, tables, relative links, code blocks, and diagrams.
10. Confirm light and dark themes keep controls and slide text readable.
11. Confirm the first slide heading/title is vertically aligned with the overlay controls and there is no large empty band above the slide content.

Do not add a separate presentation file format. Reuse the existing Markdown/document renderer and keep presentation mode as a view state over the current document.
````
