import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

process.env.NODE_ENV = "test";

const testRoot = path.join(process.cwd(), ".csv-index-shared-tables-test");
const repositoryPath = path.join(testRoot, "repository");
const csvContent = '\uFEFFName,Comment,Empty\r\nAlice,"Hello, ""world""",\r\nBob,"embedded\r\nnewline",<img src=x onerror=alert(1)>\r\n';
const execFileAsync = promisify(execFile);
const { startServerForTest } = await import("../server.mjs");

function repository(baseDir = "docs") {
    return {
        slug: "content",
        label: "content",
        path: repositoryPath,
        url: "https://github.com/example/content-viewer-fixture.git",
        branch: "main",
        baseDir,
        order: 0,
    };
}

async function api(server, pathname) {
    const response = await fetch(`${server.url}${pathname}`);
    return { response, body: await response.json() };
}

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
        .find((script) => script.includes("function parseCsv("));
    assert.ok(source, "expected rendered viewer source");
    return source;
}

function csvRenderer(viewer) {
    const source = ["escapeHtml", "normalizeTableCells", "renderTableRow", "tableCopyButton", "renderTable", "parseCsv", "renderCsvTable"]
        .map((name) => viewerFunction(viewer, name))
        .join("\n");
    return Function(`${source}\nreturn { parseCsv, renderCsvTable };`)();
}

function markdownTableRenderer(viewer) {
    const source = ["splitTableRow", "tableAlignments", "normalizeTableCells", "renderTableRow", "tableCopyButton", "renderTable", "renderMarkdownTable"]
        .map((name) => viewerFunction(viewer, name))
        .join("\n");
    const inlineMarkdown = (value) => String(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return Function("inlineMarkdown", `${source}\nreturn renderMarkdownTable;`)(inlineMarkdown);
}

function sharedSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `missing ${startMarker}`);
    assert.notEqual(end, -1, `missing ${endMarker}`);
    return source.slice(start, end);
}

before(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(repositoryPath, "docs"), { recursive: true });
    await fs.mkdir(path.join(repositoryPath, "outside"), { recursive: true });
    await fs.writeFile(path.join(repositoryPath, "docs", "guide.md"), "# Guide\n\nMarkdown-only needle\n");
    await fs.writeFile(path.join(repositoryPath, "docs", "report.csv"), csvContent);
    await fs.writeFile(path.join(repositoryPath, "outside", "hidden.csv"), "Name,Secret\nHidden,outside-root\n");
    await fs.writeFile(path.join(repositoryPath, "docs", "ignored.txt"), "not indexed\n");
    await execFileAsync("git", ["init"], { cwd: repositoryPath, windowsHide: true });
});

