import { Fragment, useCallback, useEffect, useState } from "react";
import { Check, Copy, FileText, FileVideo2, Play, RefreshCw, ScrollText, X } from "lucide-react";
import type { FileStatus, MediaFile } from "@flowarr/shared";
import { api } from "../api";
import { PageError } from "./Dashboard";

const tabs: Array<{ status: FileStatus; label: string }> = [
  { status: "detected", label: "Detected" }, { status: "queued", label: "Queued" }, { status: "processing", label: "Processing" }, { status: "processed", label: "Processed" }, { status: "failed", label: "Failed" }, { status: "ignored", label: "Ignored" }
];
const formatBytes = (bytes: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(bytes) + "B";
type JobLog = { level: string; message: string; detail: string | null; createdAt: string };
type LogView = { file: MediaFile; entries: JobLog[] | null; error: string };

export function FilesPage() {
  const [status, setStatus] = useState<FileStatus>("detected");
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [logView, setLogView] = useState<LogView | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setFiles(null); setError(""); setLogView(null);
    api<MediaFile[]>(`/api/files?status=${status}`).then(setFiles).catch((value) => setError(value instanceof Error ? value.message : String(value)));
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const process = async (id: string) => {
    setBusy(id); setActionError(""); setNotice("");
    try {
      const result = await api<{ jobId: string }>(`/api/files/${id}/process`, { method: "POST" });
      setNotice(`Job ${result.jobId.slice(0, 8)} queued`); await load();
    } catch (value) { setActionError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(null); }
  };

  const showLogs = async (file: MediaFile, force = false) => {
    if (!force && logView?.file.id === file.id) { setLogView(null); return; }
    setCopied(false); setActionError("");
    if (!file.failureJobId) { setLogView({ file, entries: [], error: "No failed job record was found for this file." }); return; }
    setLogView({ file, entries: null, error: "" });
    try {
      const entries = await api<JobLog[]>(`/api/jobs/${file.failureJobId}/logs`);
      setLogView((current) => current?.file.id === file.id ? { file, entries, error: "" } : current);
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      setLogView((current) => current?.file.id === file.id ? { file, entries: [], error: message } : current);
    }
  };

  const copyLogs = async () => {
    if (!logView?.entries) return;
    const text = logView.entries.map((entry) => `${entry.createdAt} [${entry.level}] ${entry.message}${entry.detail ? `\n${formatDetail(entry.detail)}` : ""}`).join("\n\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setLogView((current) => current ? { ...current, error: "Browser blocked clipboard access. Select the log text and copy it manually." } : null); }
  };

  if (error) return <PageError message={error} retry={load}/>;
  return <section className="page files-page">
    <div className="page-head"><div><h1>Files</h1><p>Every detected file, queue decision, result, and failure.</p></div><button className="secondary" onClick={load}><RefreshCw size={16}/>Refresh</button></div>
    <div className="tabs" role="tablist">{tabs.map((tab) => <button role="tab" aria-selected={status === tab.status} className={status === tab.status ? "selected" : ""} key={tab.status} onClick={() => setStatus(tab.status)}>{tab.label}</button>)}</div>
    {actionError && <div className="error" role="alert">{actionError}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!files ? <div className="skeleton table-skeleton"/> : files.length ? <div className="table-wrap"><table><thead><tr><th>File</th><th>Size</th><th>Media</th><th>Status</th><th>Detected</th><th>Actions</th></tr></thead><tbody>{files.map((file) => <Fragment key={file.id}>
      <tr><td><strong>{file.name}</strong><small className="path-line mono" title={file.path}>{file.path}</small></td><td className="mono">{formatBytes(file.size)}</td><td>{file.probe?.video[0] ? `${file.probe.video[0].codec.toUpperCase()} · ${file.probe.video[0].width}×${file.probe.video[0].height}` : "Not probed"}</td><td><span className={`status ${file.status}`}><i/>{file.status}</span></td><td className="mono">{new Date(file.detectedAt).toLocaleString()}</td><td><div className="file-actions">{file.status === "failed" && <button className="secondary small" aria-expanded={logView?.file.id === file.id} onClick={() => void showLogs(file)}><ScrollText size={14}/>{logView?.file.id === file.id ? "Hide logs" : "View logs"}</button>}{file.status === "detected" || file.status === "failed" ? <button className="primary small" disabled={busy === file.id} onClick={() => void process(file.id)}><Play size={14}/>{busy === file.id ? "Queueing…" : "Process"}</button> : file.savingsBytes > 0 ? <span className="saved">−{formatBytes(file.savingsBytes)}</span> : null}</div></td></tr>
      {logView?.file.id === file.id && <tr className="failure-log-row"><td colSpan={6}><section className="failure-log" role="region" aria-label={`Failure logs for ${file.name}`}>
        <header><div><FileText size={16}/><span><strong>Failure log</strong><small>{file.name}{file.failureJobId ? ` · job ${file.failureJobId.slice(0, 8)}` : ""}</small></span></div><div>{Boolean(logView.entries?.length) && <button className="secondary small" onClick={() => void copyLogs()}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? "Copied" : "Copy"}</button>}<button className="icon" onClick={() => setLogView(null)} aria-label="Close failure logs"><X size={16}/></button></div></header>
        {logView.error && <div className="failure-log-error" role="alert">{logView.error}{file.failureJobId && <button className="secondary small" onClick={() => void showLogs(file, true)}>Retry</button>}</div>}
        {logView.entries === null ? <div className="failure-log-loading"><span/>Loading job logs…</div> : logView.entries.length ? <ol>{logView.entries.map((entry, index) => <li key={`${entry.createdAt}-${index}`}><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time><b className={`log-level ${entry.level.toLowerCase()}`}>{entry.level}</b><pre>{entry.message}{entry.detail ? `\n${formatDetail(entry.detail)}` : ""}</pre></li>)}</ol> : !logView.error ? <div className="failure-log-empty">No detailed entries were recorded for this job.</div> : null}
      </section></td></tr>}
    </Fragment>)}</tbody></table></div> : <div className="empty large"><FileVideo2 size={28}/><strong>No {status} files</strong><span>Scan a library to discover stable media. Files still being copied remain excluded.</span></div>}
  </section>;
}

function formatDetail(detail: string): string {
  try { return JSON.stringify(JSON.parse(detail), null, 2); }
  catch { return detail; }
}
