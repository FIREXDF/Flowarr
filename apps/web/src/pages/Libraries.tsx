import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Plus, ScanLine, X } from "lucide-react";
import type { Library } from "@flowarr/shared";
import { api } from "../api";
import { PageError } from "./Dashboard";

type FlowSummary = { id: string; name: string; revision: number };

export function Libraries() {
  const [items, setItems] = useState<Library[] | null>(null);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [error, setError] = useState(""); const [open, setOpen] = useState(false); const [message, setMessage] = useState(""); const [saving, setSaving] = useState<string | null>(null);
  const load = useCallback(() => Promise.all([api<Library[]>("/api/libraries"), api<FlowSummary[]>("/api/flows")]).then(([libraries, definitions]) => { setItems(libraries); setFlows(definitions); }).catch((value) => setError(value.message)), []);
  useEffect(() => { void load(); }, [load]);
  const scan = async (id: string) => { try { const result = await api<{ discovered: number; skipped: number }>(`/api/libraries/${id}/scan`, { method: "POST" }); setMessage(`${result.discovered} discovered, ${result.skipped} still changing`); } catch (value) { setMessage(value instanceof Error ? value.message : String(value)); } };
  const assignFlow = async (libraryId: string, flowId: string) => { setSaving(libraryId); try { await api(`/api/libraries/${libraryId}`, { method: "PATCH", body: JSON.stringify({ flowId }) }); setMessage("Library flow updated"); await load(); } catch (value) { setMessage(value instanceof Error ? value.message : String(value)); } finally { setSaving(null); } };
  if (error) return <PageError message={error} retry={load}/>;
  const canAdd = Boolean(flows?.length);
  return <section className="page"><div className="page-head"><div><h1>Libraries</h1><p>Each library routes stable files through one selected flow.</p></div><button className="primary" onClick={() => setOpen(true)} disabled={!canAdd} title={canAdd ? undefined : "Create a flow first"}><Plus size={16}/>Add library</button></div>
    {!flows?.length && flows && <div className="notice">Create a flow before adding a library. Every library needs processing logic.</div>}
    {message && <div className="notice">{message}<button onClick={() => setMessage("")} aria-label="Dismiss"><X size={15}/></button></div>}
    {!items || !flows ? <div className="skeleton table-skeleton"/> : items.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Path</th><th>Flow</th><th>Extensions</th><th>Stability</th><th>Status</th><th/></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td className="mono">{item.path}</td><td><select className="flow-select" aria-label={`Flow for ${item.name}`} value={item.flowId ?? ""} disabled={saving === item.id} onChange={(event) => void assignFlow(item.id, event.target.value)}><option value="" disabled>Select flow</option>{flows.map((flow) => <option value={flow.id} key={flow.id}>{flow.name} · r{flow.revision}</option>)}</select></td><td>{item.extensions.join(", ")}</td><td>{item.stabilitySeconds}s</td><td><span className="status ok"><i/>Watching</span></td><td><button className="secondary small" onClick={() => scan(item.id)} disabled={!item.flowId}><ScanLine size={15}/>Scan</button></td></tr>)}</tbody></table></div> : <div className="empty large"><FolderOpen size={28}/><strong>No media libraries yet</strong><span>{canAdd ? "Add mounted local, SMB, or NFS storage and choose its processing flow." : "Create a flow first, then return here to add storage."}</span>{canAdd && <button className="primary" onClick={() => setOpen(true)}>Add first library</button>}</div>}
    {open && flows?.length ? <LibraryDialog flows={flows} close={() => setOpen(false)} saved={() => { setOpen(false); void load(); }}/> : null}</section>;
}

function LibraryDialog({ flows, close, saved }: { flows: FlowSummary[]; close: () => void; saved: () => void }) {
  const [name, setName] = useState(""); const [path, setPath] = useState(""); const [flowId, setFlowId] = useState(flows[0]?.id ?? ""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await api("/api/libraries", { method: "POST", body: JSON.stringify({ name, path, flowId }) }); saved(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); setBusy(false); } };
  return <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}><dialog open><div className="dialog-head"><div><p className="eyebrow">NEW WATCH ROOT</p><h2>Add library</h2></div><button className="icon" onClick={close} aria-label="Close"><X size={18}/></button></div><form onSubmit={submit}><label>Display name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Movies" required autoFocus/></label><label>Server path<input className="mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/media/movies" required/><small>Path must exist on the Flowarr server.</small></label><label>Processing flow<select value={flowId} onChange={(event) => setFlowId(event.target.value)} required>{flows.map((flow) => <option value={flow.id} key={flow.id}>{flow.name} · revision {flow.revision}</option>)}</select><small>Stable files from this library will follow this flow.</small></label>{error && <div className="error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Adding…" : "Add library"}</button></div></form></dialog></div>;
}
