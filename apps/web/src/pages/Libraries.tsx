import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Pencil, Plus, ScanLine, Trash2, X } from "lucide-react";
import type { Library } from "@flowarr/shared";
import { api } from "../api";
import { PageError } from "./Dashboard";

type FlowSummary = { id: string; name: string; revision: number };

export function Libraries() {
  const [items, setItems] = useState<Library[] | null>(null);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<{ library?: Library } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError("");
    return Promise.all([api<Library[]>("/api/libraries"), api<FlowSummary[]>("/api/flows")])
      .then(([libraries, definitions]) => { setItems(libraries); setFlows(definitions); })
      .catch((value) => setLoadError(value instanceof Error ? value.message : String(value)));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const scan = async (library: Library) => {
    setActionError(""); setMessage("");
    try {
      const result = await api<{ discovered: number; skipped: number }>(`/api/libraries/${library.id}/scan`, { method: "POST" });
      setMessage(`${library.name}: ${result.discovered} discovered, ${result.skipped} still changing`);
    } catch (value) { setActionError(value instanceof Error ? value.message : String(value)); }
  };

  const assignFlow = async (libraryId: string, flowId: string) => {
    setSaving(libraryId); setActionError(""); setMessage("");
    try {
      const updated = await api<Library>(`/api/libraries/${libraryId}`, { method: "PATCH", body: JSON.stringify({ flowId }) });
      setItems((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null);
      setMessage("Library flow updated");
    } catch (value) { setActionError(value instanceof Error ? value.message : String(value)); }
    finally { setSaving(null); }
  };

  const remove = async (library: Library) => {
    if (!window.confirm(`Delete ${library.name}? Flowarr will remove its catalog and job history. Media files on disk will not be deleted.`)) return;
    setDeleting(library.id); setActionError(""); setMessage("");
    try {
      await api(`/api/libraries/${library.id}`, { method: "DELETE" });
      setItems((current) => current?.filter((item) => item.id !== library.id) ?? null);
      setMessage(`${library.name} deleted. Media files were left untouched.`);
    } catch (value) { setActionError(value instanceof Error ? value.message : String(value)); }
    finally { setDeleting(null); }
  };

  if (loadError && (!items || !flows)) return <PageError message={loadError} retry={load}/>;
  const canAdd = Boolean(flows?.length);
  return <section className="page libraries-page">
    <div className="page-head"><div><h1>Libraries</h1><p>Each library routes stable files through one selected flow.</p></div><button className="primary" onClick={() => setDialog({})} disabled={!canAdd} title={canAdd ? undefined : "Create a flow first"}><Plus size={16}/>Add library</button></div>
    {!flows?.length && flows && <div className="notice">Create a flow before adding a library. Every library needs processing logic.</div>}
    {loadError && <div className="error" role="alert">Refresh failed: {loadError}</div>}
    {actionError && <div className="error" role="alert">{actionError}</div>}
    {message && <div className="notice" role="status">{message}<button onClick={() => setMessage("")} aria-label="Dismiss"><X size={15}/></button></div>}
    {!items || !flows ? <div className="skeleton table-skeleton"/> : items.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Path</th><th>Flow</th><th>Extensions</th><th>Stability</th><th>Status</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}>
      <td><strong>{item.name}</strong></td>
      <td className="mono library-path" title={item.path}>{item.path}</td>
      <td><select className="flow-select" aria-label={`Flow for ${item.name}`} value={item.flowId ?? ""} disabled={saving === item.id || deleting === item.id} onChange={(event) => void assignFlow(item.id, event.target.value)}><option value="" disabled>Select flow</option>{flows.map((flow) => <option value={flow.id} key={flow.id}>{flow.name} · r{flow.revision}</option>)}</select></td>
      <td className="library-extensions">{item.extensions.join(", ")}</td>
      <td>{item.stabilitySeconds}s</td>
      <td><span className={`status ${item.enabled ? "ok" : "paused"}`}><i/>{item.enabled ? "Watching" : "Paused"}</span></td>
      <td><div className="library-actions"><button className="secondary small" onClick={() => void scan(item)} disabled={!item.flowId || !item.enabled || deleting === item.id}><ScanLine size={15}/>Scan</button><button className="icon" onClick={() => setDialog({ library: item })} disabled={deleting === item.id} aria-label={`Edit ${item.name}`} title="Edit library"><Pencil size={16}/></button><button className="icon danger" onClick={() => void remove(item)} disabled={deleting === item.id} aria-label={`Delete ${item.name}`} title="Delete library"><Trash2 size={16}/></button></div></td>
    </tr>)}</tbody></table></div> : <div className="empty large"><FolderOpen size={28}/><strong>No media libraries yet</strong><span>{canAdd ? "Add mounted local, SMB, or NFS storage and choose its processing flow." : "Create a flow first, then return here to add storage."}</span>{canAdd && <button className="primary" onClick={() => setDialog({})}>Add first library</button>}</div>}
    {dialog && flows?.length ? <LibraryDialog key={dialog.library?.id ?? "new"} flows={flows} library={dialog.library} close={() => setDialog(null)} saved={(saved) => { setItems((current) => dialog.library ? current?.map((item) => item.id === saved.id ? saved : item) ?? null : [...(current ?? []), saved]); setMessage(dialog.library ? `${saved.name} updated` : `${saved.name} added`); setActionError(""); setDialog(null); }}/> : null}
  </section>;
}

