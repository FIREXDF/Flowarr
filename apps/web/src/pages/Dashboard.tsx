import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowDownToLine, Clock3, HardDrive, RefreshCw, Server } from "lucide-react";
import type { Job, MediaFile } from "@flowarr/shared";
import { api } from "../api";

type Data = { jobs: Array<{ status: string; count: number }>; bytesSaved: number; recent: MediaFile[]; active: Job[] };
const formatBytes = (bytes: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(bytes) + "B";
export function Dashboard() {
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState("");
  const load = useCallback(() => api<Data>("/api/dashboard").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); const stream = new EventSource("/api/events"); stream.addEventListener("job", load); return () => stream.close(); }, [load]);
  if (error) return <PageError message={error} retry={load}/>;
  if (!data) return <section className="page"><div className="skeleton title-skeleton"/><div className="metric-grid">{[1,2,3,4].map((i) => <div className="skeleton metric" key={i}/>)}</div></section>;
  const count = (status: string) => Number(data.jobs.find((item) => item.status === status)?.count ?? 0);
  return <section className="page"><div className="page-head"><div><h1>Dashboard</h1><p>Live state across queue, storage, and processing.</p></div><button className="secondary" onClick={load}><RefreshCw size={16}/>Refresh</button></div>
    <div className="metric-grid"><Metric icon={ArrowDownToLine} label="Queued" value={count("queued")} note="waiting for local node"/><Metric icon={Clock3} label="Processing" value={count("running")} note={data.active[0]?.speed ?? "node idle"}/><Metric icon={HardDrive} label="Space recovered" value={formatBytes(data.bytesSaved)} note="validated replacements"/><Metric icon={AlertTriangle} label="Failures" value={count("failed")} note="needs attention" warning={count("failed") > 0}/></div>
    <div className="ops-grid"><section className="panel active-jobs"><div className="panel-head"><div><h2>Active processing</h2><span>Real-time FFmpeg progress</span></div></div>{data.active.length ? data.active.map((job) => <div className="job" key={job.id}><div className="job-meta"><strong>Job {job.id.slice(0, 8)}</strong><span>{job.speed ?? "starting"}</span></div><div className="progress"><i style={{ width: `${job.progress}%` }}/></div><b>{job.progress}%</b></div>) : <Empty icon={Server} title="Node is idle" text="Queued files appear here when processing starts."/>}</section>
      <section className="panel"><div className="panel-head"><div><h2>Recently processed</h2><span>Verified media replacements</span></div></div>{data.recent.length ? <div className="compact-list">{data.recent.map((file) => <div key={file.id}><div><strong>{file.name}</strong><span>{file.probe?.video[0]?.codec ?? "media"} · {formatBytes(file.size)}</span></div><b className="saved">−{formatBytes(file.savingsBytes)}</b></div>)}</div> : <Empty icon={HardDrive} title="No completed files" text="Processed media and savings will collect here."/>}</section></div>
  </section>;
}
function Metric({ icon: Icon, label, value, note, warning }: { icon: typeof Clock3; label: string; value: string | number; note: string; warning?: boolean }) { return <div className={warning ? "metric warning" : "metric"}><div><span>{label}</span><Icon size={18}/></div><strong>{value}</strong><small>{note}</small></div>; }
function Empty({ icon: Icon, title, text }: { icon: typeof Server; title: string; text: string }) { return <div className="empty"><Icon size={24}/><strong>{title}</strong><span>{text}</span></div>; }
export function PageError({ message, retry }: { message: string; retry: () => void }) { return <section className="page"><div className="page-error"><AlertTriangle/><h2>Could not load this view</h2><p>{message}</p><button className="secondary" onClick={retry}>Try again</button></div></section>; }
