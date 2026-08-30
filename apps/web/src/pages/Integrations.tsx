import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, Clapperboard, Film, KeyRound, Plus, RefreshCcw, RefreshCw, TestTube2, Trash2, Tv } from "lucide-react";
import type { Integration, IntegrationKind } from "@flowarr/shared";
import { api } from "../api";
import { PageError } from "./Dashboard";

const providers: Array<{ kind: IntegrationKind; label: string; detail: string; icon: typeof Tv }> = [
  { kind: "sonarr", label: "Sonarr", detail: "Series management", icon: Tv },
  { kind: "radarr", label: "Radarr", detail: "Movie management", icon: Film },
  { kind: "jellyfin", label: "Jellyfin", detail: "Media server", icon: Clapperboard }
];

const emptyForm = (kind: IntegrationKind = "sonarr") => ({ kind, name: "", baseUrl: "", apiKey: "", syncOnSuccess: false });

export function Integrations() {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(() => {
    setError("");
    return api<Integration[]>("/api/integrations").then(setItems).catch((value) => setError(value.message));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      const created = await api<Integration>("/api/integrations", { method: "POST", body: JSON.stringify(form) });
      setItems((current) => [...(current ?? []), created].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
      setNotice(providerName(created.kind) + " connection saved. Test it before relying on it.");
      setForm(emptyForm(form.kind));
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setSaving(false); }
  };

  const test = async (id: string) => {
    setTesting(id); setError(""); setNotice("");
    try {
      const updated = await api<Integration>("/api/integrations/" + id + "/test", { method: "POST" });
      setItems((current) => current?.map((item) => item.id === id ? updated : item) ?? null);
      setNotice(updated.name + " answered successfully.");
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); await load(); }
    finally { setTesting(null); }
  };

    const refresh = async (id: string) => {
    setSyncing(id); setError(""); setNotice("");
    try {
      const updated = await api<Integration>("/api/integrations/" + id + "/refresh", { method: "POST" });
      setItems((current) => current?.map((item) => item.id === id ? updated : item) ?? null);
      setNotice(updated.name + " refresh accepted.");
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); await load(); }
    finally { setSyncing(null); }
  };
const remove = async (integration: Integration) => {
    if (!window.confirm("Remove " + integration.name + "? Its stored API key will be deleted.")) return;
    setError(""); setNotice("");
    try {
      await api("/api/integrations/" + integration.id, { method: "DELETE" });
      setItems((current) => current?.filter((item) => item.id !== integration.id) ?? null);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };

  if (error && !items) return <PageError message={error} retry={load}/>;
  const selected = providers.find((provider) => provider.kind === form.kind)!;
  return <section className="page integrations-page">
    <div className="page-head">
      <div><h1>Integrations</h1><p>Connect Flowarr to the services already organizing and serving your media.</p></div>
      <button className="secondary" onClick={load}><RefreshCw size={16}/>Refresh</button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="integration-notice" role="status"><Check size={15}/>{notice}</div>}
    <div className="integration-workbench">
      <div className="connection-area">
        <div className="section-heading"><div><h2>Connections</h2><p>API keys stay encrypted on this server.</p></div><span>{items?.length ?? 0} configured</span></div>
        {!items ? <div className="skeleton integration-skeleton"/> : items.length ? <div className="connection-list">
          {items.map((integration) => {
            const provider = providers.find((entry) => entry.kind === integration.kind)!;
            const Icon = provider.icon;
            const state = !integration.lastTestAt ? "untested" : integration.lastError ? "failed" : "connected";
            return <article className="connection-row" key={integration.id}>
              <div className={"provider-mark " + integration.kind}><Icon size={21}/></div>
              <div className="connection-identity"><strong>{integration.name}</strong><span>{provider.label} · {integration.baseUrl}</span><small className={integration.syncOnSuccess ? "automation-line active" : "automation-line"}>{integration.syncOnSuccess ? "Auto refresh after completed jobs" : "Manual refresh"}</small></div>
              <div className={"connection-state " + state}>
                {state === "failed" ? <CircleAlert size={14}/> : state === "connected" ? <Check size={14}/> : <span className="state-dot"/>}
                <div><strong>{state === "failed" ? "Needs attention" : state === "connected" ? "Connected" : "Not tested"}</strong><small>{integration.lastTestAt ? new Date(integration.lastTestAt).toLocaleString() : "Run first check"}</small></div>
              </div>
              <div className="connection-actions"><button className="secondary" disabled={syncing === integration.id} onClick={() => void refresh(integration.id)}><RefreshCcw size={15}/>{syncing === integration.id ? "Refreshing…" : "Refresh"}</button><button className="secondary" disabled={testing === integration.id} onClick={() => void test(integration.id)}><TestTube2 size={15}/>{testing === integration.id ? "Testing…" : "Test"}</button><button className="icon danger" onClick={() => void remove(integration)} aria-label={"Remove " + integration.name}><Trash2 size={16}/></button></div>
              {integration.lastError && <p className="connection-error">{integration.lastError}</p>}
            </article>;
          })}
        </div> : <div className="empty integration-empty"><KeyRound size={27}/><strong>No media service connected</strong><span>Add Sonarr, Radarr, or Jellyfin. Flowarr verifies credentials without exposing them to browser again.</span></div>}
      </div>
      <aside className="connection-setup">
        <div className="setup-title"><Plus size={17}/><div><h2>Add connection</h2><p>Choose service, then enter its local URL and API key.</p></div></div>
        <div className="provider-picker" role="radiogroup" aria-label="Service provider">
          {providers.map(({ kind, label, icon: Icon }) => <button type="button" role="radio" aria-checked={form.kind === kind} className={form.kind === kind ? "selected " + kind : ""} key={kind} onClick={() => setForm(emptyForm(kind))}><Icon size={18}/><span>{label}</span></button>)}
        </div>
        <form onSubmit={submit}>
          <label>Connection name<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder={selected.label} required/></label>
          <label>Server URL<input type="url" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder={form.kind === "sonarr" ? "http://sonarr:8989" : form.kind === "radarr" ? "http://radarr:7878" : "http://jellyfin:8096"} required/><small>Use URL reachable from Flowarr server.</small></label>
          <label>API key<input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder="Paste API key" required/><small>Stored encrypted; never returned by API.</small></label>
          <label className="sync-option"><input type="checkbox" checked={form.syncOnSuccess} onChange={(event) => setForm((current) => ({ ...current, syncOnSuccess: event.target.checked }))}/><span><strong>Refresh after completed jobs</strong><small>At most once every 15 minutes to avoid scan storms.</small></span></label>
          <button className="primary connection-submit" disabled={saving}><Plus size={16}/>{saving ? "Saving…" : "Connect " + selected.label}</button>
        </form>
      </aside>
    </div>
  </section>;
}

function providerName(kind: IntegrationKind): string { return providers.find((provider) => provider.kind === kind)?.label ?? kind; }