function LibraryDialog({ flows, library, close, saved }: { flows: FlowSummary[]; library?: Library; close: () => void; saved: (library: Library) => void }) {
  const [name, setName] = useState(library?.name ?? "");
  const [libraryPath, setLibraryPath] = useState(library?.path ?? "");
  const [flowId, setFlowId] = useState(library?.flowId ?? flows[0]?.id ?? "");
  const [extensions, setExtensions] = useState((library?.extensions ?? ["mkv", "mp4", "avi", "mov", "webm"]).join(", "));
  const [stabilitySeconds, setStabilitySeconds] = useState(library?.stabilitySeconds ?? 30);
  const [enabled, setEnabled] = useState(library?.enabled ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    const parsedExtensions = extensions.split(",").map((value) => value.trim()).filter(Boolean);
    if (!parsedExtensions.length) { setError("Enter at least one file extension"); setBusy(false); return; }
    try {
      const result = await api<Library>(library ? `/api/libraries/${library.id}` : "/api/libraries", { method: library ? "PATCH" : "POST", body: JSON.stringify({ name, path: libraryPath, flowId, extensions: parsedExtensions, stabilitySeconds, ...(library ? { enabled } : {}) }) });
      saved(result);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); setBusy(false); }
  };

  return <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}><dialog open aria-labelledby="library-dialog-title"><div className="dialog-head"><div><h2 id="library-dialog-title">{library ? "Edit library" : "Add library"}</h2></div><button className="icon" onClick={close} disabled={busy} aria-label="Close"><X size={18}/></button></div><form onSubmit={submit}>
    <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Movies" maxLength={120} required autoFocus/></label>
    <label>Server path<input className="mono" value={libraryPath} onChange={(event) => setLibraryPath(event.target.value)} placeholder="/media/movies" required/><small>Path must exist on the Flowarr server.</small></label>
    <label>Processing flow<select value={flowId} onChange={(event) => setFlowId(event.target.value)} required>{flows.map((flow) => <option value={flow.id} key={flow.id}>{flow.name} · revision {flow.revision}</option>)}</select></label>
    <div className="library-form-grid"><label>File extensions<input value={extensions} onChange={(event) => setExtensions(event.target.value)} placeholder="mkv, mp4, avi" required/><small>Comma-separated, without wildcards.</small></label><label>Stability delay<input type="number" min="1" max="86400" value={stabilitySeconds} onChange={(event) => setStabilitySeconds(Number(event.target.value))} required/><small>Seconds since last file change.</small></label></div>
    {library && <label className="library-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span><strong>Watch this library</strong><small>Paused libraries remain configured but cannot be scanned.</small></span></label>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button><button className="primary" disabled={busy}>{busy ? library ? "Saving…" : "Adding…" : library ? "Save changes" : "Add library"}</button></div>
  </form></dialog></div>;
}
