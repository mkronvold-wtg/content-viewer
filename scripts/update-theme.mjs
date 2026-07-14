import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REPO = "mkronvold/themes";
const SOURCE_REF = process.env.CONTENT_VIEWER_THEME_REF || "main";
const THEME_FILES = ["theme.css", "theme.json"];
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function decodeContent(payload, filePath) {
    if (payload.encoding !== "base64" || typeof payload.content !== "string") {
        throw new Error(`Unexpected GitHub content payload for ${filePath}`);
    }

    return Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
}

async function fetchWithToken(filePath, token) {
    const url = `https://api.github.com/repos/${SOURCE_REPO}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(SOURCE_REF)}`;
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
        `ref=${SOURCE_REF}`,
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

const fetchedFiles = new Map();
for (const filePath of THEME_FILES) {
    const content = await fetchThemeFile(filePath);
    fetchedFiles.set(filePath, content);
    writeFileSync(path.join(ROOT_DIR, filePath), content, "utf8");
    console.log(`Updated ${filePath} from ${SOURCE_REPO}@${SOURCE_REF}`);
}

const themeJson = JSON.parse(fetchedFiles.get("theme.json"));
const themeCount = Object.keys(themeJson.themes ?? {}).length;
if (!themeCount) {
    throw new Error("Updated theme.json does not define any themes");
}

console.log(`Theme manifest includes ${themeCount} themes`);
