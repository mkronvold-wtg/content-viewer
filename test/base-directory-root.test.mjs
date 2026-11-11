import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

process.env.NODE_ENV = "test";

const execFileAsync = promisify(execFile);
const testRoot = path.join(process.cwd(), ".base-directory-root-test");
const repositoryPath = path.join(testRoot, "repository");
const { startServerForTest } = await import("../server.mjs");

function repository(baseDir) {
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

async function startIndexedServer(baseDir) {
    const server = await startServerForTest([repository(baseDir)]);
    return server;
}

before(async () => {
    await fs.mkdir(path.join(repositoryPath, "docs", "nested"), { recursive: true });
    await fs.mkdir(path.join(repositoryPath, "docs", "assets"), { recursive: true });
    await fs.mkdir(path.join(repositoryPath, "outside"), { recursive: true });
    await fs.writeFile(path.join(repositoryPath, "README.md"), "# Repository readme\n\noutside-root-only\n");
    await fs.writeFile(path.join(repositoryPath, "outside", "unrelated.md"), "# Outside document\n\noutside-only\n");
    await fs.writeFile(path.join(repositoryPath, "not-a-directory"), "not a directory\n");
    await fs.writeFile(path.join(repositoryPath, "outside.svg"), "<svg><title>outside</title></svg>\n");
    await fs.writeFile(path.join(repositoryPath, "docs", "guide.md"), "# Guide\n\ninside-guide\n\n![Chart](assets/chart.svg)\n");
    await fs.writeFile(path.join(repositoryPath, "docs", "nested", "guide.md"), "# Nested guide\n\ninside-nested\n");
    await fs.writeFile(path.join(repositoryPath, "docs", "assets", "chart.svg"), "<svg><title>inside</title></svg>\n");
    await execFileAsync("git", ["init"], { cwd: repositoryPath, windowsHide: true });
});

after(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

test("indexes the repository root when BASE_DIR is empty", async () => {
    const server = await startIndexedServer("");
    try {
        const search = await api(server, "/api/search?repo=content&q=outside-only");
        assert.equal(search.response.status, 200);
        assert.equal(search.body.total, 4);
        assert.deepEqual(search.body.results.map((result) => result.path), ["outside/unrelated.md"]);

        const document = await api(server, "/api/doc?repo=content&path=docs%2Fguide.md");
        assert.equal(document.response.status, 200);
        assert.equal(document.body.path, "docs/guide.md");
        assert.equal(document.body.sourcePath, "docs/guide.md");
    } finally {
        await server.close();
    }
});

test("enforces BASE_DIR while preserving source paths and public display paths", async () => {
    const server = await startIndexedServer("/docs/");
    try {
        const allDocuments = await api(server, "/api/search?repo=content");
        assert.equal(allDocuments.response.status, 200);
        assert.equal(allDocuments.body.total, 2);
        assert.deepEqual(allDocuments.body.results.map((result) => result.path).sort(), ["guide.md", "nested/guide.md"]);

        const hiddenPrefix = await api(server, "/api/search?repo=content&q=docs");
        assert.equal(hiddenPrefix.response.status, 200);
        assert.equal(hiddenPrefix.body.count, 0);

        const document = await api(server, "/api/doc?repo=content&path=guide.md");
        assert.equal(document.response.status, 200);
        assert.equal(document.body.path, "guide.md");
        assert.equal(document.body.sourcePath, "docs/guide.md");
        assert.equal(document.body.sourceUrl, "https://github.com/example/content-viewer-fixture/blob/main/docs/guide.md");

        const sourcePathRequest = await api(server, "/api/doc?repo=content&path=docs%2Fguide.md");
        assert.equal(sourcePathRequest.response.status, 404);

        const route = await fetch(`${server.url}/content/nested/guide.md?present=1&theme=night#section`);
        assert.equal(route.status, 200);
        const html = await route.text();
        assert.match(html, /const initialDocPath = "nested\/guide\.md";/);
        assert.doesNotMatch(html, /const initialDocPath = "docs\/nested\/guide\.md";/);

        const relativeAsset = await fetch(`${server.url}/asset?repo=content&doc=guide.md&src=assets%2Fchart.svg`);
        assert.equal(relativeAsset.status, 200);
        assert.match(await relativeAsset.text(), /inside/);

        const sourceStyleAbsoluteAsset = await fetch(`${server.url}/asset?repo=content&doc=guide.md&src=%2Fdocs%2Fassets%2Fchart.svg`);
        assert.equal(sourceStyleAbsoluteAsset.status, 200);
        assert.match(await sourceStyleAbsoluteAsset.text(), /inside/);

        const outsideAsset = await api(server, "/asset?repo=content&doc=guide.md&src=%2Foutside.svg");
        assert.equal(outsideAsset.response.status, 404);
    } finally {
        await server.close();
    }
});

test("allows a repository-contained BASE_DIR named ..docs", async () => {
    await fs.mkdir(path.join(repositoryPath, "..docs"), { recursive: true });
    await fs.writeFile(path.join(repositoryPath, "..docs", "guide.md"), "# Dot docs guide\n\ninside-dot-docs\n");
    const server = await startIndexedServer("..docs");
    try {
        const search = await api(server, "/api/search?repo=content&q=inside-dot-docs");
        assert.equal(search.response.status, 200);
        assert.deepEqual(search.body.results.map((result) => result.path), ["guide.md"]);
    } finally {
        await server.close();
    }
});

test("reports invalid BASE_DIR configurations without indexing the repository root", async () => {
    for (const [baseDir, expected] of [
        ["missing", /Invalid BASE_DIR for content repo "content": "missing" does not exist/],
        ["not-a-directory", /Invalid BASE_DIR for content repo "content": "not-a-directory" is not a directory/],
        ["../outside", /Invalid BASE_DIR for content repo "content": "\.\.\/outside" must be a repository-relative directory/],
    ]) {
        const server = await startIndexedServer(baseDir);
        try {
            const search = await api(server, "/api/search?repo=content");
            assert.equal(search.response.status, 500);
            assert.match(search.body.error, expected);

            const health = await api(server, "/api/health");
            assert.equal(health.response.status, 200);
            assert.equal(health.body.repos[0].documents, 0);
            assert.equal(health.body.repos[0].indexed, false);
            assert.match(health.body.repos[0].error, expected);
        } finally {
            await server.close();
        }
    }
});

test("rejects traversal and source-path document access outside the enforced root", async () => {
    const server = await startIndexedServer("docs");
    try {
        for (const pathname of [
            "/api/doc?repo=content&path=..%2Foutside%2Funrelated.md",
            "/api/doc?repo=content&path=docs%2Fguide.md",
            "/asset?repo=content&doc=..%2Foutside%2Funrelated.md&src=%2Foutside.svg",
        ]) {
            const response = await fetch(`${server.url}${pathname}`);
            assert.equal(response.status, 404, pathname);
        }

        const route = await fetch(`${server.url}/content/%2E%2E%2Foutside%2Funrelated.md`);
        assert.equal(route.status, 404);
    } finally {
        await server.close();
    }
});
