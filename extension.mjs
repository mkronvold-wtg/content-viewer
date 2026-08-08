import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRIMARY_REPO_PATH = process.env.CONTENT_VIEWER_PRIMARY_REPO_PATH ?? "";
const DEFAULT_CONTENT_ROOT = process.env.CONTENT_VIEWER_CONTENT_ROOT ?? path.join(EXTENSION_DIR, "content");
const MERMAID_MODULE_PATH = path.join(EXTENSION_DIR, "node_modules", "mermaid", "dist", "mermaid.esm.min.mjs");
const THEME_CSS_PATH = path.join(EXTENSION_DIR, "theme.css");
const THEME_JSON_PATH = path.join(EXTENSION_DIR, "theme.json");
const THEME_CONFIG = loadThemeConfig();
const MAX_SNIPPET_LENGTH = 140;
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const MIME_TYPES = new Map([
    [".avif", "image/avif"],
    [".css", "text/css; charset=utf-8"],
    [".gif", "image/gif"],
    [".json", "application/json; charset=utf-8"],
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

const DEFAULT_ALLOWED_GIT_HOSTS = new Set(["github.com"]);
const GIT_SAFETY_ARGS = [
    "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
    "-c", "protocol.file.allow=never", "-c", "protocol.git.allow=never", "-c", "protocol.ssh.allow=never",
    "-c", "protocol.ext.allow=never", "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false",
];

function allowedGitHosts() {
    const configured = String(process.env.CONTENT_VIEWER_ALLOWED_GIT_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
    const hosts = configured.length ? configured : [...DEFAULT_ALLOWED_GIT_HOSTS];
    if (hosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes(".."))) {
        throw new Error("CONTENT_VIEWER_ALLOWED_GIT_HOSTS contains an invalid hostname");
    }
    return new Set(hosts);
}

function testLocalGitAllowed() {
    return process.env.NODE_ENV === "test" && process.env.CONTENT_VIEWER_TEST_ALLOW_LOCAL_GIT === "1";
}

function approvedRepositoryUrl(value) {
    const source = String(value ?? "").trim();
    if (!source) throw new Error("A repository URL is required");
    let parsed;
    try { parsed = new URL(source); } catch { throw new Error("Repository URL must be an approved HTTPS URL"); }
    if (testLocalGitAllowed() && parsed.protocol === "file:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) return parsed;
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port || !allowedGitHosts().has(parsed.hostname.toLowerCase())) {
        throw new Error("Repository URL must use HTTPS on an allowed host without embedded credentials");
    }
    return parsed;
}

function sameRepositoryUrl(left, right) {
    return approvedRepositoryUrl(left).href === approvedRepositoryUrl(right).href;
}

const servers = new Map();

function loadThemeConfig() {
    const themeConfig = JSON.parse(readFileSync(THEME_JSON_PATH, "utf8"));
    const themes = themeConfig.themes ?? {};
    const themeIds = Object.keys(themes);
    const themeMeta = Object.fromEntries(themeIds.map((id) => [
        id,
        {
            label: themes[id].label ?? id,
            mode: themes[id].mode ?? "light",
        },
    ]));

    return {
        themeIds,
        themeAliases: themeConfig.aliases ?? {},
        themeMeta,
    };
}

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

function invalidBaseDirError(repo, reason) {
    return new Error(`Invalid BASE_DIR for content repo "${repo.slug}": ${reason}`);
}

function normalizeDisplayPath(value) {
    const normalized = String(value ?? "").replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        return null;
    }

    return normalized;
}

async function resolveIndexRoot(repo) {
    const repoPath = path.resolve(repo.path);
    const rootStat = await fs.stat(repoPath);
    if (!rootStat.isDirectory()) {
        throw new Error(`${repoPath} is not a directory`);
    }

    const repoRoot = await fs.realpath(repoPath);
    const baseDir = normalizeBaseDir(repo.baseDir);
    if (!baseDir) {
        return { repoRoot, indexRoot: repoRoot };
    }

    const segments = baseDir.split("/");
    if (
        path.isAbsolute(baseDir) ||
        path.win32.isAbsolute(baseDir) ||
        segments.some((segment) => !segment || segment === "." || segment === ".." || /^[A-Za-z]:$/.test(segment))
    ) {
        throw invalidBaseDirError(repo, `"${baseDir}" must be a repository-relative directory without "." or ".." path segments`);
    }

    const configuredRoot = path.resolve(repoRoot, ...segments);
    if (!isWithinDirectory(repoRoot, configuredRoot) || pathsEqual(repoRoot, configuredRoot)) {
        throw invalidBaseDirError(repo, `"${baseDir}" must resolve strictly inside ${repoPath}`);
    }

    let indexRoot;
    try {
        indexRoot = await fs.realpath(configuredRoot);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw invalidBaseDirError(repo, `"${baseDir}" does not exist`);
        }
        throw invalidBaseDirError(repo, `"${baseDir}" cannot be resolved`);
    }

    const indexStat = await fs.stat(indexRoot);
    if (!indexStat.isDirectory()) {
        throw invalidBaseDirError(repo, `"${baseDir}" is not a directory`);
    }
    if (!isWithinDirectory(repoRoot, indexRoot) || pathsEqual(repoRoot, indexRoot)) {
        throw invalidBaseDirError(repo, `"${baseDir}" resolves outside the repository`);
    }

    return { repoRoot, indexRoot };
}

