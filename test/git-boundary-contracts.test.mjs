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
const testRoot = path.join(process.cwd(), ".t");
const remotePath = path.join(testRoot, "r.git");
const seedPath = path.join(testRoot, "s");
const activePath = path.join(testRoot, "a");
const remoteUrl = pathToFileURL(remotePath).href;
const { startServerForTest } = await import("../server.mjs");

async function git(args, cwd) {
    await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function writeGuide(content) {
    await fs.mkdir(path.join(seedPath, "data"), { recursive: true });
    await fs.writeFile(path.join(seedPath, "data", "guide.md"), content);
    await git(["add", "data/guide.md"], seedPath);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Update guide"], seedPath);
    await git(["push", "origin", "main"], seedPath);
}

async function api(server, pathname, options) {
    const response = await fetch(`${server.url}${pathname}`, options);
    return { response, body: await response.json() };
}

const repository = {
    slug: "content",
    label: "content",
    path: activePath,
    url: remoteUrl,
    branch: "main",
    baseDir: "data",
    order: 0,
};

before(async () => {
    await fs.mkdir(testRoot, { recursive: true });
    await git(["init", "--bare", remotePath]);
    await git(["clone", remoteUrl, seedPath]);
    await git(["checkout", "-b", "main"], seedPath);
    await writeGuide("# Initial guide\n\nAlpha content\n");
});

after(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

test("runtime Git and viewer service contracts", async () => {
    const first = await startServerForTest([repository]);
    try {
        const health = await api(first, "/api/health");
        assert.equal(health.response.status, 200);

        const initialSearch = await api(first, "/api/search?q=alpha");
        assert.equal(initialSearch.response.status, 200, JSON.stringify(initialSearch.body));
        assert.equal(initialSearch.body.total, 1);
        assert.equal(initialSearch.body.results[0].path, "guide.md");

        const document = await api(first, "/api/doc?path=guide.md");
        assert.equal(document.response.status, 200);
        assert.equal(document.body.sourcePath, "data/guide.md");

        const directLink = await fetch(`${first.url}/content/guide.md`);
        assert.equal(directLink.status, 200);
        assert.match(await directLink.text(), /guide\.md/);

        const traversal = await api(first, "/api/doc?path=..%2Fsecret.md");
        assert.equal(traversal.response.status, 404);

        await writeGuide("# Updated guide\n\nBravo content\n");
        const refreshed = await api(first, "/api/refresh", { method: "POST" });
        assert.equal(refreshed.response.status, 200);
        assert.equal(refreshed.body.total, 1);
        const updatedSearch = await api(first, "/api/search?q=bravo");
        assert.equal(updatedSearch.body.results[0].title, "Updated guide");

        await fs.rename(remotePath, `${remotePath}.offline`);
        try {
            const failedRefresh = await api(first, "/api/refresh", { method: "POST" });
            assert.equal(failedRefresh.response.status, 500);
            assert.match(failedRefresh.body.error, /^Git pull failed$/);
            const preservedSearch = await api(first, "/api/search?q=bravo");
            assert.equal(preservedSearch.response.status, 200);
            assert.equal(preservedSearch.body.results[0].title, "Updated guide");
        } finally {
            await fs.rename(`${remotePath}.offline`, remotePath);
        }
    } finally {
        await first.close();
    }

    const restarted = await startServerForTest([repository]);
    try {
        const existingClone = await api(restarted, "/api/search?q=bravo");
        assert.equal(existingClone.response.status, 200);
        assert.equal(existingClone.body.results[0].title, "Updated guide");
    } finally {
        await restarted.close();
    }

    const canvas = await startServerForTest([{ ...repository, url: "git@github.com:example/contracts.git" }]);
    try {
        const source = await api(canvas, "/api/doc?path=guide.md");
        assert.equal(source.response.status, 200);
        assert.equal(source.body.sourceUrl, "https://github.com/example/contracts/blob/main/data/guide.md");
    } finally {
        await canvas.close();
    }

    const rejected = await startServerForTest([{ ...repository, slug: "unsafe", path: path.join(testRoot, "unsafe"), url: "ssh://github.com/example/contracts.git" }]);
    try {
        const unsafeSearch = await api(rejected, "/api/search");
        assert.equal(unsafeSearch.response.status, 500);
        assert.match(unsafeSearch.body.error, /must use HTTPS/);
    } finally {
        await rejected.close();
    }

    const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
    await assert.rejects(
        execFileAsync(process.execPath, [serverPath], {
            env: {
                ...process.env,
                NODE_ENV: "production",
                CONTENT_VIEWER_TEST_ALLOW_LOCAL_GIT: "",
                CONTENT_VIEWER_REPO_URL: "file:///not-permitted.git",
            },
        }),
        /Repository URL must use HTTPS on an allowed host/,
    );
});