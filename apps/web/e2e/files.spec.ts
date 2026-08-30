import { expect, test } from "@playwright/test";

test("failed file reveals its job logs inline", async ({ page }) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { setupRequired: false } }));
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { token: "files-test" } }));
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: { jobs: [], bytesSaved: 0, recent: [], active: [] } }));
  await page.route("**/api/files?status=*", (route) => {
    const status = new URL(route.request().url()).searchParams.get("status");
    return route.fulfill({ json: status === "failed" ? [{ id: "file-1", libraryId: "library-1", name: "movie.mkv", path: "/media/movie.mkv", size: 1_000_000, status: "failed", probe: null, savingsBytes: 0, detectedAt: "2026-08-30T10:00:00.000Z", failureJobId: "job-failed-1" }] : [] });
  });
  await page.route("**/api/jobs/job-failed-1/logs", (route) => route.fulfill({ json: [
    { level: "INFO", message: "FFmpeg started", detail: null, createdAt: "2026-08-30T10:01:00.000Z" },
    { level: "ERROR", message: "Transcode failed", detail: "{\"stderr\":\"No space left on device\"}", createdAt: "2026-08-30T10:02:00.000Z" }
  ] }));

  await page.goto("/");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Files" }).click();
  await page.getByRole("tab", { name: "Failed" }).click();
  await page.getByRole("button", { name: "View logs" }).click();
  await expect(page.getByRole("region", { name: "Failure logs for movie.mkv" })).toBeVisible();
  await expect(page.getByText("Transcode failed", { exact: false })).toBeVisible();
  await expect(page.getByText("No space left on device", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide logs" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Hide logs" }).click();
  await expect(page.getByRole("region", { name: "Failure logs for movie.mkv" })).toHaveCount(0);
});