function repoTitleName(repo) {
    const source = String(repo.url ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    const match = source.match(/(?:^|[:/])([^/:/]+?)(?:\.git)?$/);
    return match?.[1] || repo.label || repo.slug;
}

function documentTitleName(documentPath) {
    return String(documentPath ?? "").replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "";
}

function gitWebUrl(remoteUrl) {
    const remote = String(remoteUrl ?? "").trim();
    if (!remote) {
        return "";
    }

    try {
        const parsed = new URL(remote);
        if (!["http:", "https:", "ssh:"].includes(parsed.protocol)) {
            return "";
        }
        const remotePath = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
        return remotePath ? `https://${parsed.host}/${remotePath}` : "";
    } catch {
        const scpStyleMatch = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
        if (!scpStyleMatch) {
            return "";
        }
        const [, host, remotePath] = scpStyleMatch;
        return `https://${host}/${remotePath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "")}`;
    }
}

function sourceDocumentUrl(repo, sourcePath) {
    const repositoryUrl = gitWebUrl(repo.url);
    const encodedBranch = String(repo.branch ?? "main").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const encodedPath = String(sourcePath ?? "").replaceAll("\\", "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return repositoryUrl && encodedBranch && encodedPath
        ? `${repositoryUrl}/blob/${encodedBranch}/${encodedPath}`
        : "";
}

function publicRepoConfig(repo) {
    return {
        slug: repo.slug,
        label: repo.label,
        titleName: repoTitleName(repo),
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
        if (urlFromEnv) {
            approvedRepositoryUrl(urlFromEnv);
        }
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

async function runGit(operation, args, repositoryUrl = "") {
    const remote = repositoryUrl ? approvedRepositoryUrl(repositoryUrl) : null;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
        if (key.startsWith("GIT_")) delete environment[key];
    }
    delete environment.SSH_ASKPASS;
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GCM_INTERACTIVE = "Never";
    const token = remote?.protocol === "https:" && remote.hostname.toLowerCase() === "github.com" ? process.env.CONTENT_VIEWER_GITHUB_TOKEN : "";
    if (token) {
        environment.GIT_CONFIG_COUNT = "1";
        environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
        environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
    }
    const safetyArgs = testLocalGitAllowed() && remote?.protocol === "file:"
        ? GIT_SAFETY_ARGS.map((value) => value === "protocol.file.allow=never" ? "protocol.file.allow=always" : value)
        : GIT_SAFETY_ARGS;
    try {
        const { stdout, stderr } = await execFileAsync("git", [...safetyArgs, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: environment });
        return `${stdout}${stderr}`.trim();
    } catch {
        throw new Error(`Git ${operation} failed`);
    }
}

async function getGitRemoteUrl(repoPath) {
    try { return await runGit("inspect remote", ["-C", repoPath, "remote", "get-url", "origin"]); } catch { return ""; }
}

async function ensureDisposableClone(repoState) {
    const { repo } = repoState;
    const repoPath = repo.path;
    try {
        const stat = await fs.stat(path.join(repoPath, ".git"));
        if (stat.isDirectory()) return { skipped: false, output: `${repo.slug} clone already exists.` };
    } catch (error) {
        if (error?.code !== "ENOENT") throw new Error(`Unable to inspect content repository ${repo.slug}`);
        if (!repo.url) throw new Error(`Set a repository URL before cloning ${repo.slug}`);
        approvedRepositoryUrl(repo.url);
        await fs.mkdir(path.dirname(repoPath), { recursive: true });
        const stagingPath = `${repoPath}.clone-${process.pid}-${Date.now()}`;
        try {
            const output = await runGit("clone", ["clone", "--no-recurse-submodules", "--depth", "1", "--branch", repo.branch, repo.url, stagingPath], repo.url);
            await fs.rename(stagingPath, repoPath);
            return { skipped: false, output };
        } catch (error) {
            await fs.rm(stagingPath, { recursive: true, force: true });
            throw error;
        }
    }
    throw new Error(`${repoPath} exists but is not a Git clone`);
}

async function updateDisposableClone(repoState) {
    await ensureDisposableClone(repoState);
    const remoteUrl = await getGitRemoteUrl(repoState.repo.path);
    if (!remoteUrl) throw new Error("Content repository has no origin remote");
    approvedRepositoryUrl(remoteUrl);
    if (repoState.repo.url && !sameRepositoryUrl(remoteUrl, repoState.repo.url)) throw new Error("Content repository origin does not match its configured URL");
    const output = await runGit("pull", ["-C", repoState.repo.path, "pull", "--ff-only", "--no-recurse-submodules", "origin", repoState.repo.branch], remoteUrl);
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
    const tags = extractFrontmatterList(frontmatter, ["tags", "tag", "labels", "label"]);
    const layers = extractFrontmatterList(frontmatter, ["layers", "layer"]);

    return {
        title: titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, "") : undefined,
        layers,
        tags,
    };
}

function stripFrontmatter(content) {
    return String(content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function extractFrontmatterList(frontmatter, keys) {
    const values = [];
    for (const key of keys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const blockMatch = frontmatter.match(new RegExp("^" + escapedKey + ":[ \\t]*\\r?\\n((?:[ \\t]*-[ \\t]+.+\\r?\\n?)+)", "im"));
        if (blockMatch) {
            values.push(
                ...blockMatch[1]
                    .split(/\r?\n/)
                    .map((line) => cleanTag(line.replace(/^\s+-\s+/, "")))
                    .filter(Boolean),
            );
        }

        const inlineMatch = frontmatter.match(new RegExp("^" + escapedKey + ":[ \\t]*(.+)$", "im"));
        if (inlineMatch && inlineMatch[1].trim()) {
            const inlineValue = inlineMatch[1].trim();
            const listMatch = inlineValue.match(/^\[(.*)\]$/);
            if (listMatch) {
                values.push(...listMatch[1].split(",").map(cleanTag).filter(Boolean));
            } else {
                values.push(cleanTag(inlineValue));
            }
        }
    }

    const seen = new Set();
    return values.filter((value) => {
        const normalized = normalizeTag(value);
        if (!normalized || seen.has(normalized)) {
            return false;
        }
        seen.add(normalized);
        return true;
    });
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

function parseTextTerms(value) {
    const terms = [];
    let current = "";
    let quote = "";

    function pushCurrent() {
        const term = current.trim().toLowerCase();
        if (term) {
            terms.push(term);
        }
        current = "";
    }

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (character === "\\" && value[index + 1] === quote) {
                current += value[index + 1];
                index += 1;
            } else if (character === quote) {
                pushCurrent();
                quote = "";
            } else {
                current += character;
            }
            continue;
        }

        if (character === "\"" || character === "'") {
            pushCurrent();
            quote = character;
            continue;
        }

        if (/\s/.test(character)) {
            pushCurrent();
            continue;
        }

        current += character;
    }

    pushCurrent();
    return terms;
}

function parseSearchQuery(query) {
    const tagFilters = [];
    const layerFilters = [];
    let text = String(query ?? "").replace(/\b(tag|layer):\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi, (match, facet, doubleQuoted, singleQuoted, bare) => {
        const value = cleanTag(doubleQuoted ?? singleQuoted ?? bare);
        if (value && facet.toLowerCase() === "layer") {
            layerFilters.push(normalizeTag(value));
        } else if (value) {
            tagFilters.push(normalizeTag(value));
        }

        return " ";
    });

    text = text.replace(/\b(?:tag|layer):\s*$/i, " ");
    return { tokens: parseTextTerms(text), tagFilters, layerFilters };
}

function buildFacetIndex(docs, fieldName) {
    const facets = new Map();
    for (const doc of docs) {
        const docValues = new Set();
        for (const item of doc[fieldName] ?? []) {
            const value = normalizeTag(item);
            if (!value || docValues.has(value)) {
                continue;
            }
            docValues.add(value);
            const label = cleanTag(item).replace(/^#/, "") || value;
            const existing = facets.get(value);
            if (existing) {
                existing.count += 1;
                if (label.length < existing.label.length) {
                    existing.label = label;
                }
            } else {
                facets.set(value, { value, label, count: 1 });
            }
        }
    }

    return Array.from(facets.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

async function buildIndex(repo) {
    const repoPath = repo.path;
    const { repoRoot, indexRoot } = await resolveIndexRoot(repo);

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
                const sourcePath = toPosixPath(path.relative(repoRoot, fullPath));
                const displayPath = toPosixPath(path.relative(indexRoot, fullPath));
                const frontmatter = extractFrontmatter(content);
                const title = extractTitle(content, fullPath);
                docs.push({
                    path: displayPath,
                    sourcePath,
                    title,
                    layers: frontmatter.layers ?? [],
                    tags: frontmatter.tags ?? [],
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    content,
                    searchable: `${title}\n${displayPath}\n${(frontmatter.layers ?? []).join(" ")}\n${(frontmatter.tags ?? []).join(" ")}\n${content}`.toLowerCase(),
                });
            }),
        );
    }

    await walk(indexRoot);
    docs.sort((a, b) => a.path.localeCompare(b.path));
    return {
        repo: publicRepoConfig(repo),
        repoPath,
        repoRoot,
        indexRoot,
        indexedAt: new Date().toISOString(),
        facets: {
            layers: buildFacetIndex(docs, "layers"),
            tags: buildFacetIndex(docs, "tags"),
        },
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
    const { tokens, tagFilters, layerFilters } = parseSearchQuery(query);

    const scored = index.docs
        .map((doc) => {
            const normalizedLayers = doc.layers.map(normalizeTag);
            if (layerFilters.length && !layerFilters.every((layer) => normalizedLayers.includes(layer))) {
                return null;
            }

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
            const layers = doc.layers.join(" ").toLowerCase();
            const tags = doc.tags.join(" ").toLowerCase();
            const score = tokens.reduce((total, token) => {
                const contentMatches = doc.searchable.split(token).length - 1;
                return (
                    total +
                    (title.includes(token) ? 50 : 0) +
                    (docPath.includes(token) ? 25 : 0) +
                    (layers.includes(token) ? 20 : 0) +
                    (tags.includes(token) ? 20 : 0) +
                    Math.min(contentMatches, 20)
                );
            }, (tagFilters.length + layerFilters.length) * 100);

            return { doc, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
        .slice(0, limit);

    return scored.map(({ doc, score }) => ({
        path: doc.path,
        title: doc.title,
        layers: doc.layers,
        tags: doc.tags,
        modified: doc.modified,
        size: doc.size,
        score,
        snippet: makeSnippet(doc.content, tokens),
    }));
}

function findDoc(index, displayPath) {
    const normalizedPath = normalizeDisplayPath(displayPath);
    return normalizedPath ? index.docs.find((doc) => doc.path === normalizedPath) : undefined;
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
    if (!normalized || normalized === "." || isParentTraversal(normalized) || path.isAbsolute(normalized)) {
        return null;
    }

    return normalized;
}

function isParentTraversal(relativePath) {
    return relativePath === ".." || relativePath.startsWith(`..${path.sep}`);
}

function isWithinDirectory(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!isParentTraversal(relative) && !path.isAbsolute(relative));
}

async function fileExists(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function fileExistsWithinDirectory(directory, filePath) {
    if (!isWithinDirectory(directory, filePath) || !(await fileExists(filePath))) {
        return false;
    }

    try {
        return isWithinDirectory(directory, await fs.realpath(filePath));
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
    const docRelative = normalizeRepoRelative(doc?.sourcePath);
    const assetRelative = stripAssetDecorations(assetSrc);
    if (!docRelative || !assetRelative) {
        return null;
    }

    const repoPath = index.repoRoot ?? state.repo.path;
    const indexRoot = index.indexRoot ?? repoPath;
    const docPath = path.resolve(repoPath, docRelative);
    if (!isWithinDirectory(indexRoot, docPath)) {
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
            candidates.push(path.resolve(indexRoot, repoRelative));
        }
    } else {
        candidates.push(path.resolve(docDirectory, normalizedAsset));
        candidates.push(path.resolve(docDirectory, basename));
        candidates.push(path.resolve(docDirectory, "attachments", basename));
        candidates.push(path.resolve(indexRoot, "attachments", basename));
    }

    for (const candidate of candidates) {
        if (await fileExistsWithinDirectory(indexRoot, candidate)) {
            return candidate;
        }
    }

    const found = await findAssetByBasename(indexRoot, basename);
    return found && (await fileExistsWithinDirectory(indexRoot, found)) ? found : null;
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

    let repoSlug;
    let docPath;
    try {
        repoSlug = decodeURIComponent(segments[0]);
        docPath = segments.slice(1).map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
        return null;
    }
    if (!appState.repoStates.has(repoSlug)) {
        return null;
    }
    if (docPath && !normalizeDisplayPath(docPath)) {
        return null;
    }

    return {
        repoSlug,
        docPath,
    };
}

function hasPresentationRequest(url) {
    return url.searchParams.getAll("present").length === 1 && url.searchParams.get("present") === "1";
}

function renderHtml(appState, initialView = {}) {
    const repos = appState.repos.map(publicRepoConfig);
    const themeConfig = THEME_CONFIG;
    const initialRepoSlug = initialView.repoSlug && appState.repoStates.has(initialView.repoSlug)
        ? initialView.repoSlug
        : appState.defaultRepoSlug;
    const initialDocPath = initialView.docPath ?? "";
    const initialPresentMode = Boolean(initialView.presentMode && initialDocPath);
    const initialRepo = appState.repoStates.get(initialRepoSlug)?.repo ?? appState.repos[0];
    const initialPageTitle = initialDocPath ? `${repoTitleName(initialRepo)}/${documentTitleName(initialDocPath)}` : "KPE document dashboard";
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(initialPageTitle)}</title>
  <link rel="stylesheet" href="/theme.css" />
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--theme-chrome);
      color: var(--theme-text);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }

    header {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 12px;
      border-bottom: 1px solid var(--theme-border);
      background: var(--theme-chrome);
      color: var(--theme-chrome-text);
    }

    header .meta {
      color: var(--theme-chrome-muted-text);
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
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-input-bg);
      color: var(--theme-text);
      font: inherit;
    }

    .repo-select {
      max-width: 180px;
      padding: 8px 10px;
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-input-bg);
      color: var(--theme-text);
      font: inherit;
    }

    input::placeholder {
      color: var(--theme-muted-text);
      opacity: 1;
    }

    input:focus {
      outline: 2px solid var(--color-focus-outline, #0969da);
      outline-offset: 1px;
    }

    button {
      padding: 8px 10px;
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-button-bg);
      color: var(--theme-text);
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      background: var(--theme-button-hover-bg);
    }

    main {
      display: grid;
      --rail-collapsed-size: 34px;
      --nav-rail-width: 320px;
      --nav-column: var(--nav-rail-width);
      --tag-column: var(--rail-collapsed-size);
      grid-template-columns: var(--nav-column) minmax(0, 1fr) var(--tag-column);
      height: calc(100vh - 97px);
      min-height: 0;
      position: relative;
    }

    body.nav-unpinned main {
      --nav-column: var(--rail-collapsed-size);
    }

    body.tag-pinned main {
      --tag-column: minmax(220px, 24%);
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
      border: 1px solid var(--theme-border);
      border-radius: 999px;
      background: color-mix(in srgb, var(--theme-chrome) 88%, transparent);
      color: var(--theme-chrome-muted-text);
      font-size: 12px;
      line-height: 16px;
      backdrop-filter: blur(8px);
    }

    .present-controls #paginate-level,
    .present-controls .page-controls {
      display: none;
    }

    .page-controls {
      align-items: center;
      gap: 4px;
    }

    .page-indicator {
      min-width: 56px;
      color: var(--theme-chrome-muted-text);
      font-size: 12px;
      text-align: center;
    }

    body.presenting header,
    body.presenting .nav-rail,
    body.presenting .tag-rail,
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
      background: linear-gradient(
        to bottom,
        var(--theme-chrome) 0,
        var(--theme-chrome) var(--presentation-topbar-height, 36px),
        var(--theme-surface) var(--presentation-topbar-height, 36px),
        var(--theme-surface) 100%
      );
    }

    body.presenting .markdown {
      max-width: 1100px;
      margin: 0 auto;
    }

    body.presenting .markdown > :first-child {
      margin-top: 0;
      color: var(--theme-chrome-text);
    }

    body.presenting .present-controls #paginate-level,
    body.presenting .present-controls .page-controls {
      display: flex;
    }

    .nav-rail,
    .tag-rail {
      display: flex;
      position: relative;
      min-width: 0;
      min-height: 0;
      background: var(--theme-chrome);
      color: var(--theme-chrome-text);
      overflow: hidden;
      z-index: 3;
    }

    .nav-rail {
      grid-column: 1;
      border-right: 1px solid var(--theme-border);
      width: var(--nav-rail-width);
    }

    .tag-rail {
      grid-column: 3;
      grid-row: 1;
      border-left: 1px solid var(--theme-border);
    }

    .nav-rail-inner,
    .tag-rail-inner {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      flex-direction: column;
    }

    .nav-resize-handle {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 5;
      width: 10px;
      height: 100%;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      cursor: col-resize;
    }

    .nav-resize-handle::after {
      content: "";
      position: absolute;
      top: 0;
      right: 0;
      width: 2px;
      height: 100%;
      background: transparent;
      transition: background-color 160ms ease;
    }

    .nav-resize-handle:hover::after,
    .nav-resize-handle:focus-visible::after,
    body.nav-resizing .nav-resize-handle::after {
      background: var(--theme-active-border);
    }

    body.nav-resizing {
      cursor: col-resize;
      user-select: none;
    }

    .nav-rail-header,
    .tag-rail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--theme-border-muted);
    }

    .nav-rail-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .nav-rail-title,
    .tag-rail-title {
      margin: 0;
      color: var(--theme-chrome-text);
      font-size: 13px;
      font-weight: var(--font-weight-semibold, 600);
      letter-spacing: 0.04em;
      line-height: 18px;
      text-transform: uppercase;
    }

    .nav-pin,
    .nav-preview-toggle,
    .tag-pin {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 28px;
      min-width: 28px;
      height: 28px;
      min-height: 28px;
      padding: 0;
      border-radius: 999px;
      color: var(--theme-chrome-muted-text);
    }

    .nav-pin svg,
    .nav-preview-toggle svg,
    .tag-pin svg {
      width: 14px;
      height: 14px;
    }

    .nav-pin:hover,
    .nav-pin.is-active,
    .nav-preview-toggle:hover,
    .nav-preview-toggle.is-active,
    .tag-pin:hover,
    .tag-pin.is-active {
      color: var(--theme-active-border);
      border-color: color-mix(in srgb, var(--theme-active-border) 55%, transparent);
      background: var(--theme-active-bg);
    }

    .nav-flyout-trigger,
    .tag-flyout-trigger {
      display: none;
    }

    .results,
    .tag-list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      max-height: none;
    }

    body.nav-unpinned .nav-rail {
      grid-column: 1;
      grid-row: 1;
      width: var(--rail-collapsed-size);
      min-width: var(--rail-collapsed-size);
      border-right: 0;
      background: transparent;
      overflow: visible;
    }

    body.nav-unpinned .nav-rail-inner {
      position: absolute;
      top: 0;
      left: 0;
      width: min(var(--nav-rail-width), calc(100vw - 32px));
      height: 100%;
      border: 1px solid var(--theme-border);
      border-radius: 0 14px 14px 0;
      background: color-mix(in srgb, var(--theme-chrome) 96%, transparent);
      box-shadow: var(--theme-shadow);
      opacity: 0;
      pointer-events: none;
      transform: translateX(-8px);
      transition:
        opacity 160ms ease,
        transform 160ms ease,
        border-color 160ms ease,
        background-color 160ms ease;
    }

    body.nav-unpinned .nav-rail.is-open .nav-rail-inner,
    body.nav-unpinned .nav-rail:hover .nav-rail-inner,
    body.nav-unpinned .nav-rail:focus-within .nav-rail-inner {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }

    body.nav-unpinned .nav-rail.suppress-open .nav-rail-inner {
      opacity: 0;
      pointer-events: none;
      transform: translateX(-8px);
    }

    body.nav-unpinned .nav-flyout-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--rail-collapsed-size);
      min-height: 96px;
      border: 1px solid var(--theme-border);
      border-radius: 0 14px 14px 0;
      background: color-mix(in srgb, var(--theme-modal-surface-bg) 94%, transparent);
      box-shadow: var(--theme-shadow);
      color: var(--theme-text);
      cursor: pointer;
      padding: 8px 4px;
      backdrop-filter: blur(14px);
    }

    body.nav-unpinned .nav-flyout-trigger-text,
    body.tag-unpinned .tag-flyout-trigger-text {
      font-size: 11px;
      font-weight: var(--font-weight-semibold, 600);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      writing-mode: vertical-lr;
    }

    body.nav-unpinned .nav-rail.is-open .nav-flyout-trigger,
    body.nav-unpinned .nav-rail:hover .nav-flyout-trigger,
    body.nav-unpinned .nav-rail:focus-within .nav-flyout-trigger {
      border-color: color-mix(in srgb, var(--theme-active-border) 55%, transparent);
      background: color-mix(in srgb, var(--theme-active-bg) 92%, transparent);
    }

    body.nav-unpinned .document {
      grid-column: 2;
    }

    body.tag-unpinned .tag-rail {
      grid-column: 3;
      grid-row: 1;
      justify-content: flex-end;
      width: var(--rail-collapsed-size);
      min-width: var(--rail-collapsed-size);
      border-left: 0;
      background: transparent;
      overflow: visible;
    }

    body.tag-unpinned .tag-rail-inner {
      position: absolute;
      top: 0;
      right: 0;
      width: min(280px, calc(100vw - 32px));
      height: 100%;
      border: 1px solid var(--theme-border);
      border-radius: 14px 0 0 14px;
      background: color-mix(in srgb, var(--theme-chrome) 96%, transparent);
      box-shadow: var(--theme-shadow);
      opacity: 0;
      pointer-events: none;
      transform: translateX(8px);
      transition:
        opacity 160ms ease,
        transform 160ms ease,
        border-color 160ms ease,
        background-color 160ms ease;
    }

    body.tag-unpinned .tag-rail.is-open .tag-rail-inner,
    body.tag-unpinned .tag-rail:hover .tag-rail-inner,
    body.tag-unpinned .tag-rail:focus-within .tag-rail-inner {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }

    body.tag-unpinned .tag-rail.suppress-open .tag-rail-inner {
      opacity: 0;
      pointer-events: none;
      transform: translateX(8px);
    }

    body.tag-unpinned .tag-flyout-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--rail-collapsed-size);
      min-height: 96px;
      border: 1px solid var(--theme-border);
      border-radius: 14px 0 0 14px;
      background: color-mix(in srgb, var(--theme-modal-surface-bg) 94%, transparent);
      box-shadow: var(--theme-shadow);
      color: var(--theme-text);
      cursor: pointer;
      padding: 8px 4px;
      backdrop-filter: blur(14px);
    }

    body.tag-unpinned .tag-flyout-trigger-text {
      writing-mode: vertical-rl;
    }

    body.tag-unpinned .tag-rail.is-open .tag-flyout-trigger,
    body.tag-unpinned .tag-rail:hover .tag-flyout-trigger,
    body.tag-unpinned .tag-rail:focus-within .tag-flyout-trigger {
      border-color: color-mix(in srgb, var(--theme-active-border) 55%, transparent);
      background: color-mix(in srgb, var(--theme-active-bg) 92%, transparent);
    }

    .tag-summary {
      display: block;
      color: var(--theme-chrome-muted-text);
      font-size: 12px;
      line-height: 16px;
    }

    .tag-scope-toggle {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--theme-border-muted);
    }

    .tag-scope-button {
      padding: 5px 8px;
      border-radius: 999px;
      color: var(--theme-chrome-muted-text);
      font-size: 12px;
      line-height: 16px;
    }

    .tag-scope-button.is-active {
      border-color: color-mix(in srgb, var(--theme-active-border) 55%, transparent);
      background: var(--theme-active-bg);
      color: var(--theme-active-border);
    }

    .tag-facet-toggle {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      min-width: 132px;
    }

    .tag-button {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      padding: 9px 12px;
      border: 0;
      border-bottom: 1px solid var(--theme-border-muted);
      border-radius: 0;
      background: transparent;
      color: var(--theme-chrome-text);
      text-align: left;
    }

    .tag-button:hover,
    .tag-button:focus {
      background: var(--theme-active-bg);
    }

    .tag-button-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tag-button-count {
      flex: 0 0 auto;
      min-width: 24px;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--theme-surface);
      color: var(--theme-muted-text);
      font-size: 12px;
      text-align: center;
    }

    .result {
      display: block;
      width: 100%;
      padding: 10px 12px;
      border: 0;
      border-bottom: 1px solid var(--theme-border-muted);
      border-radius: 0;
      background: transparent;
      color: var(--theme-chrome-text);
      text-align: left;
    }

    .result:hover {
      background: var(--theme-active-bg);
      color: var(--theme-text);
    }

    .result.active {
      background: var(--theme-surface);
      color: var(--theme-text);
      box-shadow: inset 3px 0 0 var(--theme-active-border);
    }

    .result-title {
      display: block;
      font-weight: var(--font-weight-semibold, 600);
      margin-bottom: 2px;
    }

    .results[data-preview-mode="title-only"] .result {
      padding-top: 7px;
      padding-bottom: 7px;
    }

    .results[data-preview-mode="title-only"] .result-title {
      margin-bottom: 0;
    }

    .results[data-preview-mode="title-only"] .result-path,
    .results[data-preview-mode="title-only"] .snippet {
      display: none;
    }

    .results .result-path {
      color: var(--theme-chrome-muted-text);
    }

    .result-path,
    .meta,
    .empty {
      color: var(--theme-muted-text);
      font-size: 12px;
      line-height: 18px;
    }

    .snippet {
      display: -webkit-box;
      max-height: 34px;
      margin-top: 4px;
      overflow: hidden;
      color: var(--theme-chrome-muted-text);
      font-size: 12px;
      line-height: 17px;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }

    .result:hover .result-path,
    .result:hover .snippet,
    .result.active .result-path,
    .result.active .snippet {
      color: var(--theme-muted-text);
    }

    mark {
      padding: 0.05em 0.18em;
      border-radius: 3px;
      background: var(--theme-mark-bg);
      color: var(--theme-mark-text);
      font-weight: var(--font-weight-semibold, 600);
    }

    .document {
      min-width: 0;
      padding: 18px 22px 32px;
      background: var(--theme-surface);
      overflow: auto;
      max-height: none;
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
      border-top: 2px solid var(--theme-active-border);
      background: transparent;
      margin: 24px 0;
    }

    .markdown code {
      font-family: var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace);
      font-size: var(--text-code-inline, 12px);
      background: var(--theme-surface-muted);
      border: 1px solid var(--theme-border-muted);
      border-radius: 4px;
      padding: 0.15em 0.3em;
    }

    .markdown pre {
      padding: 12px;
      overflow: auto;
      border-radius: 8px;
      background: var(--theme-surface-muted);
      border: 1px solid var(--theme-border-muted);
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
      accent-color: var(--theme-active-border);
    }

    .markdown .table-wrapper {
      max-width: 100%;
      overflow: visible;
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-surface);
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
      border-right: 1px solid var(--theme-border-muted);
      border-bottom: 1px solid var(--theme-border-muted);
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
      background: var(--theme-button-bg);
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
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-surface);
    }

    .svg-block,
    .mermaid-block {
      max-width: 100%;
      margin: 12px 0;
      padding: 12px;
      overflow: auto;
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-surface);
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
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      background: var(--theme-surface-muted);
      color: var(--theme-muted-text);
      white-space: pre-wrap;
    }

    .markdown blockquote {
      padding-left: 12px;
      border-left: 3px solid var(--theme-border);
      color: var(--theme-muted-text);
    }

    .markdown .admonition {
      padding: 10px 12px;
      border: 1px solid var(--theme-border);
      border-left: 4px solid var(--theme-active-border);
      border-radius: 8px;
      background: var(--theme-surface);
    }

    .markdown .admonition-title,
    .markdown summary.admonition-title {
      margin: 0 0 8px;
      color: var(--theme-text);
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
      color: var(--theme-link);
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
      border: 1px solid var(--theme-border);
      border-radius: 999px;
      background: var(--theme-surface);
      color: var(--theme-muted-text);
      font-size: 12px;
    }

    @media (max-width: 760px) {
      main {
        display: block;
        height: auto;
      }

      .nav-rail,
      .tag-rail,
      body.nav-unpinned .nav-rail,
      body.tag-unpinned .tag-rail {
        position: static;
        width: auto;
        min-width: 0;
        border-right: 0;
        border-left: 0;
        border-bottom: 1px solid var(--theme-border);
        background: var(--theme-chrome);
        overflow: hidden;
      }

      .nav-rail-inner,
      .tag-rail-inner,
      body.nav-unpinned .nav-rail-inner,
      body.tag-unpinned .tag-rail-inner {
        position: static;
        width: auto;
        height: auto;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        opacity: 1;
        pointer-events: auto;
        transform: none;
      }

      .nav-resize-handle {
        display: none;
      }

      .nav-flyout-trigger,
      .tag-flyout-trigger,
      .nav-pin,
      .tag-pin,
      body.nav-unpinned .nav-flyout-trigger,
      body.tag-unpinned .tag-flyout-trigger {
        display: none;
      }

      .results,
      .tag-list {
        max-height: 42vh;
      }

      .document {
        max-height: none;
      }
    }
  </style>
