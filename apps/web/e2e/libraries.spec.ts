import { expect, test } from "@playwright/test";
import type { Library } from "@flowarr/shared";

test("administrator edits and deletes a library", async ({ page }) => {
  let deleted = false;
  let updateBody: Record<string, unknown> | null = null;
  let library: Library = {
    id: "library-1", name: "Movies", path: "/media/movies", flowId: "flow-hevc", enabled: true,
    priority: 0, extensions: ["mkv", "mp4"], stabilitySeconds: 30, createdAt: "2026-08-30T10:00:00.000Z"
  };
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { setupRequired: false } }));
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { token: "library-test" } }));
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: { jobs: [], bytesSaved: 0, recent: [], active: [] } }));
  await page.route("**/api/flows", (route) => route.fulfill({ json: [{ id: "flow-hevc", name: "HEVC archive", revision: 2 }] }));
  await page.route("**/api/libraries", (route) => route.fulfill({ json: [library] }));
  await page.route("**/api/libraries/library-1", async (route) => {
    if (route.request().method() === "DELETE") { deleted = true; return route.fulfill({ status: 204, body: "" }); }
    updateBody = route.request().postDataJSON() as Record<string, unknown>;
    library = { ...library, ...updateBody, extensions: ["mkv", "webm"] };
    return route.fulfill({ json: library });
  });

  await page.goto("/");
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Libraries" }).click();
  await page.getByRole("button", { name: "Edit Movies" }).click();
  await expect(page.getByRole("heading", { name: "Edit library" })).toBeVisible();
  await expect(page.getByLabel("Server path")).toHaveValue("/media/movies");
  await page.getByLabel("Display name").fill("Movie archive");
  await page.getByLabel("File extensions").fill("mkv, webm");
  await page.getByLabel("Stability delay").fill("90");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect(updateBody).toEqual({ name: "Movie archive", path: "/media/movies", flowId: "flow-hevc", extensions: ["mkv", "webm"], stabilitySeconds: 90, enabled: true });
  await expect(page.getByText("Movie archive", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Movie archive" }).click();
  expect(deleted).toBe(true);
  await expect(page.getByText("No media libraries yet")).toBeVisible();
});
