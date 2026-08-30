import { createHmac } from "node:crypto";
import type { ServerResponse } from "node:http";

export type WebhookPayload = { id: string; status: "succeeded" | "failed"; [key: string]: unknown };

export class WebhookNotifier {
  constructor(private url: string, private secret?: string, private request: typeof fetch = fetch) {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new Error("Webhook URL must use HTTP or HTTPS");
  }
  async notify(job: WebhookPayload): Promise<void> {
    const body = JSON.stringify({ event: "job.completed", occurredAt: new Date().toISOString(), job });
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Flowarr/0.1" };
    if (this.secret) headers["x-flowarr-signature"] = `sha256=${createHmac("sha256", this.secret).update(body).digest("hex")}`;
    const response = await this.request(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
  }
}

export class EventHub {
  private clients = new Set<ServerResponse>();
  constructor(private notifier?: WebhookNotifier, private onJobSucceeded?: (job: WebhookPayload) => void | Promise<void>) {}
  add(response: ServerResponse) { this.clients.add(response); response.on("close", () => this.clients.delete(response)); }
  send(event: string, payload: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) client.write(message);
    if (event === "job" && isCompletedJob(payload)) {
      void this.notifier?.notify(payload).catch((error) => console.warn("Webhook notification failed:", error));
      if (payload.status === "succeeded") void Promise.resolve(this.onJobSucceeded?.(payload)).catch((error) => console.warn("Integration refresh failed:", error));
    }
  }
}

function isCompletedJob(payload: unknown): payload is WebhookPayload {
  if (!payload || typeof payload !== "object") return false;
  const job = payload as Record<string, unknown>;
  return typeof job.id === "string" && (job.status === "succeeded" || job.status === "failed");
}