</head>
<body>
  <div class="present-controls" aria-label="Presentation controls">
    <select id="theme-select" title="Theme" aria-label="Theme"></select>
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
      <button id="source-link" type="button" title="Copy source Git URL" disabled>Source</button>
      <button id="share-link" type="button">Share</button>
    </div>
    <div id="status" class="meta">Indexing ${escapeHtml(initialRepoSlug)}...</div>
  </header>
  <main>
    <aside id="nav-rail" class="nav-rail is-pinned" aria-label="Document navigation">
      <button id="nav-flyout-trigger" class="nav-flyout-trigger" type="button" aria-label="Open navigation panel" aria-expanded="true">
        <span class="nav-flyout-trigger-text">Nav</span>
      </button>
      <div class="nav-rail-inner">
        <div class="nav-rail-header">
          <h2 class="nav-rail-title">Documents</h2>
          <div class="nav-rail-actions">
            <button id="nav-preview-toggle" class="nav-preview-toggle" type="button" aria-label="Show title-only navigation results" aria-pressed="false" title="Show title-only navigation results">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M2 3.5h12v1H2v-1Zm0 4h12v1H2v-1Zm0 4h12v1H2v-1Z" fill="currentColor"></path>
              </svg>
            </button>
            <button id="nav-pin" class="nav-pin is-active" type="button" aria-label="Unpin navigation sidebar" aria-pressed="true" title="Unpin navigation sidebar">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M5.4 1.5h5.2v1.7L9.7 5.5v2.8l1.8 1v1.2H8.6v4H7.4v-4H4.5V9.3l1.8-1V5.5L5.4 3.2V1.5Z" fill="currentColor"></path>
              </svg>
            </button>
          </div>
        </div>
        <section id="results" class="results" aria-label="Search results"></section>
        <button id="nav-resize-handle" class="nav-resize-handle" type="button" aria-label="Resize document navigation sidebar" title="Drag to resize document navigation sidebar"></button>
      </div>
    </aside>
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
    <aside id="tag-rail" class="tag-rail" aria-label="Tag filters">
      <button id="tag-flyout-trigger" class="tag-flyout-trigger" type="button" aria-label="Open tag panel" aria-expanded="false">
        <span class="tag-flyout-trigger-text">Tags</span>
      </button>
      <div class="tag-rail-inner">
        <div class="tag-rail-header">
          <div>
            <div class="tag-facet-toggle" role="group" aria-label="Metadata facet">
              <button class="tag-scope-button is-active" type="button" data-tag-facet="layer" aria-pressed="true">Layer</button>
              <button class="tag-scope-button" type="button" data-tag-facet="tags" aria-pressed="false">Tags</button>
            </div>
            <span id="tag-count" class="tag-summary">Loading metadata...</span>
          </div>
          <button id="tag-pin" class="tag-pin" type="button" aria-label="Pin tag sidebar" aria-pressed="false" title="Pin tag sidebar">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M5.4 1.5h5.2v1.7L9.7 5.5v2.8l1.8 1v1.2H8.6v4H7.4v-4H4.5V9.3l1.8-1V5.5L5.4 3.2V1.5Z" fill="currentColor"></path>
            </svg>
          </button>
        </div>
        <div class="tag-scope-toggle" role="group" aria-label="Tag scope">
          <button class="tag-scope-button" type="button" data-tag-scope="document" aria-pressed="false">This document</button>
          <button class="tag-scope-button is-active" type="button" data-tag-scope="all" aria-pressed="true">All documents</button>
        </div>
        <section id="tag-list" class="tag-list" aria-label="Available tags"></section>
      </div>
    </aside>
  </main>
  <script>
    const searchInput = document.getElementById("search");
    const refreshButton = document.getElementById("refresh");
    const navRail = document.getElementById("nav-rail");
    const navPreviewToggle = document.getElementById("nav-preview-toggle");
    const navPin = document.getElementById("nav-pin");
    const navFlyoutTrigger = document.getElementById("nav-flyout-trigger");
    const navResizeHandle = document.getElementById("nav-resize-handle");
    const tagRail = document.getElementById("tag-rail");
    const tagPin = document.getElementById("tag-pin");
    const tagFlyoutTrigger = document.getElementById("tag-flyout-trigger");
    const tagList = document.getElementById("tag-list");
    const tagCount = document.getElementById("tag-count");
    const tagFacetButtons = Array.from(document.querySelectorAll("[data-tag-facet]"));
    const tagScopeButtons = Array.from(document.querySelectorAll("[data-tag-scope]"));
    const resultsElement = document.getElementById("results");
    const statusElement = document.getElementById("status");
    const docTitle = document.getElementById("doc-title");
    const docPath = document.getElementById("doc-path");
    const docTags = document.getElementById("doc-tags");
    const docContent = document.getElementById("doc-content");
    const documentPanel = document.querySelector(".document");
    const themeSelect = document.getElementById("theme-select");
    const presentToggle = document.getElementById("present-toggle");
    const paginateLevel = document.getElementById("paginate-level");
    const prevPage = document.getElementById("prev-page");
    const nextPage = document.getElementById("next-page");
    const pageIndicator = document.getElementById("page-indicator");
    const repoSelect = document.getElementById("repo-select");
    const sourceButton = document.getElementById("source-link");
    const shareButton = document.getElementById("share-link");
    const repos = ${JSON.stringify(repos)};
    const initialRepoSlug = ${JSON.stringify(initialRepoSlug)};
    const initialDocPath = ${JSON.stringify(initialDocPath)};
    const initialPresentMode = ${JSON.stringify(initialPresentMode)};
    let activeRepo = initialRepoSlug;
    let activePath = initialDocPath;
    let searchTimer;
    let highlightTokens = [];
    let allDocumentFacets = { layers: [], tags: [] };
    let tagFacet = "layer";
    let tagScope = "all";
    let currentDocPath = "";
    let currentDocument = null;
    let currentPages = [{ title: "Document", content: "" }];
    let currentPageIndex = 0;
    let wheelPageDelta = 0;
    let lastWheelPageTurn = 0;
    let mermaidModulePromise = null;
    const themeStorageKey = "kpe-doc-dashboard-theme";
    const navPinnedStorageKey = "content-viewer-nav-pinned";
    const navPreviewTitleOnlyStorageKey = "content-viewer-nav-title-only";
    const navWidthStorageKey = "content-viewer-nav-width";
    const tagPinnedStorageKey = "content-viewer-tag-pinned";
    const searchSessionStorageKey = "content-viewer-search";
    const themeIds = ${JSON.stringify(themeConfig.themeIds)};
    const themeAliases = ${JSON.stringify(themeConfig.themeAliases)};
    const themeMeta = ${JSON.stringify(themeConfig.themeMeta)};
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

    function cleanTag(value) {
      return String(value ?? "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
    }

    function normalizeTag(value) {
      return cleanTag(value).replace(/^#/, "").toLowerCase();
    }

    function parseTextTerms(value) {
      const terms = [];
      let current = "";
      let quote = "";

      function pushCurrent() {
        const term = current.trim().toLowerCase();
        if (term) {
          terms.push(term);
        }
        current = "";
      }

      for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
          if (character === "\\\\" && value[index + 1] === quote) {
            current += value[index + 1];
            index += 1;
          } else if (character === quote) {
            pushCurrent();
            quote = "";
          } else {
            current += character;
          }
          continue;
        }

        if (character === '"' || character === "'") {
          pushCurrent();
          quote = character;
          continue;
        }

        if (/\\s/.test(character)) {
          pushCurrent();
          continue;
        }

        current += character;
      }

      pushCurrent();
      return terms;
    }

    function parseSearchQuery(query) {
      const tagFilters = [];
      let text = String(query ?? "").replace(/tag:\\s*(?:"([^"]+)"|'([^']+)'|([^\\s]+))/gi, (match, doubleQuoted, singleQuoted, bare) => {
        const tag = cleanTag(doubleQuoted ?? singleQuoted ?? bare);
        if (tag) {
          tagFilters.push(normalizeTag(tag));
        }

        return " ";
      });

      text = text.replace(/\\btag:\\s*$/i, " ");
      return { tokens: parseTextTerms(text), tagFilters };
    }

    function facetFilterToken(item) {
      const value = cleanTag(item.label || item.value);
      const escaped = value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
      const prefix = tagFacet === "layer" ? "layer:" : "tag:";
      return /^[A-Za-z0-9._-]+$/.test(value) ? prefix + value : prefix + '"' + escaped + '"';
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

    function getFacetFieldName() {
      return tagFacet === "layer" ? "layers" : "tags";
    }

    function getFacetLabel() {
      return tagFacet === "layer" ? "layer" : "tag";
    }

    function getCurrentDocumentFacetValues() {
      const values = new Map();
      for (const item of currentDocument?.[getFacetFieldName()] ?? []) {
        const value = normalizeTag(item);
        if (value && !values.has(value)) {
          values.set(value, { value, label: cleanTag(item).replace(/^#/, "") || value });
        }
      }
      return Array.from(values.values()).sort((left, right) => left.label.localeCompare(right.label));
    }

    function setTagFacet(facet) {
      tagFacet = facet === "tags" ? "tags" : "layer";
      for (const button of tagFacetButtons) {
        const isActive = button.dataset.tagFacet === tagFacet;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
      }
      renderActiveTagList();
    }

    function setTagScope(scope) {
      tagScope = scope === "document" ? "document" : "all";
      for (const button of tagScopeButtons) {
        const isActive = button.dataset.tagScope === tagScope;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
      }
      renderActiveTagList();
    }

    function renderActiveTagList() {
      const isDocumentScope = tagScope === "document";
      const facetLabel = getFacetLabel();
      const tagItems = isDocumentScope ? getCurrentDocumentFacetValues() : allDocumentFacets[getFacetFieldName()];
      if (isDocumentScope && !currentDocument) {
        tagCount.textContent = "No document selected";
      } else if (isDocumentScope) {
        tagCount.textContent = tagItems.length === 1 ? "1 " + facetLabel + " in this document" : tagItems.length + " " + facetLabel + "s in this document";
      } else {
        tagCount.textContent = tagItems.length === 1 ? "1 " + facetLabel + " across all documents" : tagItems.length + " " + facetLabel + "s across all documents";
      }
      tagList.innerHTML = "";

      if (!tagItems.length) {
        const message = isDocumentScope
          ? (currentDocument ? "No " + facetLabel + "s for this document." : "Open a document to see its " + facetLabel + "s.")
          : "No " + facetLabel + "s found.";
        tagList.innerHTML = '<div class="empty" style="padding:12px;">' + escapeHtml(message) + "</div>";
        return;
      }

      for (const tag of tagItems) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tag-button";
        button.innerHTML =
          '<span class="tag-button-label">' + escapeHtml(tag.label || tag.value) + "</span>" +
          (tag.count ? '<span class="tag-button-count">' + escapeHtml(tag.count) + "</span>" : "");
        button.addEventListener("click", () => addFacetFilter(tag));
        tagList.appendChild(button);
      }
    }

    function addFacetFilter(item) {
      const normalizedValue = normalizeTag(item.value || item.label);
      const parsed = parseSearchQuery(searchInput.value);
      const existingFilters = tagFacet === "layer" ? parsed.layerFilters : parsed.tagFilters;
      if (!existingFilters.includes(normalizedValue)) {
        const token = facetFilterToken(item);
        searchInput.value = [searchInput.value.trim(), token].filter(Boolean).join(" ");
      }

      search();
    }

    function hasHiddenHeadingForToc(value) {
      return /(?:^|\\s)\\{[^}]*\\.hidden-heading-for-toc[^}]*\\}\\s*$/.test(String(value || ""));
    }

    function repoLabel(slug) {
      const repo = repos.find((candidate) => candidate.slug === slug);
      return repo ? repo.label : slug;
    }

    function repoTitleName(slug) {
      const repo = repos.find((candidate) => candidate.slug === slug);
      return repo?.titleName || repo?.label || slug;
    }

    function documentPageTitle(path, slug = activeRepo) {
      const filename = String(path ?? "").split("/").filter(Boolean).at(-1);
      return filename ? repoTitleName(slug) + "/" + filename : "KPE document dashboard";
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

    function documentNavigationUrl(path) {
      const currentUrl = new URL(window.location.href);
      const encodedPath = encodeDocumentPath(path);
      currentUrl.pathname = repoPathPrefix(activeRepo) + (encodedPath ? "/" + encodedPath : "");
      return currentUrl;
    }

    function updatePresentationUrl(isPresenting) {
      if (!window.history?.replaceState) {
        return;
      }

      const currentUrl = new URL(window.location.href);
      if (isPresenting) {
        currentUrl.searchParams.set("present", "1");
      } else {
        currentUrl.searchParams.delete("present");
      }
      window.history.replaceState({ repo: activeRepo, path: activePath }, "", currentUrl);
    }

    function setPresentationMode(isPresenting) {
      document.body.classList.toggle("presenting", isPresenting);
      updatePresentationUrl(isPresenting);
    }

    function getStoredSearchQuery() {
      try {
        return sessionStorage.getItem(searchSessionStorageKey) ?? "";
      } catch {
        return "";
      }
    }

    function persistSearchQuery(value) {
      try {
        const query = String(value ?? "");
        if (query) {
          sessionStorage.setItem(searchSessionStorageKey, query);
        } else {
          sessionStorage.removeItem(searchSessionStorageKey);
        }
      } catch {
        // Search remains available when browser storage is unavailable.
      }
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

    function getStoredFlag(key, defaultValue) {
      try {
        const stored = localStorage.getItem(key);
        return stored === null ? defaultValue : stored === "1";
      } catch {
        return defaultValue;
      }
    }

    function storeFlag(key, value) {
      try {
        localStorage.setItem(key, value ? "1" : "0");
      } catch {
      }
    }

    function clampNavWidth(value) {
      const maxWidth = Math.max(260, Math.min(620, window.innerWidth - 120));
      return Math.min(maxWidth, Math.max(220, Math.round(value)));
    }

    function applyNavWidth(width) {
      document.querySelector("main")?.style.setProperty("--nav-rail-width", clampNavWidth(width) + "px");
    }

    function getStoredNavWidth() {
      try {
        const stored = Number(localStorage.getItem(navWidthStorageKey));
        return Number.isFinite(stored) && stored > 0 ? stored : 320;
      } catch {
        return 320;
      }
    }

    function storeNavWidth(width) {
      try {
        localStorage.setItem(navWidthStorageKey, String(clampNavWidth(width)));
      } catch {
      }
    }

    function setNavRailOpen(isOpen) {
      if (isOpen) {
        navRail.classList.remove("suppress-open");
      }
      navRail.classList.toggle("is-open", isOpen);
      navFlyoutTrigger.setAttribute("aria-expanded", String(isOpen || navRail.classList.contains("is-pinned")));
    }

    function setTagRailOpen(isOpen) {
      if (isOpen) {
        tagRail.classList.remove("suppress-open");
      }
      tagRail.classList.toggle("is-open", isOpen);
      tagFlyoutTrigger.setAttribute("aria-expanded", String(isOpen || tagRail.classList.contains("is-pinned")));
    }

    function setNavResultPreviewMode(isTitleOnly) {
      resultsElement.dataset.previewMode = isTitleOnly ? "title-only" : "preview";
      navPreviewToggle.classList.toggle("is-active", isTitleOnly);
      navPreviewToggle.setAttribute("aria-pressed", String(isTitleOnly));
      const label = isTitleOnly ? "Show navigation previews" : "Show title-only navigation results";
      navPreviewToggle.setAttribute("aria-label", label);
      navPreviewToggle.title = label;
      storeFlag(navPreviewTitleOnlyStorageKey, isTitleOnly);
    }

    function setNavPinned(isPinned) {
      document.body.classList.toggle("nav-unpinned", !isPinned);
      navRail.classList.toggle("is-pinned", isPinned);
      navPin.classList.toggle("is-active", isPinned);
      navPin.setAttribute("aria-pressed", String(isPinned));
      const label = isPinned ? "Unpin navigation sidebar" : "Pin navigation sidebar";
      navPin.setAttribute("aria-label", label);
      navPin.title = label;
      storeFlag(navPinnedStorageKey, isPinned);
      navRail.classList.toggle("suppress-open", !isPinned);
      setNavRailOpen(isPinned);
    }

    function setTagPinned(isPinned) {
      document.body.classList.toggle("tag-pinned", isPinned);
      document.body.classList.toggle("tag-unpinned", !isPinned);
      tagRail.classList.toggle("is-pinned", isPinned);
      tagPin.classList.toggle("is-active", isPinned);
      tagPin.setAttribute("aria-pressed", String(isPinned));
      const label = isPinned ? "Unpin tag sidebar" : "Pin tag sidebar";
      tagPin.setAttribute("aria-label", label);
      tagPin.title = label;
      storeFlag(tagPinnedStorageKey, isPinned);
      tagRail.classList.toggle("suppress-open", !isPinned);
      setTagRailOpen(isPinned);
    }

    function startNavResize(event) {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = navRail.querySelector(".nav-rail-inner")?.getBoundingClientRect().width || getStoredNavWidth();
      document.body.classList.add("nav-resizing");

      function onPointerMove(moveEvent) {
        applyNavWidth(startWidth + moveEvent.clientX - startX);
      }

      function onPointerUp(moveEvent) {
        const nextWidth = startWidth + moveEvent.clientX - startX;
        applyNavWidth(nextWidth);
        storeNavWidth(nextWidth);
        document.body.classList.remove("nav-resizing");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    }

    function handleNavRailBlur(event) {
      const nextFocused = event.relatedTarget;
      if (!(nextFocused instanceof Node) || !navRail.contains(nextFocused)) {
        setNavRailOpen(false);
      }
    }

    function handleTagRailBlur(event) {
      const nextFocused = event.relatedTarget;
      if (!(nextFocused instanceof Node) || !tagRail.contains(nextFocused)) {
        setTagRailOpen(false);
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
      const requestedTheme = String(theme || "").toLowerCase();
      const aliasedTheme = themeAliases[requestedTheme] || requestedTheme;
      return themeIds.includes(aliasedTheme) ? aliasedTheme : null;
    }
    function populateThemeSelect() {
      themeSelect.innerHTML = themeIds
        .map((theme) => '<option value="' + escapeHtml(theme) + '">' + escapeHtml(themeMeta[theme].label) + "</option>")
        .join("");
    }

    function applyTheme(theme) {
      const normalizedTheme = normalizeTheme(theme) || "light";
      const meta = themeMeta[normalizedTheme];
      const mode = meta.mode;
      const colorMode = mode === "dark" ? "dark" : "light";
      document.documentElement.setAttribute("data-color-mode", colorMode);
      document.body.setAttribute("data-color-mode", colorMode);
      document.documentElement.setAttribute("data-visual-mode", mode);
      document.body.setAttribute("data-visual-mode", mode);
      document.documentElement.setAttribute("data-theme", normalizedTheme);
      document.body.setAttribute("data-theme", normalizedTheme);
      document.documentElement.style.colorScheme = colorMode;
      themeSelect.value = normalizedTheme;
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
          if (!parts.length) {
            return null;
          }
          parts.pop();
          continue;
        }
        parts.push(part);
      }
      return parts.join("/");
    }

    function resolveDocumentLinkPath(destination) {
      if (!destination.startsWith("/")) {
        return normalizeRelativePath(currentDocPath, destination);
      }

      const sourcePath = normalizeRelativePath("", destination);
      if (!sourcePath) {
        return null;
      }

      const baseSegments = String(repos.find((repo) => repo.slug === activeRepo)?.baseDir || "")
        .split("/")
        .filter(Boolean);
      const sourceSegments = sourcePath.split("/");
      if (baseSegments.some((segment, index) => sourceSegments[index] !== segment)) {
        return null;
      }

      return sourceSegments.slice(baseSegments.length).join("/") || null;
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
      const targetPath = pathPart ? resolveDocumentLinkPath(pathPart) : currentDocPath;
      if (/\\.md$/i.test(pathPart) || (!pathPart && hashPart)) {
        if (!targetPath) {
          return renderedLabel;
        }
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

    function updatePresentationTopbar() {
      if (!documentPanel || !document.body.classList.contains("presenting")) {
        documentPanel?.style.removeProperty("--presentation-topbar-height");
        return;
      }

      documentPanel.style.setProperty("--presentation-topbar-height", "36px");
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
      updatePresentationTopbar();
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
      persistSearchQuery(searchInput.value);
      const query = searchInput.value.trim();
      highlightTokens = parseSearchQuery(query).tokens.filter((token) => token.length > 1);
      statusElement.textContent = "Searching...";
      try {
        const data = await requestJson(apiUrl("/api/search", { q: query }));
        statusElement.textContent = data.count + " documents shown from " + data.total + " indexed markdown files in " + repoLabel(activeRepo);
        resultsElement.innerHTML = "";
        allDocumentFacets = {
          layers: Array.isArray(data.facets?.layers) ? data.facets.layers : (Array.isArray(data.layers) ? data.layers : []),
          tags: Array.isArray(data.facets?.tags) ? data.facets.tags : (Array.isArray(data.tags) ? data.tags : []),
        };
        renderActiveTagList();

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
      currentDocument = null;
      sourceButton.disabled = true;
      document.title = documentPageTitle(path);
      docTitle.textContent = "Loading...";
      docPath.textContent = path;
      docTags.innerHTML = "";
      docContent.className = "markdown empty";
      docContent.textContent = "Loading document...";
      try {
        const doc = await requestJson(apiUrl("/api/doc", { path }));
        currentDocument = doc;
        sourceButton.disabled = !doc.sourceUrl;
        currentPageIndex = 0;
        docTitle.textContent = doc.title;
        docPath.textContent = doc.path + " · " + new Date(doc.modified).toLocaleString();
        document.title = documentPageTitle(doc.path);
        docTags.innerHTML = doc.tags.map((tag) => '<span class="pill">' + escapeHtml(tag) + "</span>").join("");
        renderActiveTagList();
        if (options.presentMode) {
          setPresentationMode(true);
          paginateLevel.value = "---";
        }
        await renderCurrentDocument();
        if (!options.skipHistory && window.history?.pushState) {
          window.history.pushState({ repo: activeRepo, path }, "", documentNavigationUrl(path));
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
        statusElement.textContent = "Copied direct document link: " + link;
      } catch (error) {
        statusElement.textContent = "Copy failed. Direct link: " + link;
      }
    }

    async function copySourceUrl() {
      const link = currentDocument?.sourceUrl;
      if (!link) {
        statusElement.textContent = "The source Git URL is unavailable for this document.";
        return;
      }

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
        statusElement.textContent = "Copied source Git URL: " + link;
      } catch (error) {
        statusElement.textContent = "Copy failed. Source Git URL: " + link;
      }
    }

    function resetDocumentView() {
      activePath = "";
      currentDocPath = "";
      currentDocument = null;
      sourceButton.disabled = true;
      document.title = documentPageTitle("");
      currentPages = [{ title: "Document", content: "" }];
      currentPageIndex = 0;
      docTitle.textContent = "Select a document";
      docPath.textContent = "";
      docTags.innerHTML = "";
      docContent.className = "markdown empty";
      docContent.textContent = "Search results will appear on the left. Choose a result to view its markdown here.";
      renderActiveTagList();
      updatePresentationControls();
    }

    searchInput.addEventListener("input", () => {
      persistSearchQuery(searchInput.value);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, 180);
    });

    navRail.addEventListener("mouseenter", () => {
      if (!navRail.classList.contains("suppress-open")) {
        setNavRailOpen(true);
      }
    });
    navRail.addEventListener("mouseleave", () => {
      if (!navRail.classList.contains("is-pinned")) {
        setNavRailOpen(false);
      }
    });
    navRail.addEventListener("focusin", () => {
      if (!navRail.classList.contains("suppress-open")) {
        setNavRailOpen(true);
      }
    });
    navRail.addEventListener("focusout", handleNavRailBlur);
    navFlyoutTrigger.addEventListener("click", () => setNavRailOpen(true));
    navPreviewToggle.addEventListener("click", () => {
      setNavResultPreviewMode(resultsElement.dataset.previewMode !== "title-only");
    });
    navPin.addEventListener("click", () => {
      setNavPinned(!navRail.classList.contains("is-pinned"));
    });
    navResizeHandle.addEventListener("pointerdown", startNavResize);

    tagRail.addEventListener("mouseenter", () => setTagRailOpen(true));
    tagRail.addEventListener("mouseleave", () => {
      tagRail.classList.remove("suppress-open");
      if (!tagRail.classList.contains("is-pinned")) {
        setTagRailOpen(false);
      }
    });
    tagRail.addEventListener("focusin", () => setTagRailOpen(true));
    tagRail.addEventListener("focusout", handleTagRailBlur);
    tagFlyoutTrigger.addEventListener("click", () => setTagRailOpen(true));
    tagPin.addEventListener("click", () => {
      setTagPinned(!tagRail.classList.contains("is-pinned"));
    });
    tagFacetButtons.forEach((button) => {
      button.addEventListener("click", () => setTagFacet(button.dataset.tagFacet));
    });
    tagScopeButtons.forEach((button) => {
      button.addEventListener("click", () => setTagScope(button.dataset.tagScope));
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

    sourceButton.addEventListener("click", copySourceUrl);
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

    themeSelect.addEventListener("change", async () => {
      applyTheme(themeSelect.value);
      if (currentDocument) {
        await renderCurrentDocument();
      }
    });

    presentToggle.addEventListener("click", async () => {
      const isPresenting = !document.body.classList.contains("presenting");
      setPresentationMode(isPresenting);
      if (isPresenting) {
        paginateLevel.value = "---";
      }
      currentPageIndex = 0;
      wheelPageDelta = 0;
      await renderCurrentDocument();
    });

    document.addEventListener("keydown", async (event) => {
      if (event.key !== "Escape" || !document.body.classList.contains("presenting")) {
        return;
      }

      event.preventDefault();
      setPresentationMode(false);
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
      populateThemeSelect();
      applyNavWidth(getStoredNavWidth());
      setNavResultPreviewMode(getStoredFlag(navPreviewTitleOnlyStorageKey, false));
      setNavPinned(getStoredFlag(navPinnedStorageKey, true));
      setTagPinned(getStoredFlag(tagPinnedStorageKey, false));
      applyTheme(getInitialTheme());
      updatePresentationControls();
      if (initialDocPath) {
        await openDocument(initialDocPath, false, { skipHistory: true, presentMode: initialPresentMode });
      }
      const storedSearchQuery = getStoredSearchQuery();
      if (storedSearchQuery) {
        searchInput.value = storedSearchQuery;
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

        if (req.method === "GET" && url.pathname === "/theme.css") {
            await sendFile(res, THEME_CSS_PATH);
            return;
        }

        if (req.method === "GET" && url.pathname === "/theme.json") {
            await sendFile(res, THEME_JSON_PATH);
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
                facets: index.facets,
                layers: index.facets.layers,
                tags: index.facets.tags,
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
                sourceUrl: sourceDocumentUrl(state.repo, doc.sourcePath),
                title: doc.title,
                layers: doc.layers,
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
                presentMode: hasPresentationRequest(url),
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
        ? [{ ...CONFIGURED_REPOS[0], slug: "content", label: "content", path: repoPath, url: await getGitRemoteUrl(repoPath), baseDir: CONFIGURED_REPOS[0].baseDir }]
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
                    description: "Search indexed markdown documents and return matching titles, paths, snippets, and tag summaries.",
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
                            facets: index.facets,
                            layers: index.facets.layers,
                            tags: index.facets.tags,
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
