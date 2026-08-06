import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const image = process.env.CONTENT_VIEWER_TEST_IMAGE ?? "content-viewer:ci";
const suffix = `${process.pid}-${randomUUID().slice(0, 12)}`;
const container = `content-viewer-smoke-${suffix}`;
const volume = `content-viewer-smoke-${suffix}`;
const healthProbe = [
    "fetch('http://127.0.0.1:8080/api/health')",
    ".then(async (response) => {",
    "const body = await response.json();",
    "process.exit(response.ok && body.ok === true ? 0 : 1);",
    "})",
    ".catch(() => process.exit(1));",
].join("");
const pidOneUserProbe = [
    "const status = require('node:fs').readFileSync('/proc/1/status', 'utf8');",
    "const uid = /^Uid:\\s+(\\d+)/m.exec(status)?.[1];",
    "if (!uid || uid === '0') process.exit(1);",
    "console.log(uid);",
].join("");

async function docker(args, options = {}) {
    return execFileAsync("docker", args, {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...options,
    });
}

async function cleanup() {
    await docker(["rm", "--force", container]).catch(() => {});
    await docker(["volume", "rm", "--force", volume]).catch(() => {});
}

async function waitForHealth() {
    const deadline = Date.now() + 60_000;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            await docker(["exec", container, "node", "-e", healthProbe]);
            return;
        } catch (error) {
            lastError = error.stderr || error.message;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`Container did not become ready at /api/health within 60 seconds: ${lastError.trim()}`);
}

try {
    try {
        await docker(["info", "--format", "{{.ServerVersion}}"]);
    } catch (error) {
        throw new Error(`Docker is required for the final-image smoke test: ${(error.stderr || error.message).trim()}`);
    }

    await docker(["image", "inspect", image]);
    await docker(["volume", "create", volume]);
    await docker([
        "run",
        "--detach",
        "--name", container,
        "--network", "none",
        "--mount", `type=volume,source=${volume},target=/app/content`,
        image,
    ]);

    await waitForHealth();
    const { stdout: configuredUser } = await docker(["inspect", "--format", "{{.Config.User}}", container]);
    const { stdout: pidOneUid } = await docker(["exec", container, "node", "-e", pidOneUserProbe]);
    if (!configuredUser.trim() || pidOneUid.trim() === "0") {
        throw new Error("Final image is running as root");
    }

    console.log(`Final-image smoke test passed for ${image} (${configuredUser.trim()}, PID 1 UID ${pidOneUid.trim()}).`);
} finally {
    await cleanup();
}
