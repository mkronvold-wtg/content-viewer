import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

process.env.NODE_ENV = "test";

const testRoot = path.join(process.cwd(), ".markdown-callouts-headings-test");
const repositoryPath = path.join(testRoot, "repository");
const execFileAsync = promisify(execFile);
const { startServerForTest } = await import("../server.mjs");

const repository = {
    slug: "content",
    label: "content",
    path: repositoryPath,
    url: "https://github.com/example/content-viewer-fixture.git",
    branch: "main",
    baseDir: "",
    order: 0,
};

const RENDERER_FUNCTIONS = [
    "escapeHtml",
    "inlineMarkdown",
    "autoLinkBareUrls",
    "splitTableRow",
    "isTableRowLine",
    "isTableDividerLine",
    "tableAlignments",
    "normalizeTableCells",
    "renderTableRow",
    "renderTable",
    "renderMarkdownTable",
    "indentWidth",
    "getListItem",
    "renderListBlock",
    "isIndentedCodeLine",
    "stripCodeIndent",
    "getCallout",
    "headingPlainText",
    "headingSlug",
    "uniqueHeadingSlug",
    "renderAdmonition",
    "renderMarkdown",
];

function viewerFunction(viewer, name) {
    const functionStart = viewer.indexOf(`function ${name}(`);
    assert.notEqual(functionStart, -1, `expected ${name} in viewer source`);
    const signatureEnd = viewer.indexOf(")", functionStart);
    const bodyStart = viewer.indexOf("{", signatureEnd);
    let depth = 0;
    for (let index = bodyStart; index < viewer.length; index += 1) {
        if (viewer[index] === "{") {
            depth += 1;
        } else if (viewer[index] === "}" && --depth === 0) {
            return viewer.slice(functionStart, index + 1);
        }
    }
    assert.fail(`could not find the end of ${name}`);
}

function runtimeViewerSource(html) {
    const source = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
        .map((match) => match[1])
        .find((script) => script.includes("function renderMarkdown("));
    assert.ok(source, "expected rendered viewer source");
    return source;
}

function markdownRenderer(viewer) {
    const source = RENDERER_FUNCTIONS.map((name) => viewerFunction(viewer, name)).join("\n");
    const stubs = {
        linkHtml: (label, destination) => `<a href="${destination}">${label}</a>`,
        imageHtml: (src) => `<img src="${src}">`,
        sanitizeHtmlFragment: () => "",
        sanitizeSvgMarkup: () => "",
        // Extracted separately: its regex contains braces the naive extractor cannot count.
        hasHiddenHeadingForToc: (value) => /(?:^|\s)\{[^}]*\.hidden-heading-for-toc[^}]*\}\s*$/.test(String(value || "")),
    };
    const factory = Function(
        ...Object.keys(stubs),
        `let currentDocPath = "";\nlet headingSlugCounts = new Map();\n${source}\n` +
            "return (markdown) => { headingSlugCounts = new Map(); return renderMarkdown(markdown, \"guide.md\"); };",
    );
    return factory(...Object.values(stubs));
}

let server;
let render;

before(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(repositoryPath, { recursive: true });
    await fs.writeFile(path.join(repositoryPath, "guide.md"), "# Guide\n");
    await execFileAsync("git", ["init"], { cwd: repositoryPath, windowsHide: true });
    server = await startServerForTest([repository]);
    const page = await fetch(`${server.url}/content/guide.md`);
    render = markdownRenderer(runtimeViewerSource(await page.text()));
});

after(async () => {
    await server?.close?.();
    await fs.rm(testRoot, { recursive: true, force: true });
});

test("renders Obsidian callouts with a custom title as typed admonitions", () => {
    const html = render("> [!tip] Build to Silver from day one\n> Bronze is the bar to *deploy*.\n> - first\n> - second");

    assert.match(html, /^<div class="admonition admonition-tip"><p class="admonition-title">Build to Silver from day one<\/p>/);
    assert.match(html, /<div class="admonition-content"><p>Bronze is the bar to <em>deploy<\/em>\.<\/p>/);
    assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
    assert.doesNotMatch(html, /\[!tip\]|<blockquote>/);
});

test("renders GitHub alerts with the type as the default title", () => {
    const html = render("> [!WARNING]\n> Mind the gap.");

    assert.match(html, /<div class="admonition admonition-warning"><p class="admonition-title">Warning<\/p>/);
    assert.match(html, /<p>Mind the gap\.<\/p>/);
});

test("renders foldable callouts as details, open only with +", () => {
    assert.match(render("> [!note]- Closed\n> Body"), /^<details class="admonition admonition-note"><summary/);
    assert.match(render("> [!note]+ Open\n> Body"), /^<details class="admonition admonition-note" open><summary/);
    assert.match(render("???+ note \"Open\"\n    Body"), /^<details class="admonition admonition-note" open><summary/);
    assert.match(render("??? note \"Closed\"\n    Body"), /^<details class="admonition admonition-note"><summary/);
});

test("keeps ordinary blockquotes and escapes callout titles", () => {
    assert.match(render("> Just a quote\n> [!tip] not first"), /^<blockquote><p>Just a quote \[!tip\] not first<\/p><\/blockquote>$/);
    assert.match(render("> [!danger] <script>x</script>\n> Body"), /admonition-title">&lt;script&gt;x&lt;\/script&gt;<\/p>/);
});

test("adds GitHub-compatible heading ids", () => {
    const html = render([
        "## 1. Production readiness checklist (TL;DR)",
        "### 11.5 Singletons and leader election",
        "### 🥉 Bronze: required for development",
        "### Use `preStop` & **drain**",
        "## Notes",
        "## Notes",
        "## Notes-1",
        "## 🚀",
    ].join("\n"));

    assert.match(html, /<h2 id="1-production-readiness-checklist-tldr">/);
    assert.match(html, /<h3 id="115-singletons-and-leader-election">/);
    assert.match(html, /<h3 id="-bronze-required-for-development">/);
    assert.match(html, /<h3 id="use-prestop--drain">/);
    assert.match(html, /<h2 id="notes">Notes<\/h2>\n<h2 id="notes-1">Notes<\/h2>\n<h2 id="notes-1-1">Notes-1<\/h2>/);
    assert.match(html, /<h2>🚀<\/h2>/);
});

test("numbers duplicate heading ids across nested renders in one document", () => {
    const html = render("## Summary\n\n> [!info] Aside\n> ## Summary");

    assert.match(html, /<h2 id="summary">/);
    assert.match(html, /<h2 id="summary-1">/);
});
