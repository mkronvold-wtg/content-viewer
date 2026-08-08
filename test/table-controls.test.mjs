import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
const extensionPath = fileURLToPath(new URL("../extension.mjs", import.meta.url));

function viewerSource(source) {
  const match = source.match(/function renderHtml\(appState, initialView = \{\}\) \{[\s\S]*?(?=\nasync function handleRequest)/);
  assert.ok(match, "expected an embedded viewer source");
  return match[0];
}

function viewerFunction(viewer, name) {
  const functionIndex = viewer.indexOf(`function ${name}(`);
  assert.notEqual(functionIndex, -1, `expected ${name} in viewer source`);
  const functionStart = viewer.slice(Math.max(0, functionIndex - 6), functionIndex) === "async "
    ? functionIndex - 6
    : functionIndex;
  const signatureStart = viewer.indexOf("(", functionIndex);
  let parentheses = 0;
  let signatureEnd = -1;
  for (let index = signatureStart; index < viewer.length; index += 1) {
    if (viewer[index] === "(") {
      parentheses += 1;
    } else if (viewer[index] === ")" && --parentheses === 0) {
      signatureEnd = index;
      break;
    }
  }
  assert.notEqual(signatureEnd, -1, `could not find the signature end of ${name}`);
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

async function mirroredViewer() {
  const [serverSource, extensionSource] = await Promise.all([
    fs.readFile(serverPath, "utf8"),
    fs.readFile(extensionPath, "utf8"),
  ]);
  const serverViewer = viewerSource(serverSource);
  assert.equal(serverViewer, viewerSource(extensionSource), "standalone and canvas viewer sources must stay in parity");
  return serverViewer;
}

function tableRenderers(viewer) {
  const source = [
    "escapeHtml",
    "splitTableRow",
    "tableAlignments",
    "normalizeTableCells",
    "renderTableRow",
    "tableCopyButton",
    "renderTable",
    "renderMarkdownTable",
    "parseCsv",
    "renderCsvTable",
  ].map((name) => viewerFunction(viewer, name)).join("\n");
  const inlineMarkdown = (value) => String(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return Function(
    "inlineMarkdown",
    `${source.replaceAll("\\\\", "\\")}\nreturn { renderMarkdownTable, renderCsvTable };`,
  )(inlineMarkdown);
}

function tableCsvActions(viewer, navigator, document) {
  const source = [
    "escapeCsvField",
    "tableToCsv",
    "writeClipboardText",
    "copyTableAsCsv",
  ].map((name) => viewerFunction(viewer, name)).join("\n");
  const statusElement = { textContent: "" };
  const actions = Function(
    "navigator",
    "document",
    "statusElement",
    `${source}\nreturn { tableToCsv, copyTableAsCsv, writeClipboardText };`,
  )(navigator, document, statusElement);
  return { ...actions, statusElement };
}

function visualTable(rows) {
  return {
    rows: rows.map((cells) => ({
      cells: cells.map((innerText) => ({ innerText, textContent: "<markup>" })),
    })),
  };
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function renderedCsvTable(html, visualRows) {
  const csvModel = html.match(/<table data-csv-model="([^"]+)"/)?.[1];
  assert.ok(csvModel, "expected a safely encoded CSV table model");
  return {
    ...visualTable(visualRows),
    getAttribute(name) {
      return name === "data-csv-model" ? decodeHtmlAttribute(csvModel) : null;
    },
  };
}

test("keeps the 90 percent reader contract and intrinsic table layout in mirrored sources", async () => {
  const viewer = await mirroredViewer();

  assert.match(viewer, /\.markdown \{\s+width: 90%;\s+max-width: none;\s+margin: 0 auto;/);
  assert.match(viewer, /body\.presenting \.markdown \{\s+width: 90%;\s+max-width: none;\s+margin: 0 auto;/);
  assert.match(
    viewer,
    /@media \(max-width: 760px\) \{[\s\S]*?\.markdown,\s+body\.presenting \.markdown \{\s+width: 100%;\s+\}/,
  );
  assert.match(
    viewer,
    /\.markdown \.table-wrapper \{\s+width: max-content;\s+max-width: 100%;\s+border: 1px solid var\(--theme-border\);/,
  );
  assert.match(viewer, /\.markdown \.table-actions \{\s+display: flex;\s+justify-content: flex-end;\s+padding: 6px 6px 0;/);
  assert.match(viewer, /\.markdown \.table-scroll \{\s+width: max-content;\s+max-width: 100%;\s+overflow-x: auto;\s+overflow-y: hidden;/);
  assert.match(
    viewer,
    /\.markdown table \{\s+width: max-content;\s+min-width: 100%;\s+table-layout: auto;/,
  );
  assert.doesNotMatch(viewer, /\.markdown \.table-copy-button \{\s+position: absolute;/);
  assert.doesNotMatch(viewer, /\.markdown table \{\s+width: 100%;\s+table-layout: fixed;/);
});

test("renders Markdown and CSV tables through the same copy-button wrapper", async () => {
  const viewer = await mirroredViewer();
  const { renderMarkdownTable, renderCsvTable } = tableRenderers(viewer);
  const markdown = renderMarkdownTable("| Name | Value |\n", "| --- | --- |\n", ["| **Bold** | 42 |"]);
  const csv = renderCsvTable("Name,Value\r\nPlain,42\r\n");

  for (const html of [markdown, csv]) {
    assert.match(html, /^<div class="table-wrapper"><div class="table-actions"><button class="table-copy-button"/);
    assert.match(html, /data-copy-table title="Copy table as CSV" aria-label="Copy table as CSV"/);
    assert.match(html, /<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">/);
    assert.match(html, /<\/button><\/div><div class="table-scroll"><table(?: data-csv-model="[^"]+")?><thead>/);
    assert.equal((html.match(/data-copy-table/g) ?? []).length, 1);
  }
  assert.match(markdown, /<strong>Bold<\/strong>/);
  assert.doesNotMatch(markdown, /data-csv-model=/);
  assert.match(csv, /<td>Plain<\/td>/);
  assert.match(csv, /data-csv-model=/);
});

test("serializes Markdown tables from their visual text as RFC 4180 CSV", async () => {
  const viewer = await mirroredViewer();
  const { tableToCsv } = tableCsvActions(viewer, {}, {});
  const table = visualTable([
    ["Header", "Quote", "Comma", "LF", "CRLF", "Blank"],
    ["Visible text", 'say "hi"', "a,b", "one\ntwo", "one\r\ntwo", ""],
  ]);

  assert.equal(
    tableToCsv(table),
    'Header,Quote,Comma,LF,CRLF,Blank\r\nVisible text,"say ""hi""","a,b","one\ntwo","one\r\ntwo",',
  );
});

test("preserves parser CSV values across real rendered multiline cells", async () => {
  const viewer = await mirroredViewer();
  const { renderCsvTable } = tableRenderers(viewer);
  const { tableToCsv } = tableCsvActions(viewer, {}, {});
  const source = 'Name,Comment,Empty,Unicode\r\nMiyuki,"first line\r\nsecond line",,こんにちは\r\n';
  const html = renderCsvTable(source);
  const table = renderedCsvTable(html, [
    ["Name", "Comment", "Empty", "Unicode"],
    ["Miyuki", "first line second line", "", "こんにちは"],
  ]);

  assert.equal(
    tableToCsv(table),
    'Name,Comment,Empty,Unicode\r\nMiyuki,"first line\r\nsecond line",,こんにちは',
  );
});

test("reports truthful table clipboard success and failure states", async () => {
  const viewer = await mirroredViewer();
  const table = visualTable([["Name"], ["Ada"]]);
  const wrapper = { querySelector: (selector) => selector === "table" ? table : null };
  const copied = [];
  const success = tableCsvActions(
    viewer,
    { clipboard: { writeText: async (text) => copied.push(text) } },
    {},
  );
  await success.copyTableAsCsv(wrapper);
  assert.deepEqual(copied, ["Name\r\nAda"]);
  assert.equal(success.statusElement.textContent, "Copied table as CSV.");

  let fallbackAttempted = false;
  const denied = tableCsvActions(
    viewer,
    {},
    {
      createElement() {
        return {
          style: {},
          select() {},
          remove() {},
        };
      },
      body: {
        appendChild() {
          fallbackAttempted = true;
        },
      },
      execCommand() {
        return false;
      },
    },
  );
  await denied.copyTableAsCsv(wrapper);
  assert.equal(fallbackAttempted, true);
  assert.equal(denied.statusElement.textContent, "Copy failed. Table CSV could not be copied.");

  const malformedTable = {
    ...visualTable([["Name"], ["Ada"]]),
    getAttribute: () => "not JSON",
  };
  const malformedWrapper = { querySelector: (selector) => selector === "table" ? malformedTable : null };
  await success.copyTableAsCsv(malformedWrapper);
  assert.deepEqual(copied, ["Name\r\nAda"]);
  assert.equal(success.statusElement.textContent, "Copy failed. Table CSV could not be copied.");
});

test("delegates each table-copy click through the single document container listener", async () => {
  const viewer = await mirroredViewer();
  const source = viewerFunction(viewer, "handleDocumentContentClick");
  const handleDocumentContentClick = Function(`${source}\nreturn handleDocumentContentClick;`)();
  const wrapper = {};
  const button = {
    closest(selector) {
      return selector === "[data-copy-table]" ? this : selector === ".table-wrapper" ? wrapper : null;
    },
  };
  const container = { contains: (node) => node === button };
  let prevented = false;
  let copies = 0;
  let opens = 0;

  await handleDocumentContentClick(
    { target: button, preventDefault: () => { prevented = true; } },
    container,
    async (receivedWrapper) => {
      copies += 1;
      assert.equal(receivedWrapper, wrapper);
    },
    async () => {
      opens += 1;
    },
  );

  assert.equal(prevented, true);
  assert.equal(copies, 1);
  assert.equal(opens, 0);

  const headerLink = {
    closest(selector) {
      return selector === "a[data-doc-link]" ? this : null;
    },
    getAttribute(name) {
      return name === "data-doc-link" ? "linked-document.md" : "";
    },
  };
  await handleDocumentContentClick(
    { target: headerLink, preventDefault: () => { prevented = true; } },
    { contains: () => true },
    async () => {
      copies += 1;
    },
    async (path) => {
      opens += 1;
      assert.equal(path, "linked-document.md");
    },
  );

  assert.equal(copies, 1);
  assert.equal(opens, 1);
  assert.equal((viewer.match(/docContent\.addEventListener\("click"/g) ?? []).length, 1);
  assert.doesNotMatch(viewerFunction(viewer, "renderTable"), /addEventListener/);
});
