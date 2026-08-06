import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REPO = "mkronvold/themes";
const SOURCE_COMMIT = process.env.CONTENT_VIEWER_THEME_COMMIT;
const THEME_FILES = ["theme.css", "theme.json"];
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!/^[0-9a-f]{40}$/i.test(SOURCE_COMMIT ?? "")) {
    throw new Error(
        "CONTENT_VIEWER_THEME_COMMIT must be the full 40-character commit SHA from mkronvold/themes",
    );
}

function decodeContent(payload, filePath) {
    if (payload.encoding !== "base64" || typeof payload.content !== "string") {
        throw new Error(`Unexpected GitHub content payload for ${filePath}`);
    }

    return Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
}

async function fetchWithToken(filePath, token) {
    const url = `https://api.github.com/repos/${SOURCE_REPO}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(SOURCE_COMMIT)}`;
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status} for ${filePath}`);
    }

    return decodeContent(await response.json(), filePath);
}

function fetchWithGh(filePath) {
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;

    const output = execFileSync("gh", [
        "api",
        "--method",
        "GET",
        `repos/${SOURCE_REPO}/contents/${filePath}`,
        "-f",
        `ref=${SOURCE_COMMIT}`,
    ], {
        cwd: ROOT_DIR,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    return decodeContent(JSON.parse(output), filePath);
}

async function fetchThemeFile(filePath) {
    const token = process.env.CONTENT_VIEWER_THEME_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
        try {
            return await fetchWithToken(filePath, token);
        } catch (error) {
            console.warn(`Token fetch failed for ${filePath}: ${error.message}`);
        }
    }

    return fetchWithGh(filePath);
}

const fetchedFiles = new Map(
    await Promise.all(THEME_FILES.map(async (filePath) => [filePath, await fetchThemeFile(filePath)])),
);
for (const filePath of THEME_FILES) {
    const content = fetchedFiles.get(filePath);
    writeFileSync(path.join(ROOT_DIR, filePath), content, "utf8");
    console.log(`Updated ${filePath} from ${SOURCE_REPO}@${SOURCE_COMMIT}`);
}

const themeJson = JSON.parse(fetchedFiles.get("theme.json"));
const themeCount = Object.keys(themeJson.themes ?? {}).length;
if (!themeCount) {
    throw new Error("Updated theme.json does not define any themes");
}

console.log(`Theme manifest includes ${themeCount} themes`);
