import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Database } from "./database.js";
import { createIntegration, decryptSecret, encryptSecret, listIntegrations, refreshEnabledIntegrations, refreshIntegration, testIntegration } from "./integrations.js";

test("integration secrets are encrypted and never returned", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-integrations-"));
  const database = new Database(directory);
  try {
    const created = createIntegration(database, { kind: "sonarr", name: "Series", baseUrl: "http://localhost:8989/", apiKey: "top-secret" }, "master-key");
    assert.equal(created.baseUrl, "http://localhost:8989");
    assert.equal("apiKey" in created, false);
    const stored = database.raw.prepare("SELECT api_key_encrypted AS value FROM integrations WHERE id=?").get(created.id) as { value: string };
    assert.equal(stored.value.includes("top-secret"), false);
    assert.equal(decryptSecret(stored.value, "master-key"), "top-secret");
    assert.throws(() => decryptSecret(stored.value, "wrong-key"));
  } finally { database.raw.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Sonarr, Radarr, and Jellyfin use their authenticated status endpoints", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-integrations-"));
  const database = new Database(directory);
  try {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const sonarr = createIntegration(database, { kind: "sonarr", name: "TV", baseUrl: "http://sonarr:8989", apiKey: "sonarr-key" }, "master");
    const radarr = createIntegration(database, { kind: "radarr", name: "Movies", baseUrl: "http://radarr:7878", apiKey: "radarr-key" }, "master");
    const jellyfin = createIntegration(database, { kind: "jellyfin", name: "Player", baseUrl: "http://jellyfin:8096", apiKey: "jellyfin-key" }, "master");
    await testIntegration(database, sonarr.id, "master", request);
    await testIntegration(database, radarr.id, "master", request);
    await testIntegration(database, jellyfin.id, "master", request);
    assert.deepEqual(calls.map((call) => call.url), ["http://sonarr:8989/api/v3/system/status", "http://radarr:7878/api/v3/system/status", "http://jellyfin:8096/System/Info"]);
    assert.equal(calls[0]?.headers.get("X-Api-Key"), "sonarr-key");
    assert.equal(calls[1]?.headers.get("X-Api-Key"), "radarr-key");
    assert.equal(calls[2]?.headers.get("X-Emby-Token"), "jellyfin-key");
    assert.equal(listIntegrations(database).every((item) => item.lastTestAt && !item.lastError), true);
  } finally { database.raw.close(); await rm(directory, { recursive: true, force: true }); }
});

test("successful jobs trigger throttled Arr rescans and Jellyfin refresh", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-integrations-"));
  const database = new Database(directory);
  try {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(null, { status: 202 });
    };
    const sonarr = createIntegration(database, { kind: "sonarr", name: "TV", baseUrl: "http://sonarr:8989", apiKey: "s", syncOnSuccess: true }, "master");
    createIntegration(database, { kind: "radarr", name: "Movies", baseUrl: "http://radarr:7878", apiKey: "r", syncOnSuccess: true }, "master");
    const jellyfin = createIntegration(database, { kind: "jellyfin", name: "Player", baseUrl: "http://jellyfin:8096", apiKey: "j" }, "master");
    assert.equal(await refreshEnabledIntegrations(database, "master", request), 2);
    assert.equal(await refreshEnabledIntegrations(database, "master", request), 0);
    await refreshIntegration(database, jellyfin.id, "master", request);
    assert.deepEqual(calls.map((call) => call.url), ["http://sonarr:8989/api/v3/command", "http://radarr:7878/api/v3/command", "http://jellyfin:8096/Library/Refresh"]);
    assert.deepEqual(calls.slice(0, 2).map((call) => JSON.parse(call.body)), [{ name: "RescanSeries" }, { name: "RescanMovie" }]);
    assert.equal(calls[2]?.method, "POST");
    assert.ok(listIntegrations(database).find((item) => item.id === sonarr.id)?.lastSyncAt);
  } finally { database.raw.close(); await rm(directory, { recursive: true, force: true }); }
});
test("failed connection tests retain a useful status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-integrations-"));
  const database = new Database(directory);
  try {
    const integration = createIntegration(database, { kind: "jellyfin", name: "Media", baseUrl: "http://jellyfin:8096", apiKey: "bad" }, "master");
    const denied: typeof fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(() => testIntegration(database, integration.id, "master", denied), /Jellyfin connection failed: HTTP 401/);
    assert.equal(listIntegrations(database)[0]?.lastError, "HTTP 401");
  } finally { database.raw.close(); await rm(directory, { recursive: true, force: true }); }
});

test("secret encryption round trip", () => {
  const encrypted = encryptSecret("value", "key");
  assert.notEqual(encrypted, "value");
  assert.equal(decryptSecret(encrypted, "key"), "value");
});