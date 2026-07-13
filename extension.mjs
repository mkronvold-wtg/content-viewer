import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRIMARY_REPO_PATH = process.env.CONTENT_VIEWER_PRIMARY_REPO_PATH ?? "";
const DEFAULT_CONTENT_ROOT = process.env.CONTENT_VIEWER_CONTENT_ROOT ?? path.join(EXTENSION_DIR, "content");
const MERMAID_MODULE_PATH = path.join(EXTENSION_DIR, "node_modules", "mermaid", "dist", "mermaid.esm.min.mjs");
const MAX_SNIPPET_LENGTH = 140;
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const MIME_TYPES = new Map([
    [".avif", "image/avif"],
    [".gif", "image/gif"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml; charset=utf-8"],
    [".webp", "image/webp"],
]);
const SKIPPED_DIRECTORIES = new Set([
    ".git",
    ".github",
    ".obsidian",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
]);
const RESERVED_REPO_SLUGS = new Set(["api", "asset", "vendor", "favicon.ico"]);

const servers = new Map();

function toPosixPath(value) {
    return value.split(path.sep).join("/");
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function pathsEqual(left, right) {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function sanitizeRepoSlug(value) {
    return String(value ?? "")
        .trim()
        .replace(/^\/+|\/+$/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function repoEnvKey(slug) {
    return sanitizeRepoSlug(slug).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function envForRepo(slug, name) {
    return process.env[`CONTENT_VIEWER_REPO_${repoEnvKey(slug)}_${name}`];
}

function normalizeBaseDir(value) {
    return String(value ?? "")
        .trim()
        .replaceAll("\\", "/")
        .replace(/^\/+|\/+$/g, "")
        .trim();
}

function stripBaseDir(relativePath, baseDir) {
    const normalized = String(relativePath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
    const normalizedBase = normalizeBaseDir(baseDir);
    if (!normalizedBase) {
        return normalized;
    }
    if (normalized === normalizedBase) {
        return "";
    }
    return normalized.startsWith(`${normalizedBase}/`) ? normalized.slice(normalizedBase.length + 1) : normalized;
}

function addBaseDir(displayPath, baseDir) {
    const normalized = String(displayPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
    const normalizedBase = normalizeBaseDir(baseDir);
    return normalizedBase ? `${normalizedBase}/${normalized}`.replace(/\/+$/, "") : normalized;
}

function publicRepoConfig(repo) {
    return {
        slug: repo.slug,
        label: repo.label,
        baseDir: repo.baseDir,
    };
}

function parseRepoConfigs() {
    const configuredSlugs = String(process.env.CONTENT_VIEWER_REPOS ?? "")
        .split(",")
        .map(sanitizeRepoSlug)
        .filter(Boolean);

    const slugs = configuredSlugs.length
        ? configuredSlugs
        : [sanitizeRepoSlug(process.env.CONTENT_VIEWER_REPO_NAME ?? "content")];

    const repos = slugs.map((slug, index) => {
        const pathFromEnv = envForRepo(slug, "PATH") ?? (configuredSlugs.length ? undefined : process.env.CONTENT_VIEWER_REPO_PATH);
        const urlFromEnv = envForRepo(slug, "URL") ?? (configuredSlugs.length ? undefined : process.env.CONTENT_VIEWER_REPO_URL);
        const branchFromEnv = envForRepo(slug, "BRANCH") ?? (configuredSlugs.length ? undefined : process.env.CONTENT_VIEWER_REPO_BRANCH);
        const baseDirFromEnv = envForRepo(slug, "BASE_DIR") ?? (configuredSlugs.length ? undefined : process.env.CONTENT_VIEWER_REPO_BASE_DIR);
        return {
            slug,
            label: envForRepo(slug, "LABEL") ?? slug,
            path: path.resolve(pathFromEnv ?? (configuredSlugs.length ? path.join(DEFAULT_CONTENT_ROOT, slug) : DEFAULT_CONTENT_ROOT)),
            url: urlFromEnv ?? "",
            branch: branchFromEnv ?? "main",
            baseDir: normalizeBaseDir(baseDirFromEnv),
            order: index,
        };
    });

    if (!repos.length) {
        throw new Error("Configure at least one content repository");
    }

    const seen = new Set();
    for (const repo of repos) {
        if (seen.has(repo.slug)) {
            throw new Error(`Duplicate content repo slug: ${repo.slug}`);
        }
        if (RESERVED_REPO_SLUGS.has(repo.slug.toLowerCase())) {
            throw new Error(`Content repo slug is reserved: ${repo.slug}`);
        }
        seen.add(repo.slug);
    }

    return repos;
}

const CONFIGURED_REPOS = parseRepoConfigs();

function cleanTag(value) {
    return String(value ?? "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
}

function normalizeTag(value) {
    return cleanTag(value).replace(/^#/, "").toLowerCase();
}

function normalizeRepoPath(input) {
    if (input && typeof input.repoPath === "string" && input.repoPath.trim()) {
        const requestedPath = path.resolve(input.repoPath.trim());
        if (!pathsEqual(requestedPath, PRIMARY_REPO_PATH)) {
            return requestedPath;
        }
    }

    return CONFIGURED_REPOS[0].path;
}

async function runGit(args) {
    const token = process.env.CONTENT_VIEWER_GITHUB_TOKEN;
    const authHeader = token
        ? Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")
        : "";
    const gitArgs = token ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${authHeader}`, ...args] : args;
    try {
        const { stdout, stderr } = await execFileAsync("git", gitArgs, {
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return `${stdout}${stderr}`.trim();
    } catch (error) {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
        const command = ["git", ...args].join(" ");
        throw new Error(output ? `${command} failed:\n${output}` : `${command} failed`);
    }
}

async function ensureDisposableClone(repoState) {
    const { repo } = repoState;
    const repoPath = repo.path;
    try {
        const stat = await fs.stat(path.join(repoPath, ".git"));
        if (stat.isDirectory()) {
            return { skipped: false, output: `${repo.slug} clone already exists.` };
        }
    } catch {
        if (!repo.url) {
            throw new Error(`Set a repository URL before cloning ${repo.slug}`);
        }
        await fs.mkdir(path.dirname(repoPath), { recursive: true });
        const output = await runGit(["clone", "--depth", "1", "--branch", repo.branch, repo.url, repoPath]);
        return { skipped: false, output };
    }

    throw new Error(`${repoPath} exists but is not a Git clone`);
}

async function updateDisposableClone(repoState) {
    await ensureDisposableClone(repoState);
    const output = await runGit(["-C", repoState.repo.path, "pull", "--ff-only"]);
    return { skipped: false, output };
}

function extractFrontmatter(content) {
    if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
        return {};
    }

    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) {
        return {};
    }

    const frontmatter = match[1];
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/im);
    const tags = extractFrontmatterTags(frontmatter);

    return {
        title: titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : undefined,
        tags,
    };
}

function stripFrontmatter(content) {
    return String(content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function extractFrontmatterTags(frontmatter) {
    const blockMatch = frontmatter.match(/^tags:[ \t]*\r?\n((?:[ \t]+-[ \t]+.+\r?\n?)+)/im);
    if (blockMatch) {
        return blockMatch[1]
            .split(/\r?\n/)
            .map((line) => cleanTag(line.replace(/^\s+-\s+/, "")))
            .filter(Boolean);
    }

    const inlineMatch = frontmatter.match(/^tags:[ \t]*(.+)$/im);
    if (inlineMatch && inlineMatch[1].trim()) {
        const inlineValue = inlineMatch[1].trim();
        const listMatch = inlineValue.match(/^\[(.*)\]$/);
        if (listMatch) {
            return listMatch[1]
                .split(",")
                .map(cleanTag)
                .filter(Boolean);
        }

        return [cleanTag(inlineValue)].filter(Boolean);
    }

    return [];
}

function extractTitle(content, filePath) {
    const frontmatter = extractFrontmatter(content);
    if (frontmatter.title) {
        return frontmatter.title;
    }

    const heading = content.match(/^#\s+(.+)$/m);
    if (heading) {
        return heading[1].trim();
    }

    return path.basename(filePath, path.extname(filePath));
}

function makeSnippet(content, tokens) {
    const normalized = stripFrontmatter(content).replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "";
    }

    const lower = normalized.toLowerCase();
    const firstIndex = tokens
        .map((token) => lower.indexOf(token))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
    const start = Math.max(0, (firstIndex ?? 0) - 80);
    const end = Math.min(normalized.length, start + MAX_SNIPPET_LENGTH);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < normalized.length ? "..." : "";

    return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function parseSearchQuery(query) {
    const tagFilters = [];
    let text = String(query ?? "").replace(/tag:\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi, (match, doubleQuoted, singleQuoted, bare) => {
        const tag = cleanTag(doubleQuoted ?? singleQuoted ?? bare);
        if (tag) {
            tagFilters.push(normalizeTag(tag));
        }

        return " ";
    });

    text = text.replace(/\btag:\s*$/i, " ");
    const tokens = text
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);

    return { tokens, tagFilters };
}

async function buildIndex(repo) {
    const repoPath = repo.path;
    const rootStat = await fs.stat(repoPath);
    if (!rootStat.isDirectory()) {
        throw new Error(`${repoPath} is not a directory`);
    }

    const docs = [];

    async function walk(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        await Promise.all(
            entries.map(async (entry) => {
                if (entry.isDirectory()) {
                    if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                        await walk(path.join(directory, entry.name));
                    }
                    return;
                }

                if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
                    return;
                }

                const fullPath = path.join(directory, entry.name);
                const stat = await fs.stat(fullPath);
                if (stat.size > MAX_INDEXED_FILE_BYTES) {
                    return;
                }

                const content = await fs.readFile(fullPath, "utf8");
                const relativePath = toPosixPath(path.relative(repoPath, fullPath));
                const displayPath = stripBaseDir(relativePath, repo.baseDir);
                const frontmatter = extractFrontmatter(content);
                const title = extractTitle(content, fullPath);
                docs.push({
                    path: displayPath,
                    sourcePath: relativePath,
                    title,
                    tags: frontmatter.tags ?? [],
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    content,
                    searchable: `${title}\n${displayPath}\n${relativePath}\n${(frontmatter.tags ?? []).join(" ")}\n${content}`.toLowerCase(),
                });
            }),
        );
    }

    await walk(repoPath);
    docs.sort((a, b) => a.path.localeCompare(b.path));
    return {
        repo: publicRepoConfig(repo),
        repoPath,
        indexedAt: new Date().toISOString(),
        docs,
    };
}

async function ensureIndex(state) {
    if (state.index) {
        return state.index;
    }

    if (!state.indexPromise) {
        state.indexPromise = ensureDisposableClone(state)
            .then(() => buildIndex(state.repo))
            .then((index) => {
                state.index = index;
                state.error = null;
                return index;
            })
            .catch((error) => {
                state.error = error instanceof Error ? error.message : String(error);
                throw error;
            })
            .finally(() => {
                state.indexPromise = null;
            });
    }

    return state.indexPromise;
}

function searchIndex(index, query, limit = 50) {
    const { tokens, tagFilters } = parseSearchQuery(query);

    const scored = index.docs
        .map((doc) => {
            const normalizedTags = doc.tags.map(normalizeTag);
            if (tagFilters.length && !tagFilters.every((tag) => normalizedTags.includes(tag))) {
                return null;
            }

            if (!tokens.length) {
                return { doc, score: Date.parse(doc.modified) / 1000000000 };
            }

            if (!tokens.every((token) => doc.searchable.includes(token))) {
                return null;
            }

            const title = doc.title.toLowerCase();
            const docPath = doc.path.toLowerCase();
            const tags = doc.tags.join(" ").toLowerCase();
            const score = tokens.reduce((total, token) => {
                const contentMatches = doc.searchable.split(token).length - 1;
                return (
                    total +
                    (title.includes(token) ? 50 : 0) +
                    (docPath.includes(token) ? 25 : 0) +
                    (tags.includes(token) ? 20 : 0) +
                    Math.min(contentMatches, 20)
                );
            }, tagFilters.length ? tagFilters.length * 100 : 0);

            return { doc, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
        .slice(0, limit);

    return scored.map(({ doc, score }) => ({
        path: doc.path,
        title: doc.title,
        tags: doc.tags,
        modified: doc.modified,
        size: doc.size,
        score,
        snippet: makeSnippet(doc.content, tokens),
    }));
}

function findDoc(index, relativePath) {
    const normalizedPath = String(relativePath ?? "").replaceAll("\\", "/");
    return index.docs.find((doc) => doc.path === normalizedPath || doc.sourcePath === normalizedPath);
}

function isExternalAsset(src) {
    return /^(?:https?:|data:|blob:|mailto:|#)/i.test(String(src ?? "").trim());
}

function stripAssetDecorations(src) {
    const withoutHash = String(src ?? "").split("#")[0];
    const withoutQuery = withoutHash.split("?")[0];
    try {
        return decodeURIComponent(withoutQuery);
    } catch {
        return withoutQuery;
    }
}

function normalizeRepoRelative(value) {
    const normalized = path.normalize(String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, ""));
    if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
        return null;
    }

    return normalized;
}

function isWithinDirectory(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function fileExists(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function findAssetByBasename(root, basename) {
    const queue = [root];
    while (queue.length) {
        const directory = queue.shift();
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                    queue.push(path.join(directory, entry.name));
                }
                continue;
            }

            if (entry.isFile() && entry.name === basename) {
                return path.join(directory, entry.name);
            }
        }
    }

    return null;
}

async function resolveAssetPath(state, index, docRelativePath, assetSrc) {
    if (isExternalAsset(assetSrc)) {
        return null;
    }

    const doc = findDoc(index, docRelativePath);
    const docRelative = normalizeRepoRelative(doc?.sourcePath ?? addBaseDir(docRelativePath, state.repo.baseDir));
    const assetRelative = stripAssetDecorations(assetSrc);
    if (!docRelative || !assetRelative) {
        return null;
    }

    const repoPath = state.repo.path;
    const docPath = path.resolve(repoPath, docRelative);
    if (!isWithinDirectory(repoPath, docPath)) {
        return null;
    }

    const normalizedAsset = assetRelative.replaceAll("\\", "/");
    const basename = path.basename(normalizedAsset);
    const docDirectory = path.dirname(docPath);
    const candidates = [];

    if (normalizedAsset.startsWith("/")) {
        const repoRelative = normalizeRepoRelative(normalizedAsset);
        if (repoRelative) {
            candidates.push(path.resolve(repoPath, repoRelative));
            candidates.push(path.resolve(repoPath, addBaseDir(repoRelative, state.repo.baseDir)));
        }
    } else {
        candidates.push(path.resolve(docDirectory, normalizedAsset));
        candidates.push(path.resolve(docDirectory, basename));
        candidates.push(path.resolve(docDirectory, "attachments", basename));
        candidates.push(path.resolve(repoPath, "attachments", basename));
        if (state.repo.baseDir) {
            candidates.push(path.resolve(repoPath, state.repo.baseDir, "attachments", basename));
        }
    }

    for (const candidate of candidates) {
        if (isWithinDirectory(repoPath, candidate) && (await fileExists(candidate))) {
            return candidate;
        }
    }

    const found = await findAssetByBasename(repoPath, basename);
    return found && isWithinDirectory(repoPath, found) ? found : null;
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

function sendHtml(res, body) {
    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

async function sendFile(res, filePath) {
    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
    });
    res.end(body);
}

function createRepoState(instanceId, repo) {
    return {
        instanceId,
        repo,
        index: null,
        indexPromise: null,
        error: null,
    };
}

function createAppState(instanceId, repos = CONFIGURED_REPOS) {
    const repoStates = new Map(repos.map((repo) => [repo.slug, createRepoState(instanceId, repo)]));
    return {
        instanceId,
        repos,
        repoStates,
        defaultRepoSlug: repos[0].slug,
    };
}

function getRepoState(appState, slug) {
    if (!slug) {
        return appState.repoStates.get(appState.defaultRepoSlug);
    }
    return appState.repoStates.get(slug);
}

function requireRepoState(appState, slug) {
    const state = getRepoState(appState, slug);
    if (!state) {
        throw new Error(`Unknown content repo: ${slug}`);
    }
    return state;
}

function parseRepoRoute(appState, pathname) {
    const segments = pathname.split("/").filter(Boolean);
    if (!segments.length) {
        return null;
    }

    const repoSlug = decodeURIComponent(segments[0]);
    if (!appState.repoStates.has(repoSlug)) {
        return null;
    }

    return {
        repoSlug,
        docPath: segments.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
    };
}

function renderHtml(appState, initialView = {}) {
    const repos = appState.repos.map(publicRepoConfig);
    const initialRepoSlug = initialView.repoSlug && appState.repoStates.has(initialView.repoSlug)
        ? initialView.repoSlug
        : appState.defaultRepoSlug;
    const initialDocPath = initialView.docPath ?? "";
    const initialPresentMode = Boolean(initialView.presentMode && initialDocPath);
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KPE document dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --dashboard-bg: #f5f7fb;
      --dashboard-text: #0f172a;
      --dashboard-muted: #64748b;
      --dashboard-border: #dbe2ea;
      --dashboard-border-muted: #e2e8f0;
      --dashboard-hr: #94a3b8;
      --dashboard-surface: #ffffff;
      --dashboard-input-bg: #ffffff;
      --dashboard-button-bg: #eef2ff;
      --dashboard-button-hover-bg: #e0e7ff;
      --dashboard-hover-bg: rgba(9, 105, 218, 0.08);
      --dashboard-active-bg: #eef2ff;
      --dashboard-active-border: #4338ca;
      --dashboard-code-bg: #f8fafc;
      --dashboard-code-border: #e2e8f0;
      --dashboard-mark-bg: #fef3c7;
      --dashboard-mark-text: #92400e;
      --dashboard-link: #4338ca;
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-color-mode="light"]) {
        --dashboard-bg: #07111f;
        --dashboard-text: #e8f1ff;
        --dashboard-muted: #93a8c5;
        --dashboard-border: #2b4262;
        --dashboard-border-muted: #395272;
        --dashboard-hr: #8fb8ff;
        --dashboard-surface: #0c1628;
        --dashboard-input-bg: #08101c;
        --dashboard-button-bg: #14243d;
        --dashboard-button-hover-bg: #1a2942;
        --dashboard-hover-bg: rgba(94, 167, 255, 0.14);
        --dashboard-active-bg: #14243d;
        --dashboard-active-border: #5ea7ff;
        --dashboard-code-bg: #15253d;
        --dashboard-code-border: #395272;
        --dashboard-mark-bg: #433318;
        --dashboard-mark-text: #ffd96a;
        --dashboard-link: #9dc4ff;
      }
    }

    :root[data-color-mode="dark"],
    :root[data-visual-mode="dark"],
    body[data-color-mode="dark"],
    body[data-visual-mode="dark"] {
      --dashboard-bg: #07111f;
      --dashboard-text: #e8f1ff;
      --dashboard-muted: #93a8c5;
      --dashboard-border: #2b4262;
      --dashboard-border-muted: #395272;
      --dashboard-hr: #8fb8ff;
      --dashboard-surface: #0c1628;
      --dashboard-input-bg: #08101c;
      --dashboard-button-bg: #14243d;
      --dashboard-button-hover-bg: #1a2942;
      --dashboard-hover-bg: rgba(94, 167, 255, 0.14);
      --dashboard-active-bg: #14243d;
      --dashboard-active-border: #5ea7ff;
      --dashboard-code-bg: #15253d;
      --dashboard-code-border: #395272;
      --dashboard-mark-bg: #433318;
      --dashboard-mark-text: #ffd96a;
      --dashboard-link: #9dc4ff;
    }

    :root[data-dashboard-theme="light"],
    body[data-dashboard-theme="light"] {
      color-scheme: light;
      --dashboard-bg: #f5f7fb;
      --dashboard-text: #0f172a;
      --dashboard-muted: #64748b;
      --dashboard-border: #dbe2ea;
      --dashboard-border-muted: #e2e8f0;
      --dashboard-hr: #94a3b8;
      --dashboard-surface: #ffffff;
      --dashboard-input-bg: #ffffff;
      --dashboard-button-bg: #eef2ff;
      --dashboard-button-hover-bg: #e0e7ff;
      --dashboard-hover-bg: rgba(9, 105, 218, 0.08);
      --dashboard-active-bg: #eef2ff;
      --dashboard-active-border: #4338ca;
      --dashboard-code-bg: #f8fafc;
      --dashboard-code-border: #e2e8f0;
      --dashboard-mark-bg: #fef3c7;
      --dashboard-mark-text: #92400e;
      --dashboard-link: #4338ca;
    }

    :root[data-dashboard-theme="dark"],
    :root[data-dashboard-theme="ocean"],
    body[data-dashboard-theme="dark"],
    body[data-dashboard-theme="ocean"] {
      color-scheme: dark;
      --dashboard-bg: #07111f;
      --dashboard-text: #e8f1ff;
      --dashboard-muted: #93a8c5;
      --dashboard-border: #2b4262;
      --dashboard-border-muted: #395272;
      --dashboard-hr: #8fb8ff;
      --dashboard-surface: #0c1628;
      --dashboard-input-bg: #08101c;
      --dashboard-button-bg: #14243d;
      --dashboard-button-hover-bg: #1a2942;
      --dashboard-hover-bg: rgba(94, 167, 255, 0.14);
      --dashboard-active-bg: #14243d;
      --dashboard-active-border: #5ea7ff;
      --dashboard-code-bg: #15253d;
      --dashboard-code-border: #395272;
      --dashboard-mark-bg: #433318;
      --dashboard-mark-text: #ffd96a;
      --dashboard-link: #9dc4ff;
    }

    :root[data-dashboard-theme="sepia"],
    body[data-dashboard-theme="sepia"] {
      color-scheme: light;
      --dashboard-bg: #f4eee3;
      --dashboard-text: #3f3424;
      --dashboard-muted: #7a6a58;
      --dashboard-border: #d8cab2;
      --dashboard-border-muted: #e2d7c4;
      --dashboard-hr: #a48b6b;
      --dashboard-surface: #fbf6ed;
      --dashboard-input-bg: #fffaf2;
      --dashboard-button-bg: #ede2d0;
      --dashboard-button-hover-bg: #e2d7c4;
      --dashboard-hover-bg: rgba(140, 90, 60, 0.12);
      --dashboard-active-bg: #ede2d0;
      --dashboard-active-border: #8c5a3c;
      --dashboard-code-bg: #efe6d7;
      --dashboard-code-border: #e2d7c4;
      --dashboard-mark-bg: #f6e1b4;
      --dashboard-mark-text: #7a4a11;
      --dashboard-link: #8c5a3c;
    }

    :root[data-dashboard-theme="spring"],
    body[data-dashboard-theme="spring"] {
      color-scheme: light;
      --dashboard-bg: #cfd5d1;
      --dashboard-text: #141c24;
      --dashboard-muted: #546570;
      --dashboard-border: #aab8b3;
      --dashboard-border-muted: #b8c4bf;
      --dashboard-hr: #0e1421;
      --dashboard-surface: #d6d9d7;
      --dashboard-input-bg: #d6d9d7;
      --dashboard-button-bg: #bdcec7;
      --dashboard-button-hover-bg: #bbc9cc;
      --dashboard-hover-bg: rgba(49, 133, 102, 0.12);
      --dashboard-active-bg: #bdcec7;
      --dashboard-active-border: #318566;
      --dashboard-code-bg: #c9d1d5;
      --dashboard-code-border: #b8c4bf;
      --dashboard-mark-bg: #d3c49b;
      --dashboard-mark-text: #68460e;
      --dashboard-link: #407d9f;
    }

    :root[data-dashboard-theme="forest"],
    body[data-dashboard-theme="forest"] {
      color-scheme: dark;
      --dashboard-bg: #06110d;
      --dashboard-text: #e3f6eb;
      --dashboard-muted: #8cb59d;
      --dashboard-border: #1f3a31;
      --dashboard-border-muted: #2b4d43;
      --dashboard-hr: #3dff78;
      --dashboard-surface: #0b1813;
      --dashboard-input-bg: #07130e;
      --dashboard-button-bg: #143227;
      --dashboard-button-hover-bg: #163228;
      --dashboard-hover-bg: rgba(56, 211, 144, 0.14);
      --dashboard-active-bg: #143227;
      --dashboard-active-border: #38d390;
      --dashboard-code-bg: #10251d;
      --dashboard-code-border: #2b4d43;
      --dashboard-mark-bg: #3a3317;
      --dashboard-mark-text: #f7d76b;
      --dashboard-link: #66d9a3;
    }

    :root[data-dashboard-theme="autumn"],
    body[data-dashboard-theme="autumn"] {
      color-scheme: dark;
      --dashboard-bg: #42261b;
      --dashboard-text: #f8e7d2;
      --dashboard-muted: #d7ad82;
      --dashboard-border: #966445;
      --dashboard-border-muted: #ae7853;
      --dashboard-hr: #f0cd67;
      --dashboard-surface: #5f3a28;
      --dashboard-input-bg: #543323;
      --dashboard-button-bg: #7d4f35;
      --dashboard-button-hover-bg: #845337;
      --dashboard-hover-bg: rgba(217, 109, 44, 0.16);
      --dashboard-active-bg: #7d4f35;
      --dashboard-active-border: #d96d2c;
      --dashboard-code-bg: #74472d;
      --dashboard-code-border: #ae7853;
      --dashboard-mark-bg: #7c5620;
      --dashboard-mark-text: #ffe18f;
      --dashboard-link: #f2a33f;
    }

    :root[data-dashboard-theme="night"],
    body[data-dashboard-theme="night"] {
      color-scheme: dark;
      --dashboard-bg: #08090b;
      --dashboard-text: #edf0f4;
      --dashboard-muted: #9ba3af;
      --dashboard-border: #2a2f37;
      --dashboard-border-muted: #3a414c;
      --dashboard-hr: #d6dbe2;
      --dashboard-surface: #111317;
      --dashboard-input-bg: #0d0f12;
      --dashboard-button-bg: #1b1f26;
      --dashboard-button-hover-bg: #1d222a;
      --dashboard-hover-bg: rgba(214, 219, 226, 0.12);
      --dashboard-active-bg: #1b1f26;
      --dashboard-active-border: #d6dbe2;
      --dashboard-code-bg: #181b20;
      --dashboard-code-border: #3a414c;
      --dashboard-mark-bg: #3b331d;
      --dashboard-mark-text: #eed388;
      --dashboard-link: #d6dbe2;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--dashboard-bg);
      color: var(--dashboard-text);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }

    header {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 12px;
      border-bottom: 1px solid var(--dashboard-border);
      background: var(--dashboard-bg);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 18px;
      line-height: 24px;
      font-weight: var(--font-weight-semibold, 600);
    }

    .search-row {
      display: flex;
      gap: 8px;
    }

    input {
      flex: 1;
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-input-bg);
      color: var(--dashboard-text);
      font: inherit;
    }

    .repo-select {
      max-width: 180px;
      padding: 8px 10px;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-input-bg);
      color: var(--dashboard-text);
      font: inherit;
    }

    input::placeholder {
      color: var(--dashboard-muted);
      opacity: 1;
    }

    input:focus {
      outline: 2px solid var(--color-focus-outline, #0969da);
      outline-offset: 1px;
    }

    button {
      padding: 8px 10px;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-button-bg);
      color: var(--dashboard-text);
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      background: var(--dashboard-button-hover-bg);
    }

    main {
      display: grid;
      grid-template-columns: minmax(260px, 34%) 1fr;
      min-height: calc(100vh - 97px);
    }

    .present-controls {
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 10;
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
      border: 1px solid var(--dashboard-border);
      border-radius: 999px;
      background: color-mix(in srgb, var(--dashboard-bg) 88%, transparent);
      color: var(--dashboard-muted);
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
      color: var(--dashboard-muted);
      font-size: 12px;
      text-align: center;
    }

    body.presenting header,
    body.presenting .results,
    body.presenting .toolbar,
    body.presenting #doc-tags {
      display: none;
    }

    body.presenting main {
      display: block;
      min-height: 100vh;
    }

    body.presenting .document {
      max-height: none;
      min-height: 100vh;
      padding: 8px clamp(24px, 7vw, 96px) 64px;
    }

    body.presenting .markdown {
      max-width: 1100px;
      margin: 0 auto;
    }

    body.presenting .markdown > :first-child {
      margin-top: 0;
    }

    body.presenting .present-controls select,
    body.presenting .present-controls .page-controls {
      display: flex;
    }

    .results {
      border-right: 1px solid var(--dashboard-border);
      overflow: auto;
      max-height: calc(100vh - 97px);
    }

    .result {
      display: block;
      width: 100%;
      padding: 10px 12px;
      border: 0;
      border-bottom: 1px solid var(--dashboard-border-muted);
      border-radius: 0;
      background: transparent;
      text-align: left;
    }

    .result:hover {
      background: var(--dashboard-hover-bg);
    }

    .result.active {
      background: var(--dashboard-active-bg);
      box-shadow: inset 3px 0 0 var(--dashboard-active-border);
    }

    .result-title {
      display: block;
      font-weight: var(--font-weight-semibold, 600);
      margin-bottom: 2px;
    }

    .result-path,
    .meta,
    .empty {
      color: var(--dashboard-muted);
      font-size: 12px;
      line-height: 18px;
    }

    .snippet {
      display: -webkit-box;
      max-height: 34px;
      margin-top: 4px;
      overflow: hidden;
      color: var(--dashboard-muted);
      font-size: 12px;
      line-height: 17px;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }

    mark {
      padding: 0.05em 0.18em;
      border-radius: 3px;
      background: var(--dashboard-mark-bg);
      color: var(--dashboard-mark-text);
      font-weight: var(--font-weight-semibold, 600);
    }

    .document {
      min-width: 0;
      padding: 18px 22px 32px;
      overflow: auto;
      max-height: calc(100vh - 97px);
    }

    .document h2 {
      margin: 0 0 4px;
      font-size: 20px;
      line-height: 26px;
    }

    .markdown {
      max-width: 900px;
    }

    .markdown h1,
    .markdown h2,
    .markdown h3 {
      margin-top: 1.35em;
      margin-bottom: 0.45em;
      line-height: 1.25;
    }

    .markdown p,
    .markdown ul,
    .markdown ol,
    .markdown pre,
    .markdown .table-wrapper,
    .markdown .admonition,
    .markdown hr,
    .markdown blockquote {
      margin-top: 0;
      margin-bottom: 12px;
    }

    .markdown hr {
      height: 0;
      border: 0;
      border-top: 2px solid var(--dashboard-hr);
      background: transparent;
      margin: 24px 0;
    }

    .markdown code {
      font-family: var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace);
      font-size: var(--text-code-inline, 12px);
      background: var(--dashboard-code-bg);
      border: 1px solid var(--dashboard-code-border);
      border-radius: 4px;
      padding: 0.15em 0.3em;
    }

    .markdown pre {
      padding: 12px;
      overflow: auto;
      border-radius: 8px;
      background: var(--dashboard-code-bg);
      border: 1px solid var(--dashboard-code-border);
    }

    .markdown pre code {
      padding: 0;
      background: transparent;
      border: 0;
    }

    .markdown ul,
    .markdown ol {
      padding-left: 24px;
    }

    .markdown li > ul,
    .markdown li > ol {
      margin-top: 4px;
      margin-bottom: 4px;
    }

    .markdown li.task-list-item {
      list-style: none;
      margin-left: -20px;
    }

    .markdown .task-list-item-checkbox {
      width: 14px;
      height: 14px;
      margin: 0 7px 0 0;
      vertical-align: -2px;
      accent-color: var(--dashboard-active-border);
    }

    .markdown .table-wrapper {
      max-width: 100%;
      overflow: visible;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-surface);
    }

    .markdown table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      font-size: 13px;
    }

    .markdown th,
    .markdown td {
      padding: 8px 10px;
      border-right: 1px solid var(--dashboard-border-muted);
      border-bottom: 1px solid var(--dashboard-border-muted);
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .markdown th a,
    .markdown td a,
    .markdown th code,
    .markdown td code {
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .markdown th {
      background: var(--dashboard-button-bg);
      font-weight: var(--font-weight-semibold, 600);
    }

    .markdown tr:last-child td {
      border-bottom: 0;
    }

    .markdown th:last-child,
    .markdown td:last-child {
      border-right: 0;
    }

    .markdown img,
    .doc-image {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 12px 0;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-surface);
    }

    .svg-block,
    .mermaid-block {
      max-width: 100%;
      margin: 12px 0;
      padding: 12px;
      overflow: auto;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-surface);
    }

    .svg-block svg,
    .mermaid-block svg {
      display: block;
      max-width: 100%;
      height: auto;
    }

    .mermaid-error {
      margin: 12px 0;
      padding: 10px 12px;
      border: 1px solid var(--dashboard-border);
      border-radius: 8px;
      background: var(--dashboard-code-bg);
      color: var(--dashboard-muted);
      white-space: pre-wrap;
    }

    .markdown blockquote {
      padding-left: 12px;
      border-left: 3px solid var(--dashboard-border);
      color: var(--dashboard-muted);
    }

    .markdown .admonition {
      padding: 10px 12px;
      border: 1px solid var(--dashboard-border);
      border-left: 4px solid var(--dashboard-active-border);
      border-radius: 8px;
      background: var(--dashboard-surface);
    }

    .markdown .admonition-title,
    .markdown summary.admonition-title {
      margin: 0 0 8px;
      color: var(--dashboard-text);
      font-weight: var(--font-weight-semibold, 600);
      cursor: default;
    }

    .markdown details.admonition > summary.admonition-title {
      cursor: pointer;
    }

    .markdown .admonition-content > :last-child {
      margin-bottom: 0;
    }

    .markdown a {
      color: var(--dashboard-link);
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 14px;
    }

    .pill {
      display: inline-block;
      margin: 4px 4px 0 0;
      padding: 2px 6px;
      border: 1px solid var(--dashboard-border);
      border-radius: 999px;
      background: var(--dashboard-surface);
      color: var(--dashboard-muted);
      font-size: 12px;
    }

    @media (max-width: 760px) {
      main {
        grid-template-columns: 1fr;
      }

      .results {
        max-height: 42vh;
        border-right: 0;
        border-bottom: 1px solid var(--dashboard-border);
      }

      .document {
        max-height: none;
      }
    }
  </style>
</head>
<body>
  <div class="present-controls" aria-label="Presentation controls">
    <button id="theme-toggle" type="button" title="Toggle light/dark theme">Dark</button>
    <button id="present-toggle" type="button" aria-pressed="false" title="Toggle present mode">Present</button>
    <select id="paginate-level" title="Paginate by header level" aria-label="Paginate by header level">
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="3">3</option>
      <option value="4">4</option>
      <option value="5">5</option>
      <option value="6">6</option>
      <option value="---">---</option>
    </select>
    <span class="page-controls">
      <button id="prev-page" type="button" title="Previous page">Prev</button>
      <span id="page-indicator" class="page-indicator">1 / 1</span>
      <button id="next-page" type="button" title="Next page">Next</button>
    </span>
  </div>
  <header>
    <h1>KPE document dashboard</h1>
    <div class="search-row">
      <select id="repo-select" class="repo-select" aria-label="Content repository"></select>
      <input id="search" type="search" placeholder="Search title, path, content, or tag:KT..." autocomplete="off" />
      <button id="refresh" type="button">Refresh</button>
      <button id="share-link" type="button">Share</button>
    </div>
    <div id="status" class="meta">Indexing ${escapeHtml(initialRepoSlug)}...</div>
  </header>
  <main>
    <section id="results" class="results" aria-label="Search results"></section>
    <section class="document" aria-label="Document">
      <div class="toolbar">
        <div>
          <h2 id="doc-title">Select a document</h2>
          <div id="doc-path" class="meta"></div>
        </div>
      </div>
      <div id="doc-tags"></div>
      <article id="doc-content" class="markdown empty">Search results will appear on the left. Choose a result to view its markdown here.</article>
    </section>
  </main>
  <script>
    const searchInput = document.getElementById("search");
    const refreshButton = document.getElementById("refresh");
    const resultsElement = document.getElementById("results");
    const statusElement = document.getElementById("status");
    const docTitle = document.getElementById("doc-title");
    const docPath = document.getElementById("doc-path");
    const docTags = document.getElementById("doc-tags");
    const docContent = document.getElementById("doc-content");
    const themeToggle = document.getElementById("theme-toggle");
    const presentToggle = document.getElementById("present-toggle");
    const paginateLevel = document.getElementById("paginate-level");
    const prevPage = document.getElementById("prev-page");
    const nextPage = document.getElementById("next-page");
    const pageIndicator = document.getElementById("page-indicator");
    const repoSelect = document.getElementById("repo-select");
    const shareButton = document.getElementById("share-link");
    const repos = ${JSON.stringify(repos)};
    const initialRepoSlug = ${JSON.stringify(initialRepoSlug)};
    const initialDocPath = ${JSON.stringify(initialDocPath)};
    const initialPresentMode = ${JSON.stringify(initialPresentMode)};
    let activeRepo = initialRepoSlug;
    let activePath = initialDocPath;
    let searchTimer;
    let highlightTokens = [];
    let currentDocPath = "";
    let currentDocument = null;
    let currentPages = [{ title: "Document", content: "" }];
    let currentPageIndex = 0;
    let wheelPageDelta = 0;
    let lastWheelPageTurn = 0;
    let mermaidModulePromise = null;
    const themeStorageKey = "kpe-doc-dashboard-theme";
    const dashboardThemes = ["light", "sepia", "spring", "ocean", "forest", "autumn", "night"];
    const dashboardThemeMeta = {
      light: { label: "Light", mode: "light" },
      sepia: { label: "Sepia", mode: "light" },
      spring: { label: "Spring", mode: "light" },
      ocean: { label: "Ocean", mode: "dark" },
      forest: { label: "Forest", mode: "dark" },
      autumn: { label: "Autumn", mode: "dark" },
      night: { label: "Night", mode: "dark" },
    };
    const wheelPageThreshold = 90;
    const wheelPageCooldownMs = 650;

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function escapeRegExp(value) {
      return value.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&");
    }

    function highlightText(value) {
      const text = String(value);
      if (!highlightTokens.length) {
        return escapeHtml(text);
      }

      const pattern = new RegExp("(" + highlightTokens.map(escapeRegExp).join("|") + ")", "ig");
      return text
        .split(pattern)
        .map((part) => {
          const isMatch = highlightTokens.some((token) => part.toLowerCase() === token);
          return isMatch ? "<mark>" + escapeHtml(part) + "</mark>" : escapeHtml(part);
        })
        .join("");
    }

    function displayResultPath(value) {
      const parts = String(value).split("/").filter(Boolean);
      const directoryParts = parts.slice(0, -1);
      return directoryParts.length ? directoryParts.join("/") : "Repository root";
    }

    function hasHiddenHeadingForToc(value) {
      return /(?:^|\\s)\\{[^}]*\\.hidden-heading-for-toc[^}]*\\}\\s*$/.test(String(value || ""));
    }

    function repoLabel(slug) {
      const repo = repos.find((candidate) => candidate.slug === slug);
      return repo ? repo.label : slug;
    }

    function repoPathPrefix(slug = activeRepo) {
      return "/" + encodeURIComponent(slug);
    }

    function encodeDocumentPath(value) {
      return String(value ?? "")
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    }

    function documentUrl(path, slug = activeRepo) {
      const encodedPath = encodeDocumentPath(path);
      return window.location.origin + repoPathPrefix(slug) + (encodedPath ? "/" + encodedPath : "");
    }

    function apiUrl(path, params = {}) {
      const search = new URLSearchParams({ repo: activeRepo, ...params });
      return path + "?" + search.toString();
    }

    function getStoredTheme() {
      try {
        return localStorage.getItem(themeStorageKey);
      } catch {
        return null;
      }
    }

    function storeTheme(theme) {
      try {
        localStorage.setItem(themeStorageKey, theme);
      } catch {
      }
    }

    function getInitialTheme() {
      const stored = getStoredTheme();
      const storedTheme = normalizeTheme(stored);
      if (storedTheme) {
        return storedTheme;
      }

      const hostTheme =
        document.documentElement.getAttribute("data-color-mode") ||
        document.body.getAttribute("data-color-mode") ||
        document.documentElement.getAttribute("data-visual-mode") ||
        document.body.getAttribute("data-visual-mode");
      if (hostTheme === "dark") {
        return "ocean";
      }
      if (hostTheme === "light") {
        return "light";
      }

      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "ocean" : "light";
    }

    function normalizeTheme(theme) {
      if (theme === "dark") {
        return "ocean";
      }
      return dashboardThemes.includes(theme) ? theme : null;
    }

    function getNextTheme(theme) {
      const currentIndex = dashboardThemes.indexOf(normalizeTheme(theme) || "light");
      return dashboardThemes[(currentIndex + 1) % dashboardThemes.length];
    }

    function applyTheme(theme) {
      const normalizedTheme = normalizeTheme(theme) || "light";
      const meta = dashboardThemeMeta[normalizedTheme];
      const mode = meta.mode;
      document.documentElement.setAttribute("data-color-mode", mode);
      document.body.setAttribute("data-color-mode", mode);
      document.documentElement.setAttribute("data-visual-mode", mode);
      document.body.setAttribute("data-visual-mode", mode);
      document.documentElement.setAttribute("data-dashboard-theme", normalizedTheme);
      document.body.setAttribute("data-dashboard-theme", normalizedTheme);
      document.documentElement.style.colorScheme = mode;
      const nextTheme = getNextTheme(normalizedTheme);
      themeToggle.textContent = meta.label;
      themeToggle.title = "Next theme: " + dashboardThemeMeta[nextTheme].label;
      themeToggle.setAttribute("aria-label", themeToggle.title);
      storeTheme(normalizedTheme);
    }

    function isExternalAsset(value) {
      return /^(?:https?:|data:image\\/|blob:|#)/i.test(String(value || "").trim());
    }

    function parseImageDestination(value) {
      let destination = String(value || "").trim();
      if (destination.startsWith("<") && destination.includes(">")) {
        destination = destination.slice(1, destination.indexOf(">"));
      } else {
        const titled = destination.match(/^(.+?)\\s+["'][^"']+["']$/);
        if (titled) {
          destination = titled[1];
        }
      }

      return destination.trim();
    }

    function resolveAssetUrl(src, docPath = currentDocPath) {
      const destination = parseImageDestination(src);
      if (!destination) {
        return "";
      }

      if (isExternalAsset(destination)) {
        return destination;
      }

      return apiUrl("/asset", { doc: docPath, src: destination });
    }

    function isExternalLink(value) {
      return /^(?:https?:|mailto:|tel:|#)/i.test(String(value || "").trim());
    }

    function parseLinkDestination(value) {
      return parseImageDestination(value);
    }

    function normalizeRelativePath(basePath, destination) {
      const normalizedDestination = destination.replace(/\\\\/g, "/");
      const baseParts = String(basePath || "").split("/").filter(Boolean);
      baseParts.pop();
      const parts = normalizedDestination.startsWith("/") ? [] : baseParts;
      for (const part of normalizedDestination.split("/")) {
        if (!part || part === ".") {
          continue;
        }
        if (part === "..") {
          parts.pop();
          continue;
        }
        parts.push(part);
      }
      return parts.join("/");
    }

    function linkHtml(label, destination) {
      const parsedDestination = parseLinkDestination(destination);
      const renderedLabel = inlineMarkdown(label);
      if (!parsedDestination) {
        return renderedLabel;
      }

      if (isExternalLink(parsedDestination)) {
        const target = /^https?:/i.test(parsedDestination) ? ' target="_blank" rel="noreferrer"' : "";
        return '<a href="' + escapeHtml(parsedDestination) + '"' + target + ">" + renderedLabel + "</a>";
      }

      const hashIndex = parsedDestination.indexOf("#");
      const pathPart = hashIndex >= 0 ? parsedDestination.slice(0, hashIndex) : parsedDestination;
      const hashPart = hashIndex >= 0 ? parsedDestination.slice(hashIndex + 1) : "";
      const targetPath = pathPart ? normalizeRelativePath(currentDocPath, pathPart) : currentDocPath;
      if (/\\.md$/i.test(pathPart) || (!pathPart && hashPart)) {
        return '<a href="' + escapeHtml(documentUrl(targetPath)) + '" data-doc-link="' + escapeHtml(targetPath) + '" data-doc-hash="' + escapeHtml(hashPart) + '">' + renderedLabel + "</a>";
      }

      return '<a href="' + escapeHtml(resolveAssetUrl(parsedDestination)) + '" target="_blank" rel="noreferrer">' + renderedLabel + "</a>";
    }

    function autoLinkBareUrls(html) {
      return html.replace(/(^|[\\s(])((?:https?:\\/\\/|www\\.)[^\\s<]+[^\\s<.,:;!?)\\]])/g, (match, prefix, url) => {
        const href = url.startsWith("www.") ? "https://" + url : url;
        return prefix + '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + url + "</a>";
      });
    }

    function imageHtml(src, alt = "") {
      const resolved = resolveAssetUrl(src);
      if (!resolved) {
        return "";
      }

      return '<img class="doc-image" loading="lazy" src="' + escapeHtml(resolved) + '" alt="' + escapeHtml(alt || src) + '">';
    }

    function sanitizeSvgMarkup(markup) {
      const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
      if (parsed.querySelector("parsererror")) {
        return "<pre><code>" + escapeHtml(markup) + "</code></pre>";
      }

      parsed.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((node) => node.remove());
      parsed.querySelectorAll("*").forEach((node) => {
        for (const attribute of Array.from(node.attributes)) {
          const name = attribute.name.toLowerCase();
          const value = attribute.value.trim();
          if (name.startsWith("on") || (/^(?:href|xlink:href|src)$/.test(name) && /^javascript:/i.test(value))) {
            node.removeAttribute(attribute.name);
          }
        }
      });

      const svg = parsed.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== "svg") {
        return "<pre><code>" + escapeHtml(markup) + "</code></pre>";
      }

      return '<div class="svg-block">' + new XMLSerializer().serializeToString(svg) + "</div>";
    }

    function sanitizeHtmlFragment(markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      const rendered = [];

      for (const node of Array.from(template.content.childNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "img") {
          rendered.push(imageHtml(node.getAttribute("src") || "", node.getAttribute("alt") || ""));
        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === "svg") {
          rendered.push(sanitizeSvgMarkup(node.outerHTML));
        } else if (node.textContent && node.textContent.trim()) {
          rendered.push(escapeHtml(node.textContent));
        }
      }

      return rendered.join("");
    }

    function inlineMarkdown(value) {
      const replacements = [];
      let text = String(value)
        .replace(/\\\`([^\\\`]+)\\\`/g, (match, code) => {
          const token = "\\u0000INLINE" + replacements.length + "\\u0000";
          replacements.push("<code>" + escapeHtml(code) + "</code>");
          return token;
        })
        .replace(/<img\\b[^>]*>/gi, (match) => {
          const token = "\\u0000INLINE" + replacements.length + "\\u0000";
          replacements.push(sanitizeHtmlFragment(match));
          return token;
        })
        .replace(/!\\[\\[([^\\]|]+)(?:\\|[^\\]]+)?\\]\\]/g, (match, src) => {
          const token = "\\u0000INLINE" + replacements.length + "\\u0000";
          replacements.push(imageHtml(src, src));
          return token;
        })
        .replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, (match, alt, src) => {
          const token = "\\u0000INLINE" + replacements.length + "\\u0000";
          replacements.push(imageHtml(src, alt));
          return token;
        })
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (match, label, destination) => {
          const token = "\\u0000INLINE" + replacements.length + "\\u0000";
          replacements.push(linkHtml(label, destination));
          return token;
        });

      text = escapeHtml(text)
        .replace(/\\*\\*([^\\n]+?)\\*\\*/g, "<strong>$1</strong>")
        .replace(/__([^\\n]+?)__/g, "<strong>$1</strong>")
        .replace(/~~([^\\n]+?)~~/g, "<del>$1</del>")
        .replace(/(^|[^\\*])\\*([^\\s\\*][^\\*\\n]*?)\\*(?!\\*)/g, "$1<em>$2</em>")
        .replace(/(^|[^\\w_])_([^_\\n]+?)_(?![\\w_])/g, "$1<em>$2</em>");

      text = autoLinkBareUrls(text);

      replacements.forEach((replacement, index) => {
        text = text.replace("\\u0000INLINE" + index + "\\u0000", replacement);
      });

      return text;
    }

    function stripFrontmatterFromMarkdown(markdown) {
      return String(markdown || "").replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/, "");
    }

    function splitTableRow(line) {
      let body = String(line || "").trim();
      if (body.startsWith("|")) {
        body = body.slice(1);
      }
      if (body.endsWith("|") && !body.endsWith("\\\\|")) {
        body = body.slice(0, -1);
      }

      const cells = [];
      let current = "";
      let inCode = false;
      for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        const next = body[index + 1] || "";
        if (char === "\\\\" && next === "|") {
          current += "|";
          index += 1;
          continue;
        }
        if (char === "\\x60") {
          inCode = !inCode;
          current += char;
          continue;
        }
        if (char === "|" && !inCode) {
          cells.push(current.trim());
          current = "";
          continue;
        }
        current += char;
      }

      cells.push(current.trim());
      return cells;
    }

    function isTableRowLine(line) {
      const trimmed = String(line || "").trim();
      return trimmed.includes("|") && !/^(?:-{3,}|\\*{3,}|_{3,})$/.test(trimmed);
    }

    function isTableDividerLine(line) {
      const cells = splitTableRow(line);
      return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }

    function tableAlignments(line) {
      return splitTableRow(line).map((cell) => {
        if (/^:-+:$/.test(cell)) {
          return "center";
        }
        if (/^-+:$/.test(cell)) {
          return "right";
        }
        if (/^:-+$/.test(cell)) {
          return "left";
        }
        return "";
      });
    }

    function normalizeTableCells(cells, count) {
      const normalized = cells.slice(0, count);
      while (normalized.length < count) {
        normalized.push("");
      }
      return normalized;
    }

    function renderTableRow(cells, cellTag, alignments) {
      return "<tr>" + cells.map((cell, index) => {
        const alignment = alignments[index];
        const style = alignment ? ' style="text-align:' + alignment + '"' : "";
        return "<" + cellTag + style + ">" + inlineMarkdown(cell) + "</" + cellTag + ">";
      }).join("") + "</tr>";
    }

    function renderTable(headerLine, dividerLine, rowLines) {
      const headerCells = splitTableRow(headerLine);
      const alignments = tableAlignments(dividerLine);
      const cellCount = headerCells.length;
      const bodyRows = rowLines
        .map((rowLine) => normalizeTableCells(splitTableRow(rowLine), cellCount))
        .map((cells) => renderTableRow(cells, "td", alignments))
        .join("");

      return '<div class="table-wrapper"><table><thead>' +
        renderTableRow(normalizeTableCells(headerCells, cellCount), "th", alignments) +
        "</thead><tbody>" + bodyRows + "</tbody></table></div>";
    }

    function indentWidth(value) {
      return String(value || "").replace(/\\t/g, "    ").length;
    }

    function getListItem(line) {
      const match = String(line || "").match(/^(\\s*)(?:(\\d+)[.)]|([-*+]))\\s+(.+)$/);
      if (!match) {
        return null;
      }

      let content = match[4];
      const task = content.match(/^\\[([ xX])\\]\\s+(.+)$/);
      return {
        indent: indentWidth(match[1]),
        type: match[2] ? "ol" : "ul",
        content: task ? task[2] : content,
        isTask: Boolean(task),
        checked: task ? task[1].toLowerCase() === "x" : false,
      };
    }

    function renderListBlock(lines) {
      function continuationText(line, parentIndent) {
        const source = String(line || "");
        const leading = source.match(/^\\s*/)?.[0] || "";
        const removeCount = Math.min(source.length, leading.length, parentIndent + 2);
        return source.slice(removeCount);
      }

      function parseList(startIndex, indent) {
        const firstItem = getListItem(lines[startIndex]);
        const listType = firstItem.type;
        let html = "<" + listType + ">";
        let index = startIndex;

        while (index < lines.length) {
          const item = getListItem(lines[index]);
          if (!item || item.indent < indent || item.type !== listType) {
            break;
          }

          if (item.indent > indent) {
            const nested = parseList(index, item.indent);
            html += nested.html;
            index = nested.nextIndex;
            continue;
          }

          const checkbox = item.isTask
            ? '<input class="task-list-item-checkbox" type="checkbox" disabled' + (item.checked ? " checked" : "") + "> "
            : "";
          html += '<li' + (item.isTask ? ' class="task-list-item"' : "") + ">" + checkbox + inlineMarkdown(item.content);
          index += 1;

          const continuation = [];
          while (index < lines.length) {
            const nextItem = getListItem(lines[index]);
            if (nextItem) {
              if (nextItem.indent > indent) {
                if (continuation.length) {
                  html += renderMarkdown(continuation.join("\\n"), currentDocPath);
                  continuation.length = 0;
                }
                const nested = parseList(index, nextItem.indent);
                html += nested.html;
                index = nested.nextIndex;
                continue;
              }
              break;
            }

            if (!lines[index].trim()) {
              index += 1;
              continue;
            }

            const leading = lines[index].match(/^\\s*/)?.[0] || "";
            if (indentWidth(leading) > indent) {
              continuation.push(continuationText(lines[index], indent));
              index += 1;
              continue;
            }

            break;
          }

          if (continuation.length) {
            html += renderMarkdown(continuation.join("\\n"), currentDocPath);
          }
          html += "</li>";
        }

        html += "</" + listType + ">";
        return { html, nextIndex: index };
      }

      let index = 0;
      let html = "";
      while (index < lines.length) {
        const item = getListItem(lines[index]);
        if (!item) {
          index += 1;
          continue;
        }
        const parsed = parseList(index, item.indent);
        html += parsed.html;
        index = parsed.nextIndex;
      }
      return html;
    }

    function isIndentedCodeLine(line) {
      return /^(?: {4}|\\t)/.test(String(line || ""));
    }

    function stripCodeIndent(line) {
      return String(line || "").replace(/^(?: {4}|\\t)/, "");
    }

    function renderAdmonition(marker, type, title, contentLines) {
      const normalizedType = String(type || "note").toLowerCase();
      const label = title || normalizedType.replace(/-/g, " ").replace(/^./, (char) => char.toUpperCase());
      const body = '<div class="admonition-content">' + renderMarkdown(contentLines.join("\\n"), currentDocPath) + "</div>";
      if (marker.startsWith("???")) {
        return '<details class="admonition admonition-' + escapeHtml(normalizedType) + '"><summary class="admonition-title">' + inlineMarkdown(label) + "</summary>" + body + "</details>";
      }

      return '<div class="admonition admonition-' + escapeHtml(normalizedType) + '"><p class="admonition-title">' + inlineMarkdown(label) + "</p>" + body + "</div>";
    }

    function renderMarkdown(markdown, docPath) {
      currentDocPath = docPath;
      const lines = markdown.replace(/\\r\\n/g, "\\n").split("\\n");
      const html = [];
      let inCode = false;
      let codeLanguage = "";
      let codeLines = [];
      let inSvg = false;
      let svgLines = [];
      let listType = null;
      let paragraph = [];

      function flushParagraph() {
        if (paragraph.length) {
          html.push("<p>" + inlineMarkdown(paragraph.join(" ")) + "</p>");
          paragraph = [];
        }
      }

      function closeList() {
        if (listType) {
          html.push("</" + listType + ">");
          listType = null;
        }
      }

      function flushCodeBlock() {
        const code = codeLines.join("\\n");
        if (codeLanguage.toLowerCase() === "mermaid") {
          html.push('<div class="mermaid-block"><div class="mermaid">' + escapeHtml(code) + "</div></div>");
        } else {
          html.push("<pre><code>" + escapeHtml(code) + "</code></pre>");
        }

        codeLines = [];
        codeLanguage = "";
      }

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (inSvg) {
          svgLines.push(line);
          if (line.toLowerCase().includes("</svg>")) {
            html.push(sanitizeSvgMarkup(svgLines.join("\\n")));
            svgLines = [];
            inSvg = false;
          }
          continue;
        }

        if (line.startsWith("\\x60\\x60\\x60") || line.startsWith("~~~")) {
          flushParagraph();
          closeList();
          if (inCode) {
            flushCodeBlock();
            inCode = false;
          } else {
            codeLanguage = line.replace(/^\\x60\\x60\\x60|^~~~/, "").trim().split(/\\s+/)[0] || "";
            codeLines = [];
            inCode = true;
          }
          continue;
        }

        if (inCode) {
          codeLines.push(line);
          continue;
        }

        if (!line.trim()) {
          flushParagraph();
          closeList();
          continue;
        }

        const trimmed = line.trim();
        const nextLine = lines[lineIndex + 1] || "";

        const admonition = trimmed.match(/^(!!!|\\?\\?\\?)\\+?\\s+([A-Za-z0-9_-]+)(?:\\s+["'](.+)["'])?\\s*$/);
        if (admonition) {
          const contentLines = [];
          let cursor = lineIndex + 1;
          while (cursor < lines.length) {
            if (!lines[cursor].trim()) {
              contentLines.push("");
              cursor += 1;
              continue;
            }
            if (isIndentedCodeLine(lines[cursor])) {
              contentLines.push(stripCodeIndent(lines[cursor]));
              cursor += 1;
              continue;
            }
            break;
          }
          lineIndex = cursor - 1;
          flushParagraph();
          closeList();
          html.push(renderAdmonition(admonition[1], admonition[2], admonition[3] || "", contentLines));
          continue;
        }

        if (/^\\s*>/.test(line)) {
          const quoteLines = [];
          let cursor = lineIndex;
          while (cursor < lines.length && /^\\s*>/.test(lines[cursor])) {
            quoteLines.push(lines[cursor].replace(/^\\s*> ?/, ""));
            cursor += 1;
          }
          lineIndex = cursor - 1;
          flushParagraph();
          closeList();
          html.push("<blockquote>" + renderMarkdown(quoteLines.join("\\n"), docPath) + "</blockquote>");
          continue;
        }

        if (getListItem(line)) {
          const listLines = [];
          let cursor = lineIndex;
          while (cursor < lines.length) {
            if (getListItem(lines[cursor]) || !lines[cursor].trim() || /^\\s{2,}\\S/.test(lines[cursor]) || /^\\t\\S/.test(lines[cursor])) {
              listLines.push(lines[cursor]);
              cursor += 1;
              continue;
            }
            break;
          }
          lineIndex = cursor - 1;
          flushParagraph();
          closeList();
          html.push(renderListBlock(listLines));
          continue;
        }

        if (isIndentedCodeLine(line)) {
          const indentedCodeLines = [];
          let cursor = lineIndex;
          while (cursor < lines.length && (isIndentedCodeLine(lines[cursor]) || !lines[cursor].trim())) {
            indentedCodeLines.push(lines[cursor].trim() ? stripCodeIndent(lines[cursor]) : "");
            cursor += 1;
          }
          lineIndex = cursor - 1;
          flushParagraph();
          closeList();
          html.push("<pre><code>" + escapeHtml(indentedCodeLines.join("\\n")) + "</code></pre>");
          continue;
        }

        if (isTableRowLine(line) && isTableDividerLine(nextLine) && splitTableRow(line).length === splitTableRow(nextLine).length) {
          const tableRows = [];
          lineIndex += 2;
          while (lineIndex < lines.length && isTableRowLine(lines[lineIndex])) {
            tableRows.push(lines[lineIndex]);
            lineIndex += 1;
          }
          lineIndex -= 1;
          flushParagraph();
          closeList();
          html.push(renderTable(line, nextLine, tableRows));
          continue;
        }

        if (/^(?:-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) {
          flushParagraph();
          closeList();
          html.push("<hr>");
          continue;
        }

        if (/^<svg[\\s>]/i.test(trimmed)) {
          flushParagraph();
          closeList();
          svgLines = [line];
          if (line.toLowerCase().includes("</svg>")) {
            html.push(sanitizeSvgMarkup(svgLines.join("\\n")));
            svgLines = [];
          } else {
            inSvg = true;
          }
          continue;
        }

        if (/^<img[\\s>]/i.test(trimmed)) {
          flushParagraph();
          closeList();
          html.push(sanitizeHtmlFragment(line));
          continue;
        }

        const standaloneImage = trimmed.match(/^!\\[\\[([^\\]|]+)(?:\\|[^\\]]+)?\\]\\]$/) || trimmed.match(/^!\\[([^\\]]*)\\]\\(([^)]+)\\)$/);
        if (standaloneImage) {
          flushParagraph();
          closeList();
          html.push("<p>" + inlineMarkdown(trimmed) + "</p>");
          continue;
        }

        const heading = line.match(/^(#{1,6})\\s+(.+)$/);
        if (heading) {
          flushParagraph();
          closeList();
          if (hasHiddenHeadingForToc(heading[2])) {
            continue;
          }
          const level = heading[1].length;
          html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
          continue;
        }

        const unordered = line.match(/^\\s*[-*]\\s+(.+)$/);
        if (unordered) {
          flushParagraph();
          if (listType !== "ul") {
            closeList();
            html.push("<ul>");
            listType = "ul";
          }
          html.push("<li>" + inlineMarkdown(unordered[1]) + "</li>");
          continue;
        }

        const ordered = line.match(/^\\s*\\d+\\.\\s+(.+)$/);
        if (ordered) {
          flushParagraph();
          if (listType !== "ol") {
            closeList();
            html.push("<ol>");
            listType = "ol";
          }
          html.push("<li>" + inlineMarkdown(ordered[1]) + "</li>");
          continue;
        }

        const quote = line.match(/^>\\s?(.+)$/);
        if (quote) {
          flushParagraph();
          closeList();
          html.push("<blockquote>" + inlineMarkdown(quote[1]) + "</blockquote>");
          continue;
        }

        closeList();
        paragraph.push(line.trim());
      }

      flushParagraph();
      closeList();
      if (inCode) {
        flushCodeBlock();
      }
      if (inSvg) {
        html.push(sanitizeSvgMarkup(svgLines.join("\\n")));
      }

      return html.join("\\n");
    }

    async function renderMermaidDiagrams() {
      const diagrams = Array.from(docContent.querySelectorAll(".mermaid"));
      if (!diagrams.length) {
        return;
      }

      try {
        if (!mermaidModulePromise) {
          mermaidModulePromise = import("/vendor/mermaid.esm.min.mjs");
        }
        const module = await mermaidModulePromise;
        const mermaid = module.default || module;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.getAttribute("data-color-mode") === "dark" || document.body.getAttribute("data-color-mode") === "dark" ? "dark" : "default",
        });
        await mermaid.run({ nodes: diagrams });
      } catch (error) {
        for (const diagram of diagrams) {
          const source = diagram.textContent || "";
          diagram.outerHTML = '<div class="mermaid-error">Mermaid render failed: ' + escapeHtml(error.message || String(error)) + "\\n\\n" + escapeHtml(source) + "</div>";
        }
      }
    }

    function getDocumentPages(markdown, level) {
      if (String(level) === "---") {
        const lines = markdown.replace(/\\r\\n/g, "\\n").split("\\n");
        const pages = [];
        let currentLines = [];
        let pageNumber = 1;
        let inCode = false;

        for (const line of lines) {
          if (line.startsWith("\\x60\\x60\\x60") || line.startsWith("~~~")) {
            inCode = !inCode;
            currentLines.push(line);
            continue;
          }

          if (!inCode && /^(?:-{3,}|\\*{3,}|_{3,})$/.test(line.trim())) {
            if (currentLines.some((candidate) => candidate.trim())) {
              pages.push({ title: "Page " + pageNumber, content: currentLines.join("\\n") });
              pageNumber += 1;
            }
            currentLines = [];
            continue;
          }

          currentLines.push(line);
        }

        if (currentLines.some((candidate) => candidate.trim())) {
          pages.push({ title: "Page " + pageNumber, content: currentLines.join("\\n") });
        }

        return pages.length ? pages : [{ title: "Whole document", content: markdown }];
      }

      const headerLevel = Number(level);
      if (!Number.isInteger(headerLevel) || headerLevel <= 1) {
        return [{ title: "Whole document", content: markdown }];
      }

      const lines = markdown.replace(/\\r\\n/g, "\\n").split("\\n");
      const headingPattern = new RegExp("^#{" + headerLevel + "}\\\\s+(.+)$");
      const pages = [];
      let currentLines = [];
      let currentTitle = "Intro";

      for (const line of lines) {
        const heading = line.match(headingPattern);
        if (heading && currentLines.some((candidate) => candidate.trim())) {
          pages.push({ title: currentTitle, content: currentLines.join("\\n") });
          currentLines = [line];
          currentTitle = heading[1].trim();
          continue;
        }

        if (heading && !currentLines.some((candidate) => candidate.trim())) {
          currentTitle = heading[1].trim();
        }

        currentLines.push(line);
      }

      if (currentLines.some((candidate) => candidate.trim())) {
        pages.push({ title: currentTitle, content: currentLines.join("\\n") });
      }

      return pages.length ? pages : [{ title: "Whole document", content: markdown }];
    }

    function updatePresentationControls() {
      const isPresenting = document.body.classList.contains("presenting");
      presentToggle.textContent = isPresenting ? "Exit" : "Present";
      presentToggle.setAttribute("aria-pressed", String(isPresenting));
      pageIndicator.textContent = (currentPageIndex + 1) + " / " + currentPages.length;
      prevPage.disabled = currentPageIndex <= 0;
      nextPage.disabled = currentPageIndex >= currentPages.length - 1;
    }

    async function changePresentationPage(direction) {
      const nextIndex = Math.min(currentPages.length - 1, Math.max(0, currentPageIndex + direction));
      if (nextIndex === currentPageIndex) {
        return false;
      }

      currentPageIndex = nextIndex;
      await renderCurrentDocument();
      return true;
    }

    async function renderCurrentDocument() {
      if (!currentDocument) {
        currentPages = [{ title: "Document", content: "" }];
        currentPageIndex = 0;
        updatePresentationControls();
        return;
      }

      const isPresenting = document.body.classList.contains("presenting");
      const selectedLevel = isPresenting ? paginateLevel.value : "1";
      const renderableContent = stripFrontmatterFromMarkdown(currentDocument.content);
      currentPages = getDocumentPages(renderableContent, selectedLevel);
      currentPageIndex = Math.min(Math.max(currentPageIndex, 0), currentPages.length - 1);
      docContent.className = "markdown";
      docContent.innerHTML = renderMarkdown(currentPages[currentPageIndex].content, currentDocument.path);
      await renderMermaidDiagrams();
      updatePresentationControls();
    }

    async function requestJson(url, options) {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.statusText);
      }
      return data;
    }

    async function search() {
      const query = searchInput.value.trim();
      highlightTokens = query
        .toLowerCase()
        .split(/\\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1);
      statusElement.textContent = "Searching...";
      try {
        const data = await requestJson(apiUrl("/api/search", { q: query }));
        statusElement.textContent = data.count + " documents shown from " + data.total + " indexed markdown files in " + repoLabel(activeRepo);
        resultsElement.innerHTML = "";

        if (!data.results.length) {
          resultsElement.innerHTML = '<div class="empty" style="padding:12px;">No matching documents.</div>';
          return;
        }

        const previousActivePath = activePath;
        if (!activePath) {
          activePath = data.results[0].path;
        }

        for (const result of data.results) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "result" + (result.path === activePath ? " active" : "");
          button.innerHTML =
            '<span class="result-title">' + highlightText(result.title) + "</span>" +
            '<span class="result-path">' + highlightText(displayResultPath(result.path)) + "</span>" +
            (result.snippet ? '<div class="snippet">' + highlightText(result.snippet) + "</div>" : "");
          button.addEventListener("click", () => openDocument(result.path));
          resultsElement.appendChild(button);
        }

        if (activePath !== previousActivePath) {
          await openDocument(activePath, false);
        }
      } catch (error) {
        statusElement.textContent = "Search failed: " + error.message;
      }
    }

    async function openDocument(path, rerenderResults = true, options = {}) {
      activePath = path;
      docTitle.textContent = "Loading...";
      docPath.textContent = path;
      docTags.innerHTML = "";
      docContent.className = "markdown empty";
      docContent.textContent = "Loading document...";
      try {
        const doc = await requestJson(apiUrl("/api/doc", { path }));
        currentDocument = doc;
        currentPageIndex = 0;
        docTitle.textContent = doc.title;
        docPath.textContent = doc.path + " · " + new Date(doc.modified).toLocaleString();
        docTags.innerHTML = doc.tags.map((tag) => '<span class="pill">' + escapeHtml(tag) + "</span>").join("");
        if (options.presentMode) {
          document.body.classList.add("presenting");
          paginateLevel.value = "---";
        }
        await renderCurrentDocument();
        if (!options.skipHistory && window.history?.pushState) {
          window.history.pushState({ repo: activeRepo, path }, "", documentUrl(path));
        }
        if (rerenderResults) {
          await search();
        }
      } catch (error) {
        docTitle.textContent = "Could not load document";
        docContent.textContent = error.message;
      }
    }

    function populateRepoSelect() {
      repoSelect.innerHTML = repos
        .map((repo) => '<option value="' + escapeHtml(repo.slug) + '">' + escapeHtml(repo.label) + "</option>")
        .join("");
      repoSelect.value = activeRepo;
      repoSelect.hidden = repos.length <= 1;
    }

    async function copyShareLink() {
      if (!activePath) {
        statusElement.textContent = "Open a document before sharing a direct link.";
        return;
      }

      const link = documentUrl(activePath);
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(link);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = link;
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        statusElement.textContent = "Copied direct presentation link: " + link;
      } catch (error) {
        statusElement.textContent = "Copy failed. Direct link: " + link;
      }
    }

    function resetDocumentView() {
      activePath = "";
      currentDocPath = "";
      currentDocument = null;
      currentPages = [{ title: "Document", content: "" }];
      currentPageIndex = 0;
      docTitle.textContent = "Select a document";
      docPath.textContent = "";
      docTags.innerHTML = "";
      docContent.className = "markdown empty";
      docContent.textContent = "Search results will appear on the left. Choose a result to view its markdown here.";
      updatePresentationControls();
    }

    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, 180);
    });

    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      statusElement.textContent = "Pulling latest content and refreshing index...";
      try {
        const refresh = await requestJson(apiUrl("/api/refresh"), { method: "POST" });
        activePath = "";
        await search();
        if (refresh.git && !refresh.git.skipped) {
          statusElement.textContent = "Pulled latest content. " + refresh.total + " markdown files indexed.";
        }
      } catch (error) {
        statusElement.textContent = "Refresh failed: " + error.message;
      } finally {
        refreshButton.disabled = false;
      }
    });

    repoSelect.addEventListener("change", async () => {
      activeRepo = repoSelect.value;
      resetDocumentView();
      if (window.history?.pushState) {
        window.history.pushState({ repo: activeRepo, path: "" }, "", repoPathPrefix(activeRepo));
      }
      await search();
    });

    shareButton.addEventListener("click", copyShareLink);

    docContent.addEventListener("click", async (event) => {
      const link = event.target.closest("a[data-doc-link]");
      if (!link) {
        return;
      }
      event.preventDefault();
      await openDocument(link.getAttribute("data-doc-link"));
      const hash = link.getAttribute("data-doc-hash");
      if (hash) {
        document.getElementById(hash)?.scrollIntoView({ block: "start" });
      }
    });

    themeToggle.addEventListener("click", async () => {
      const currentTheme = document.documentElement.getAttribute("data-dashboard-theme") || getInitialTheme();
      applyTheme(getNextTheme(currentTheme));
      if (currentDocument) {
        await renderCurrentDocument();
      }
    });

    presentToggle.addEventListener("click", async () => {
      const isPresenting = document.body.classList.toggle("presenting");
      if (isPresenting) {
        paginateLevel.value = "---";
      }
      currentPageIndex = 0;
      wheelPageDelta = 0;
      await renderCurrentDocument();
    });

    paginateLevel.addEventListener("change", async () => {
      currentPageIndex = 0;
      await renderCurrentDocument();
    });

    prevPage.addEventListener("click", async () => {
      await changePresentationPage(-1);
    });

    nextPage.addEventListener("click", async () => {
      await changePresentationPage(1);
    });

    document.addEventListener("wheel", async (event) => {
      if (!document.body.classList.contains("presenting") || currentPages.length <= 1) {
        return;
      }

      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelPageTurn < wheelPageCooldownMs) {
        return;
      }

      wheelPageDelta += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (Math.abs(wheelPageDelta) < wheelPageThreshold) {
        return;
      }

      const direction = wheelPageDelta > 0 ? 1 : -1;
      wheelPageDelta = 0;
      if (await changePresentationPage(direction)) {
        lastWheelPageTurn = now;
      }
    }, { passive: false });

    async function initialize() {
      populateRepoSelect();
      applyTheme(getInitialTheme());
      updatePresentationControls();
      if (initialDocPath) {
        await openDocument(initialDocPath, false, { skipHistory: true, presentMode: initialPresentMode });
      }
      await search();
      searchInput.focus();
    }

    initialize();
  </script>
</body>
</html>`;
}

async function handleRequest(appState, req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    try {
        if (req.method === "GET" && url.pathname === "/favicon.ico") {
            res.writeHead(204, { "Cache-Control": "no-store" });
            res.end();
            return;
        }

        if (req.method === "GET" && url.pathname === "/") {
            sendHtml(res, renderHtml(appState));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/health") {
            const repos = appState.repos.map((repo) => {
                const state = requireRepoState(appState, repo.slug);
                return {
                    ...publicRepoConfig(repo),
                    repoPath: repo.path,
                    indexed: Boolean(state.index),
                    indexedAt: state.index?.indexedAt ?? null,
                    documents: state.index?.docs.length ?? 0,
                    error: state.error,
                };
            });
            sendJson(res, 200, {
                ok: true,
                defaultRepo: appState.defaultRepoSlug,
                repos,
            });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/repos") {
            sendJson(res, 200, {
                defaultRepo: appState.defaultRepoSlug,
                repos: appState.repos.map(publicRepoConfig),
            });
            return;
        }

        if (req.method === "GET" && url.pathname === "/vendor/mermaid.esm.min.mjs") {
            if (!(await fileExists(MERMAID_MODULE_PATH))) {
                sendJson(res, 404, { error: "Mermaid module is not installed" });
                return;
            }

            await sendFile(res, MERMAID_MODULE_PATH);
            return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/vendor/chunks/mermaid.esm.min/")) {
            const chunkName = path.basename(url.pathname);
            const chunkPath = path.join(EXTENSION_DIR, "node_modules", "mermaid", "dist", "chunks", "mermaid.esm.min", chunkName);
            const chunkRoot = path.join(EXTENSION_DIR, "node_modules", "mermaid", "dist", "chunks", "mermaid.esm.min");
            if (!isWithinDirectory(chunkRoot, chunkPath) || !(await fileExists(chunkPath))) {
                sendJson(res, 404, { error: "Mermaid chunk not found" });
                return;
            }

            await sendFile(res, chunkPath);
            return;
        }

        if (req.method === "GET" && url.pathname === "/asset") {
            const state = requireRepoState(appState, url.searchParams.get("repo"));
            const index = await ensureIndex(state);
            const assetPath = await resolveAssetPath(state, index, url.searchParams.get("doc"), url.searchParams.get("src"));
            if (!assetPath) {
                sendJson(res, 404, { error: "Asset not found" });
                return;
            }

            await sendFile(res, assetPath);
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/search") {
            const state = requireRepoState(appState, url.searchParams.get("repo"));
            const index = await ensureIndex(state);
            const query = url.searchParams.get("q") ?? "";
            const limit = Number(url.searchParams.get("limit") ?? 50);
            const results = searchIndex(index, query, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50);
            sendJson(res, 200, {
                query,
                count: results.length,
                total: index.docs.length,
                indexedAt: index.indexedAt,
                repo: index.repo,
                repoPath: index.repoPath,
                results,
            });
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/doc") {
            const state = requireRepoState(appState, url.searchParams.get("repo"));
            const index = await ensureIndex(state);
            const doc = findDoc(index, url.searchParams.get("path"));
            if (!doc) {
                sendJson(res, 404, { error: "Document not found" });
                return;
            }

            sendJson(res, 200, {
                path: doc.path,
                sourcePath: doc.sourcePath,
                title: doc.title,
                tags: doc.tags,
                modified: doc.modified,
                size: doc.size,
                content: doc.content,
            });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/refresh") {
            const state = requireRepoState(appState, url.searchParams.get("repo"));
            const git = await updateDisposableClone(state);
            state.index = null;
            state.indexPromise = null;
            const index = await ensureIndex(state);
            sendJson(res, 200, {
                total: index.docs.length,
                indexedAt: index.indexedAt,
                repo: index.repo,
                repoPath: index.repoPath,
                git,
            });
            return;
        }

        const repoRoute = req.method === "GET" ? parseRepoRoute(appState, url.pathname) : null;
        if (repoRoute) {
            sendHtml(res, renderHtml(appState, {
                repoSlug: repoRoute.repoSlug,
                docPath: repoRoute.docPath,
                presentMode: Boolean(repoRoute.docPath),
            }));
            return;
        }

        sendJson(res, 404, { error: "Not found" });
    } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
}

async function startServer(instanceId, repoPath) {
    const repos = repoPath && !pathsEqual(repoPath, CONFIGURED_REPOS[0].path)
        ? [{ ...CONFIGURED_REPOS[0], slug: "content", label: "content", path: repoPath, url: "", baseDir: "" }]
        : CONFIGURED_REPOS;
    const state = createAppState(instanceId, repos);
    const server = createServer((req, res) => {
        void handleRequest(state, req, res);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    for (const repoState of state.repoStates.values()) {
        void ensureIndex(repoState).catch(() => {});
    }

    return {
        server,
        state,
        repoPath,
        url: `http://127.0.0.1:${port}/`,
    };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "kpe-doc-dashboard",
            displayName: "KPE document dashboard",
            description: "Search and view markdown documents from the local KPE content repository.",
            inputSchema: {
                type: "object",
                properties: {
                    repoPath: {
                        type: "string",
                        description: "Absolute path to the repository containing markdown documents.",
                    },
                    repo: {
                        type: "string",
                        description: "Configured repository slug to search or refresh.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh_index",
                    description: "Pull the disposable clone and rebuild the markdown document index for this dashboard.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new CanvasError("dashboard_not_open", "Open the dashboard before refreshing its index.");
                        }

                        const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
                        const repoState = requireRepoState(entry.state, typeof input.repo === "string" ? input.repo : undefined);
                        const git = await updateDisposableClone(repoState);
                        repoState.index = null;
                        repoState.indexPromise = null;
                        const index = await ensureIndex(repoState);
                        return {
                            total: index.docs.length,
                            indexedAt: index.indexedAt,
                            repo: index.repo,
                            repoPath: index.repoPath,
                            git,
                        };
                    },
                },
                {
                    name: "search_documents",
                    description: "Search indexed markdown documents and return matching titles, paths, and snippets.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string" },
                            repo: { type: "string" },
                            limit: { type: "number", minimum: 1, maximum: 100 },
                        },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new CanvasError("dashboard_not_open", "Open the dashboard before searching documents.");
                        }

                        const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
                        const repoState = requireRepoState(entry.state, typeof input.repo === "string" ? input.repo : undefined);
                        const index = await ensureIndex(repoState);
                        const results = searchIndex(index, typeof input.query === "string" ? input.query : "", input.limit ?? 20);
                        return {
                            total: index.docs.length,
                            count: results.length,
                            repo: index.repo,
                            results,
                        };
                    },
                },
            ],
            open: async (ctx) => {
                const repoPath = normalizeRepoPath(ctx.input);
                let entry = servers.get(ctx.instanceId);
                if (!entry || entry.repoPath !== repoPath) {
                    if (entry) {
                        await new Promise((resolve) => entry.server.close(() => resolve()));
                    }

                    entry = await startServer(ctx.instanceId, repoPath);
                    servers.set(ctx.instanceId, entry);
                }

                return {
                    title: "KPE document dashboard",
                    status: `Searching ${entry.state.repos.map((repo) => repo.slug).join(", ")}`,
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});

void session;