after(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

test("indexes CSV raw cell text and returns document format metadata", async () => {
    const server = await startServerForTest([repository()]);
    try {
        const allDocuments = await api(server, "/api/search?repo=content");
        assert.equal(allDocuments.response.status, 200);
        assert.equal(allDocuments.body.total, 2);
        assert.deepEqual(
            allDocuments.body.results.map((result) => [result.path, result.format]).sort((left, right) => left[0].localeCompare(right[0])),
            [["guide.md", "markdown"], ["report.csv", "csv"]],
        );

        const csvSearch = await api(server, "/api/search?repo=content&q=embedded");
        assert.equal(csvSearch.response.status, 200);
        assert.deepEqual(csvSearch.body.results.map((result) => result.path), ["report.csv"]);

        const csvDocument = await api(server, "/api/doc?repo=content&path=report.csv");
        assert.equal(csvDocument.response.status, 200);
        assert.equal(csvDocument.body.format, "csv");
        assert.equal(csvDocument.body.path, "report.csv");
        assert.equal(csvDocument.body.sourcePath, "docs/report.csv");
        assert.equal(csvDocument.body.sourceUrl, "https://github.com/example/content-viewer-fixture/blob/main/docs/report.csv");
        assert.equal(csvDocument.body.content, csvContent);

        const markdownDocument = await api(server, "/api/doc?repo=content&path=guide.md");
        assert.equal(markdownDocument.response.status, 200);
        assert.equal(markdownDocument.body.format, "markdown");
        assert.equal(markdownDocument.body.title, "Guide");
    } finally {
        await server.close();
    }
});

test("keeps CSV direct routes and source identity within BASE_DIR", async () => {
    const server = await startServerForTest([repository()]);
    try {
        const directRoute = await fetch(`${server.url}/content/report.csv?present=1`);
        assert.equal(directRoute.status, 200);
        const html = await directRoute.text();
        assert.match(html, /const initialDocPath = "report\.csv";/);

        const sourcePathRequest = await api(server, "/api/doc?repo=content&path=docs%2Freport.csv");
        assert.equal(sourcePathRequest.response.status, 404);
        const traversal = await fetch(`${server.url}/content/%2E%2E%2Foutside%2Fhidden.csv`);
        assert.equal(traversal.status, 404);
    } finally {
        await server.close();
    }
});

test("renders RFC 4180 CSV cells as escaped plain-text tables", async () => {
    const server = await startServerForTest([repository()]);
    try {
        const route = await fetch(`${server.url}/content/report.csv`);
        const viewer = runtimeViewerSource(await route.text());
        const { parseCsv, renderCsvTable } = csvRenderer(viewer);

        assert.deepEqual(
            parseCsv(csvContent),
            [
                ["Name", "Comment", "Empty"],
                ["Alice", 'Hello, "world"', ""],
                ["Bob", "embedded\r\nnewline", "<img src=x onerror=alert(1)>"],
            ],
        );
        assert.deepEqual(parseCsv("A,B\n1,\n"), [["A", "B"], ["1", ""]]);

        const html = renderCsvTable(csvContent);
        assert.match(html, /^<div class="table-wrapper"><button class="table-copy-button"/);
        assert.match(html, /data-copy-table title="Copy table as CSV" aria-label="Copy table as CSV"/);
        assert.match(html, /<table><thead>/);
        assert.match(html, /<th>Name<\/th>/);
        assert.match(html, /Hello, &quot;world&quot;/);
        assert.match(html, /embedded\r\nnewline/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.doesNotMatch(html, /<img src=x/);
        assert.doesNotMatch(renderCsvTable("Cell\n**not markdown**\n"), /<strong>/);
        assert.match(renderCsvTable("Only header\n"), /<th>Only header<\/th><\/tr><\/thead><tbody><\/tbody>/);
        assert.equal(renderCsvTable(""), '<div class="empty">This CSV has no records.</div>');
        assert.throws(
            () => renderCsvTable('Name,Comment\nAlice,"unclosed'),
            /CSV rendering error: CSV parse error: unclosed quoted field/,
        );
        assert.match(viewer, /docContent\.textContent = error\.message/);
    } finally {
        await server.close();
    }
});

test("preserves Markdown table rendering through the shared table wrapper", async () => {
    const server = await startServerForTest([repository()]);
    try {
        const route = await fetch(`${server.url}/content/guide.md`);
        const renderMarkdownTable = markdownTableRenderer(runtimeViewerSource(await route.text()));
        const html = renderMarkdownTable("| Name | Value |\n", "| --- | ---: |\n", ["| **Bold** | 42 | surplus |"]);
        assert.match(html, /^<div class="table-wrapper"><button class="table-copy-button"/);
        assert.match(html, /<table><thead>/);
        assert.match(html, /<th>Name<\/th>/);
        assert.match(html, /<strong>Bold<\/strong>/);
        assert.match(html, /style="text-align:right">42<\/td>/);
        assert.doesNotMatch(html, /surplus/);
    } finally {
        await server.close();
    }
});

test("keeps standalone and canvas CSV implementations aligned", async () => {
    const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
    const extensionPath = fileURLToPath(new URL("../extension.mjs", import.meta.url));
    const [serverSource, extensionSource] = await Promise.all([
        fs.readFile(serverPath, "utf8"),
        fs.readFile(extensionPath, "utf8"),
    ]);

    assert.equal(
        sharedSection(serverSource, "function documentFormat(filePath) {", "async function ensureIndex(state) {"),
        sharedSection(extensionSource, "function documentFormat(filePath) {", "async function ensureIndex(state) {"),
    );
    assert.equal(
        sharedSection(serverSource, "function renderTableRow(cells, cellTag, alignments, renderCell) {", "function indentWidth(value) {"),
        sharedSection(extensionSource, "function renderTableRow(cells, cellTag, alignments, renderCell) {", "function indentWidth(value) {"),
    );
});
