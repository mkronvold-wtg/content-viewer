import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

process.env.NODE_ENV = "test";
process.env.CONTENT_VIEWER_TEST_ALLOW_LOCAL_GIT = "1";

const execFileAsync = promisify(execFile);
const testRoot = path.join(process.cwd(), ".browser-state-test");
const remotePath = path.join(testRoot, "remote.git");
const seedPath = path.join(testRoot, "seed");
const activePath = path.join(testRoot, "active");
const remoteUrl = pathToFileURL(remotePath).href;
const { startServerForTest } = await import("../server.mjs");

async function git(args, cwd) {
    await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function pageHtml(server, suffix) {
    const response = await fetch(`${server.url}/content/guide.md${suffix}`);
    assert.equal(response.status, 200);
    return response.text();
}

function viewerSource(source) {
    const match = source.match(/function renderHtml\(appState, initialView = \{\}\) \{[\s\S]*?(?=\nasync function handleRequest)/);
    assert.ok(match, "expected an embedded viewer source");
    return match[0];
}

function viewerFunction(viewer, name) {
    const functionStart = viewer.indexOf(`function ${name}(`);
    assert.notEqual(functionStart, -1, `expected ${name} in viewer source`);
    const bodyStart = viewer.indexOf("{", functionStart);
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

function evaluateNavigationUrlFunctions(viewer, href) {
    const source = ["repoPathPrefix", "encodeDocumentPath", "documentUrl", "documentNavigationUrl", "updatePresentationUrl"]
        .map((name) => viewerFunction(viewer, name))
        .join("\n");
    const updates = [];
    const window = {
        location: { href, origin: new URL(href).origin },
        history: {
            replaceState(...args) {
                updates.push(args);
            },
        },
    };
    const functions = Function("window", "activeRepo", "activePath", `${source}\nreturn { documentUrl, documentNavigationUrl, updatePresentationUrl };`)(
        window,
        "content",
        "next guide.md",
    );
    return { ...functions, updates, window };
}

function resolveDocumentLinkPath(viewer, repos, currentDocPath, destination) {
    const source = ["normalizeRelativePath", "resolveDocumentLinkPath"]
        .map((name) => viewerFunction(viewer, name))
        .join("\n");
    return Function("repos", "activeRepo", "currentDocPath", "destination", `${source}\nreturn resolveDocumentLinkPath(destination);`)(
        repos,
        "content",
        currentDocPath,
        destination,
    );
}

test("maps source-root document links into BASE_DIR display paths", async () => {
    const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
    const extensionPath = fileURLToPath(new URL("../extension.mjs", import.meta.url));
    const [serverSource, extensionSource] = await Promise.all([
        fs.readFile(serverPath, "utf8"),
        fs.readFile(extensionPath, "utf8"),
    ]);
    const viewer = viewerSource(serverSource);
    const repos = [{ slug: "content", baseDir: "docs" }];

    assert.equal(viewer, viewerSource(extensionSource), "standalone and canvas viewer sources must stay in parity");
    assert.equal(resolveDocumentLinkPath(viewer, repos, "guide.md", "/docs/other.md"), "other.md");
    assert.equal(resolveDocumentLinkPath(viewer, repos, "nested/guide.md", "/docs/nested/other.md"), "nested/other.md");
    assert.equal(resolveDocumentLinkPath(viewer, repos, "guide.md", "/outside/other.md"), null);
    assert.equal(resolveDocumentLinkPath(viewer, repos, "guide.md", "/docs/../outside/other.md"), null);
});

before(async () => {
    await fs.mkdir(testRoot, { recursive: true });
    await git(["init", "--bare", remotePath]);
    await git(["clone", remoteUrl, seedPath]);
    await git(["checkout", "-b", "main"], seedPath);
    await fs.mkdir(path.join(seedPath, "data"), { recursive: true });
    await fs.writeFile(path.join(seedPath, "data", "guide.md"), "# Guide\n\nSearchable content\n");
    await git(["add", "data/guide.md"], seedPath);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Create guide"], seedPath);
    await git(["push", "origin", "main"], seedPath);
});

after(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

test("persists presentation and search browser state in mirrored viewer sources", async () => {
    const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
    const extensionPath = fileURLToPath(new URL("../extension.mjs", import.meta.url));
    const [serverSource, extensionSource] = await Promise.all([
        fs.readFile(serverPath, "utf8"),
        fs.readFile(extensionPath, "utf8"),
    ]);
    const viewer = viewerSource(serverSource);

    assert.equal(viewer, viewerSource(extensionSource), "standalone and canvas viewer sources must stay in parity");
    const presentRequestContract = /function hasPresentationRequest\(url\) \{\s+return url\.searchParams\.getAll\("present"\)\.length === 1 && url\.searchParams\.get\("present"\) === "1";\s+\}/;
    assert.match(serverSource, presentRequestContract);
    assert.match(extensionSource, presentRequestContract);
    assert.match(serverSource, /presentMode: hasPresentationRequest\(url\)/);
    assert.match(extensionSource, /presentMode: hasPresentationRequest\(url\)/);
    assert.match(viewer, /const currentUrl = new URL\(window\.location\.href\)/);
    assert.match(viewer, /currentUrl\.searchParams\.set\("present", "1"\)/);
    assert.match(viewer, /currentUrl\.searchParams\.delete\("present"\)/);
    assert.match(viewer, /window\.history\.replaceState\(\{ repo: activeRepo, path: activePath \}, "", currentUrl\)/);
    assert.match(viewer, /window\.history\.pushState\(\{ repo: activeRepo, path \}, "", documentNavigationUrl\(path\)\)/);
    assert.match(viewer, /setPresentationMode\(true\)/);
    assert.match(viewer, /setPresentationMode\(false\)/);
    assert.match(viewer, /const searchSessionStorageKey = "content-viewer-search"/);
    assert.match(viewer, /sessionStorage\.getItem\(searchSessionStorageKey\)/);
    assert.match(viewer, /sessionStorage\.setItem\(searchSessionStorageKey, query\)/);
    assert.match(viewer, /sessionStorage\.removeItem\(searchSessionStorageKey\)/);
    assert.match(viewer, /searchInput\.addEventListener\("input", \(\) => \{\s+persistSearchQuery\(searchInput\.value\)/);

    const initializeIndex = viewer.indexOf("async function initialize()");
    const openDocumentIndex = viewer.indexOf("await openDocument(initialDocPath", initializeIndex);
    const restoreIndex = viewer.indexOf("const storedSearchQuery = getStoredSearchQuery()", initializeIndex);
    const searchIndex = viewer.indexOf("await search()", restoreIndex);
    assert.ok(openDocumentIndex < restoreIndex && restoreIndex < searchIndex, "restored search must use the initialized route and search pipeline");

    const { documentUrl, documentNavigationUrl, updatePresentationUrl, updates, window } = evaluateNavigationUrlFunctions(
        viewer,
        "https://viewer.example/content/old-guide.md?present=1&theme=night&filter=owned#section-two",
    );
    const shareUrl = documentUrl("nested/next guide.md");
    assert.equal(shareUrl, "https://viewer.example/content/nested/next%20guide.md");
    assert.doesNotMatch(shareUrl, /data/);
    assert.match(viewer, /const link = documentUrl\(activePath\);/);
    const nextUrl = documentNavigationUrl("next guide.md");
    assert.equal(nextUrl.pathname, "/content/next%20guide.md");
    assert.equal(nextUrl.search, "?present=1&theme=night&filter=owned");
    assert.equal(nextUrl.searchParams.get("present"), "1");
    assert.equal(nextUrl.searchParams.get("theme"), "night");
    assert.equal(nextUrl.searchParams.get("filter"), "owned");
    assert.equal(nextUrl.hash, "#section-two");

    window.location.href = nextUrl.href;
    updatePresentationUrl(false);
    const [, , exitUrl] = updates.at(-1);
    assert.equal(exitUrl.pathname, "/content/next%20guide.md");
    assert.equal(exitUrl.search, "?theme=night&filter=owned");
    assert.equal(exitUrl.searchParams.has("present"), false);
    assert.equal(exitUrl.searchParams.get("theme"), "night");
    assert.equal(exitUrl.searchParams.get("filter"), "owned");
    assert.equal(exitUrl.hash, "#section-two");

    const server = await startServerForTest([{
        slug: "content",
        label: "content",
        path: activePath,
        url: remoteUrl,
        branch: "main",
        baseDir: "data",
        order: 0,
    }]);
    try {
        assert.match(await pageHtml(server, "?q=keep&present=1"), /const initialPresentMode = true;/);
        for (const suffix of ["?present=0", "?present=01", "?present=true", "?present=one", "?present=", "?present=1&present=0"]) {
            assert.match(await pageHtml(server, suffix), /const initialPresentMode = false;/);
        }
        assert.match(await pageHtml(server, ""), /const initialPresentMode = false;/);
    } finally {
        await server.close();
    }
});
