import { useCallback, useEffect, useState } from "react";
import { FileVideo2, Play, RefreshCw } from "lucide-react";
import type { FileStatus, MediaFile } from "@flowarr/shared";
import { api } from "../api";
import { PageError } from "./Dashboard";

const tabs: Array<{ status: FileStatus; label: string }> = [
  { status: "detected", label: "Detected" }, { status: "queued", label: "Queued" }, { status: "processing", label: "Processing" }, { status: "processed", label: "Processed" }, { status: "failed", label: "Failed" }, { status: "ignored", label: "Ignored" }
];
const formatBytes = (bytes: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(bytes) + "B";

export function FilesPage() {
  const [status, setStatus] = useState<FileStatus>("detected"); const [files, setFiles] = useState<MediaFile[] | null>(null); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { setFiles(null); setError(""); api<MediaFile[]>(`/api/files?status=${status}`).then(setFiles).catch((e) => setError(e.message)); }, [status]);
  useEffect(() => { void load(); }, [load]);
  const process = async (id: string) => { setBusy(id); try { const result = await api<{ jobId: string }>(`/api/files/${id}/process`, { method: "POST" }); setNotice(`Job ${result.jobId.slice(0, 8)} queued`); await load(); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } };
  if (error) return <PageError message={error} retry={load}/>;
  return <section className="page"><div className="page-head"><div><h1>Files</h1><p>Every detected file, queue decision, result, and failure.</p></div><button className="secondary" onClick={load}><RefreshCw size={16}/>Refresh</button></div>
    <div className="tabs" role="tablist">{tabs.map((tab) => <button role="tab" aria-selected={status === tab.status} className={status === tab.status ? "selected" : ""} key={tab.status} onClick={() => setStatus(tab.status)}>{tab.label}</button>)}</div>{notice && <div className="notice">{notice}</div>}
    {!files ? <div className="skeleton table-skeleton"/> : files.length ? <div className="table-wrap"><table><thead><tr><th>File</th><th>Size</th><th>Media</th><th>Status</th><th>Detected</th><th/></tr></thead><tbody>{files.map((file) => <tr key={file.id}><td><strong>{file.name}</strong><small className="path-line mono">{file.path}</small></td><td className="mono">{formatBytes(file.size)}</td><td>{file.probe?.video[0] ? `${file.probe.video[0].codec.toUpperCase()} · ${file.probe.video[0].width}×${file.probe.video[0].height}` : "Not probed"}</td><td><span className={`status ${file.status}`}><i/>{file.status}</span></td><td className="mono">{new Date(file.detectedAt).toLocaleString()}</td><td>{file.status === "detected" || file.status === "failed" ? <button className="primary small" disabled={busy === file.id} onClick={() => process(file.id)}><Play size={14}/>{busy === file.id ? "Queueing…" : "Process"}</button> : file.savingsBytes > 0 ? <span className="saved">−{formatBytes(file.savingsBytes)}</span> : null}</td></tr>)}</tbody></table></div> : <div className="empty large"><FileVideo2 size={28}/><strong>No {status} files</strong><span>Scan a library to discover stable media. Files still being copied remain excluded.</span></div>}
  </section>;
}
