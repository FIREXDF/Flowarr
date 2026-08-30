import { expect, test } from "@playwright/test";
import type { WorkerInfo, WorkerSchedule } from "@flowarr/shared";

test("administrator signs in and reaches the dashboard", async ({ page }) => {
  let createdLibrary: Record<string, unknown> | null = null;
  let savedPriority: number | null = null;
  let savedSchedule: WorkerSchedule | null = null;
  let statisticsRange = "";
  const localWorker: WorkerInfo = {
    id: "flowarr-local", name: "media-server (local)", kind: "local", priority: 0, status: "online",
    schedule: { mode: "always", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }, scheduleActive: true,
    capabilities: { platform: "win32", architecture: "x64", cpu: "Test CPU", logicalCpus: 12, totalMemory: 32 * 1024 ** 3, freeMemory: 18 * 1024 ** 3, ffmpeg: { available: true, version: "ffmpeg version 7.1", encoders: ["libx264", "libx265"] } },
    pathMappings: [], lastSeenAt: "2026-08-27T19:00:00.000Z", createdAt: "2026-08-27T19:00:00.000Z"
  };
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { setupRequired: false } }));
  await page.route("**/api/auth/login", async (route) => {
    const body = route.request().postDataJSON() as { username: string; password: string };
    expect(body).toEqual({ username: "admin", password: "correct-horse-battery" });
    await route.fulfill({ json: { token: "e2e-token" } });
  });
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: { jobs: [], bytesSaved: 0, recent: [], active: [] } }));
  await page.route("**/api/statistics?days=*", (route) => {
    statisticsRange = new URL(route.request().url()).searchParams.get("days") ?? "";
    return route.fulfill({ json: { rangeDays: Number(statisticsRange), summary: { totalJobs: 42, succeeded: 39, failed: 3, successRate: 92.86, processedFiles: 39, bytesSaved: 128_849_018_880, sourceBytes: 644_245_094_400, averageDurationSeconds: 754, totalDurationSeconds: 29_406 }, timeline: [{ date: "2026-08-27", succeeded: 8, failed: 1, bytesSaved: 20_000 }, { date: "2026-08-28", succeeded: 16, failed: 0, bytesSaved: 50_000 }, { date: "2026-08-29", succeeded: 15, failed: 2, bytesSaved: 58_000 }], jobStatuses: [{ status: "succeeded", count: 39 }, { status: "failed", count: 3 }], codecs: [{ codec: "hevc", count: 31 }, { codec: "h264", count: 8 }], libraries: [{ name: "Movies", files: 39, bytesSaved: 128_849_018_880 }], flows: [{ name: "HEVC archive", jobs: 42, succeeded: 39 }], workers: [{ name: "media-server (local)", jobs: 42, succeeded: 39 }] } });
  });
  await page.route("**/api/workers", (route) => route.fulfill({ json: [localWorker] }));
  await page.route("**/api/workers/flowarr-local", async (route) => {
    const body = route.request().postDataJSON() as { priority?: number; schedule?: WorkerSchedule };
    if (body.priority !== undefined) { savedPriority = body.priority; localWorker.priority = body.priority; }
    if (body.schedule) { savedSchedule = body.schedule; localWorker.schedule = body.schedule; localWorker.scheduleActive = false; }
    await route.fulfill({ json: localWorker });
  });
  await page.route("**/api/flows", (route) => route.fulfill({ json: [{ id: "flow-hevc", name: "Convert H.264 to HEVC", revision: 2, updatedAt: new Date().toISOString() }] }));
  await page.route("**/api/libraries", async (route) => {
    if (route.request().method() === "POST") { createdLibrary = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 201, json: { id: "library-1", ...createdLibrary } }); }
    else await route.fulfill({ json: [] });
  });

  await page.goto("/");
  await expect(page.getByText("WELCOME BACK")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to Flowarr" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Flows/ })).toBeVisible();
  await page.getByRole("button", { name: "Nodes" }).click();
  await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
  await expect(page.getByText("Local server", { exact: true })).toBeVisible();
  await page.getByLabel("Priority for media-server (local)").fill("75");
  await page.getByLabel("Priority for media-server (local)").press("Enter");
  expect(savedPriority).toBe(75);
  await expect(page).toHaveScreenshot("nodes-empty.png", { animations: "disabled", fullPage: true });
  await page.getByLabel("Edit schedule for media-server (local)").click();
  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  await page.getByLabel("Schedule start").fill("22:00");
  await page.getByLabel("Schedule end").fill("06:00");
  await page.getByLabel("Schedule timezone").fill("Europe/Paris");
  await expect(page).toHaveScreenshot("node-schedule-dialog.png", { animations: "disabled", fullPage: true });
  await page.getByRole("button", { name: "Save schedule" }).click();
  expect(savedSchedule).toEqual({ mode: "scheduled", timezone: "Europe/Paris", days: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "06:00" });
  await page.getByRole("button", { name: "Libraries" }).click();
  await page.getByRole("button", { name: "Add library" }).click();
  await expect(page.getByLabel("Processing flow")).toHaveValue("flow-hevc");
  await expect(page).toHaveScreenshot("library-flow-dialog.png", { animations: "disabled", fullPage: true });
  await page.getByLabel("Display name").fill("Movies");
  await page.getByLabel("Server path").fill("D:\\Media");
  await page.getByRole("dialog").getByRole("button", { name: "Add library" }).click();
  expect(createdLibrary).toEqual({ name: "Movies", path: "D:\\Media", flowId: "flow-hevc", extensions: ["mkv", "mp4", "avi", "mov", "webm"], stabilitySeconds: 30 });
  await page.getByRole("button", { name: "Statistics" }).click();
  await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
  await expect(page.getByText("120 GB", { exact: true })).toBeVisible();
  await expect(page.getByText("HEVC", { exact: true })).toBeVisible();
  await expect(page.getByText("HEVC archive", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("statistics.png", { animations: "disabled", fullPage: true });
  await page.getByRole("button", { name: "7d" }).click();
  await expect.poll(() => statisticsRange).toBe("7");
});

test("first run creates the local administrator", async ({ page }) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { setupRequired: true } }));
  await page.route("**/api/auth/setup", (route) => route.fulfill({ json: { token: "setup-token" } }));
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: { jobs: [], bytesSaved: 0, recent: [], active: [] } }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create an administrator account" })).toBeVisible();
  await page.getByLabel("Password").fill("a-secure-local-password");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("flow video block configures an NVENC adapter", async ({ page }) => {
  let deleted = false;
  const graph = { version: 1, name: "GPU encode", nodes: [
    { id: "input", kind: "input", position: { x: 40, y: 120 } },
    { id: "video", kind: "video-encode", position: { x: 280, y: 120 }, config: { codec: "libx265", quality: 24, preset: "medium", device: "" } },
    { id: "success", kind: "success", position: { x: 520, y: 120 } }
  ], edges: [{ id: "a", source: "input", target: "video" }, { id: "b", source: "video", target: "success" }] };
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { setupRequired: false } }));
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { token: "gpu-test" } }));
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: { jobs: [], bytesSaved: 0, recent: [], active: [] } }));
  await page.route("**/api/flows", (route) => route.fulfill({ json: [{ id: "gpu-flow", name: "GPU encode", revision: 1, updatedAt: new Date().toISOString() }, { id: "cleanup-flow", name: "Reusable cleanup", revision: 3, updatedAt: new Date().toISOString() }] }));
  await page.route("**/api/plugins", (route) => route.fulfill({ json: { plugins: [{ schemaVersion: 1, id: "flowarr.example-media", name: "Example media tools", version: "1.0.0", description: "Reference plugin", nodes: [{ id: "cinema-crop", label: "Cinema crop", description: "Crop configurable letterboxing.", category: "Video", expandsTo: "crop", defaults: { width: 1920, height: 800, x: 0, y: 140 }, fields: [{ key: "height", label: "Plugin height", type: "number", default: 800, min: 2, max: 16384 }] }] }], errors: [] } }));
  await page.route("**/api/files", (route) => route.fulfill({ json: [{ id: "media-1", path: "D:\\Media\\movie.mkv", status: "ready", probe: { format: { durationSeconds: 7200, sizeBytes: 1_000_000 }, video: { codec: "h264", width: 1920, height: 1080, bitDepth: 8, hdr: false }, audio: [] } }] }));
  await page.route("**/api/flows/gpu-flow/test", (route) => route.fulfill({ json: { path: [{ id: "input", kind: "input" }, { id: "video", kind: "video-encode" }, { id: "success", kind: "success" }], executes: false, command: null } }));
  await page.route("**/api/flows/gpu-flow", (route) => {
    if (route.request().method() === "DELETE") { deleted = true; return route.fulfill({ status: 204, body: "" }); }
    return route.fulfill({ json: { id: "gpu-flow", graph, revision: 1 } });
  });
  await page.goto("/");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Flows" }).click();
  await page.getByLabel("Select flow").selectOption("gpu-flow");
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(page.getByText("Flow validated and saved")).toBeVisible();
  await expect(page.getByText("Flow validated and saved")).toBeHidden({ timeout: 5_000 });
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByLabel("Test media file")).toContainText("movie.mkv");
  await page.getByRole("button", { name: "Run dry test" }).click();
  await expect(page.getByRole("heading", { name: "Resolved path" })).toBeVisible();
  await expect(page.getByText("This path ends without an FFmpeg execute block.")).toBeVisible();
  await page.getByRole("button", { name: "Close flow test" }).click();
  await page.locator(".flow-node").filter({ hasText: "Encode video" }).click();
  await page.getByLabel("Video encoder").selectOption("hevc_nvenc");
  await expect(page.getByLabel("GPU index")).toHaveValue("0");
  await expect(page.getByText("Hardware acceleration: NVENC")).toBeVisible();
  await expect(page).toHaveScreenshot("flow-nvenc-settings.png", { animations: "disabled", fullPage: true });
  await page.getByRole("button", { name: "Delete block" }).click();
  await expect(page.locator(".flow-node").filter({ hasText: "Encode video" })).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.getByText(/flow errors?/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Save/ })).toBeDisabled();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".flow-node").filter({ hasText: "Encode video" })).toHaveCount(1);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.locator(".flow-node").filter({ hasText: "Encode video" })).toHaveCount(0);
  await page.locator(".flow-node").filter({ hasText: "File input" }).click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".flow-node").filter({ hasText: "File input" })).toHaveCount(0);
  await page.getByRole("button", { name: "Crop video crop" }).click();
  await expect(page.getByLabel("Width")).toHaveValue("1920");
  await page.getByLabel("Width").fill("1280");
  await expect(page.locator(".flow-node").filter({ hasText: "Crop video" })).toHaveCount(1);
  await page.getByRole("button", { name: "Call subflow subflow" }).click();
  await page.getByLabel("Referenced flow").selectOption("cleanup-flow");
  await expect(page.locator(".flow-node").filter({ hasText: "Reusable cleanup" })).toHaveCount(1);
  await expect(page.getByText("Nested subflows supported. Circular references are rejected when saving.")).toBeVisible();
  await page.getByRole("button", { name: /Cinema crop/ }).click();
  await expect(page.getByLabel("Plugin height")).toHaveValue("800");
  await page.getByLabel("Plugin height").fill("900");
  await expect(page.locator(".flow-node").filter({ hasText: "Cinema crop" })).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete flow GPU encode" }).click();
  expect(deleted).toBe(true);
  await expect(page.getByRole("heading", { name: "Build a media flow" })).toBeVisible();
});
