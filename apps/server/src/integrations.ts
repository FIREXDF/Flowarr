import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Integration, IntegrationKind } from "@flowarr/shared";
import type { Database } from "./database.js";

type IntegrationRow = {
  id: string; kind: IntegrationKind; name: string; base_url: string; api_key_encrypted: string;
  enabled: number; sync_on_success: number; last_test_at: string | null; last_sync_at: string | null;
  last_error: string | null; created_at: string; updated_at: string;
};

export type IntegrationInput = { kind: IntegrationKind; name: string; baseUrl: string; apiKey: string; enabled?: boolean; syncOnSuccess?: boolean };
export type IntegrationUpdate = Partial<Omit<IntegrationInput, "kind">>;

export function listIntegrations(database: Database): Integration[] {
  return (database.raw.prepare("SELECT * FROM integrations ORDER BY kind,name").all() as IntegrationRow[]).map(publicIntegration);
}

export function createIntegration(database: Database, input: IntegrationInput, keyMaterial: string): Integration {
  validateKind(input.kind);
  const name = input.name.trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!name) throw new Error("Name is required");
  if (!input.apiKey.trim()) throw new Error("API key is required");
  const id = randomUUID(); const now = new Date().toISOString();
  database.raw.prepare("INSERT INTO integrations (id,kind,name,base_url,api_key_encrypted,enabled,sync_on_success,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, input.kind, name, baseUrl, encryptSecret(input.apiKey.trim(), keyMaterial), input.enabled === false ? 0 : 1, input.syncOnSuccess ? 1 : 0, now, now);
  return getIntegration(database, id)!;
}

export function updateIntegration(database: Database, id: string, input: IntegrationUpdate, keyMaterial: string): Integration | null {
  const current = database.raw.prepare("SELECT * FROM integrations WHERE id=?").get(id) as IntegrationRow | undefined;
  if (!current) return null;
  const name = input.name === undefined ? current.name : input.name.trim();
  if (!name) throw new Error("Name is required");
  const baseUrl = input.baseUrl === undefined ? current.base_url : normalizeBaseUrl(input.baseUrl);
  const encrypted = input.apiKey?.trim() ? encryptSecret(input.apiKey.trim(), keyMaterial) : current.api_key_encrypted;
  database.raw.prepare("UPDATE integrations SET name=?,base_url=?,api_key_encrypted=?,enabled=?,sync_on_success=?,last_test_at=NULL,last_error=NULL,updated_at=? WHERE id=?")
    .run(name, baseUrl, encrypted, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, input.syncOnSuccess === undefined ? current.sync_on_success : input.syncOnSuccess ? 1 : 0, new Date().toISOString(), id);
  return getIntegration(database, id);
}

export function deleteIntegration(database: Database, id: string): boolean {
  return Boolean(database.raw.prepare("DELETE FROM integrations WHERE id=?").run(id).changes);
}

export async function testIntegration(database: Database, id: string, keyMaterial: string, request: typeof fetch = fetch): Promise<Integration> {
  const row = getPrivateIntegration(database, id);
  const endpoint = row.kind === "jellyfin" ? "/System/Info" : "/api/v3/system/status";
  const testedAt = new Date().toISOString();
  try {
    const response = await request(row.base_url + endpoint, { headers: authHeaders(row, keyMaterial), signal: AbortSignal.timeout(7_000) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    database.raw.prepare("UPDATE integrations SET last_test_at=?,last_error=NULL,updated_at=? WHERE id=?").run(testedAt, testedAt, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.raw.prepare("UPDATE integrations SET last_test_at=?,last_error=?,updated_at=? WHERE id=?").run(testedAt, message.slice(0, 500), testedAt, id);
    throw new Error(providerLabel(row.kind) + " connection failed: " + message);
  }
  return getIntegration(database, id)!;
}

export async function refreshIntegration(database: Database, id: string, keyMaterial: string, request: typeof fetch = fetch): Promise<Integration> {
  const row = getPrivateIntegration(database, id);
  const syncedAt = new Date().toISOString();
  database.raw.prepare("UPDATE integrations SET last_sync_at=?,updated_at=? WHERE id=?").run(syncedAt, syncedAt, id);
  const endpoint = row.kind === "jellyfin" ? "/Library/Refresh" : "/api/v3/command";
  const body = row.kind === "jellyfin" ? undefined : JSON.stringify({ name: row.kind === "sonarr" ? "RescanSeries" : "RescanMovie" });
  try {
    const response = await request(row.base_url + endpoint, { method: "POST", headers: { ...authHeaders(row, keyMaterial), ...(body ? { "content-type": "application/json" } : {}) }, body, signal: AbortSignal.timeout(7_000) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    database.raw.prepare("UPDATE integrations SET last_error=NULL,updated_at=? WHERE id=?").run(syncedAt, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.raw.prepare("UPDATE integrations SET last_error=?,updated_at=? WHERE id=?").run(message.slice(0, 500), syncedAt, id);
    throw new Error(providerLabel(row.kind) + " refresh failed: " + message);
  }
  return getIntegration(database, id)!;
}

export async function refreshEnabledIntegrations(database: Database, keyMaterial: string, request: typeof fetch = fetch): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = database.raw.prepare("SELECT id FROM integrations WHERE enabled=1 AND sync_on_success=1 AND (last_sync_at IS NULL OR last_sync_at<?)").all(cutoff) as Array<{ id: string }>;
  await Promise.allSettled(rows.map((row) => refreshIntegration(database, row.id, keyMaterial, request)));
  return rows.length;
}

export function encryptSecret(value: string, keyMaterial: string): string {
  const key = createHash("sha256").update(keyMaterial).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: string, keyMaterial: string): string {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Unsupported encrypted secret");
  const key = createHash("sha256").update(keyMaterial).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function getPrivateIntegration(database: Database, id: string): IntegrationRow {
  const row = database.raw.prepare("SELECT * FROM integrations WHERE id=?").get(id) as IntegrationRow | undefined;
  if (!row) throw new Error("Integration not found");
  return row;
}
function getIntegration(database: Database, id: string): Integration | null {
  const row = database.raw.prepare("SELECT * FROM integrations WHERE id=?").get(id) as IntegrationRow | undefined;
  return row ? publicIntegration(row) : null;
}
function publicIntegration(row: IntegrationRow): Integration {
  return { id: row.id, kind: row.kind, name: row.name, baseUrl: row.base_url, enabled: Boolean(row.enabled), syncOnSuccess: Boolean(row.sync_on_success), hasApiKey: true, lastTestAt: row.last_test_at, lastSyncAt: row.last_sync_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}
function authHeaders(row: IntegrationRow, keyMaterial: string): Record<string, string> {
  return { [row.kind === "jellyfin" ? "X-Emby-Token" : "X-Api-Key"]: decryptSecret(row.api_key_encrypted, keyMaterial) };
}
function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}
function validateKind(kind: string): asserts kind is IntegrationKind {
  if (!["sonarr", "radarr", "jellyfin"].includes(kind)) throw new Error("Unsupported integration");
}
function providerLabel(kind: IntegrationKind): string { return kind === "sonarr" ? "Sonarr" : kind === "radarr" ? "Radarr" : "Jellyfin"; }