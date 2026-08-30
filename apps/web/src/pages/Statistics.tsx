import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle2, Clock3, Cpu, Database, HardDrive, Library, RefreshCw, Route, Server, type LucideIcon } from "lucide-react";
import { api } from "../api";
import { PageError } from "./Dashboard";

type StatisticsData = {
  rangeDays: number;
  summary: { totalJobs: number; succeeded: number; failed: number; successRate: number; processedFiles: number; bytesSaved: number; sourceBytes: number; averageDurationSeconds: number; totalDurationSeconds: number };
  timeline: Array<{ date: string; succeeded: number; failed: number; bytesSaved: number }>;
  jobStatuses: Array<{ status: string; count: number }>;
  codecs: Array<{ codec: string; count: number }>;
  libraries: Array<{ name: string; files: number; bytesSaved: number }>;
  flows: Array<{ name: string; jobs: number; succeeded: number }>;
  workers: Array<{ name: string; jobs: number; succeeded: number }>;
};

const bytes = (value: number) => {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"]; const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: unit > 1 ? 1 : 0 }).format(value / 1024 ** unit)} ${units[unit]}`;
};
const duration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`;
const percent = (value: number) => `${value.toFixed(value >= 99.95 || value === 0 ? 0 : 1)}%`;

export function Statistics() {
  const [days, setDays] = useState(30); const [data, setData] = useState<StatisticsData | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(""); try { setData(await api<StatisticsData>(`/api/statistics?days=${days}`)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setLoading(false); } }, [days]);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <PageError message={error} retry={load}/>;
  if (!data) return <StatisticsSkeleton/>;
  const savingRate = data.summary.sourceBytes > 0 ? data.summary.bytesSaved / data.summary.sourceBytes * 100 : 0;
  return <section className="page statistics-page"><div className="page-head"><div><h1>Statistics</h1><p>Processing performance, storage recovery, and workload distribution.</p></div><div className="statistics-controls"><div className="range-control" aria-label="Statistics range">{[7, 30, 90].map((value) => <button className={days === value ? "selected" : ""} key={value} onClick={() => setDays(value)}>{value}d</button>)}</div><button className="secondary" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={15}/>Refresh</button></div></div>
    {error && <div className="notice statistics-notice"><span>{error}</span><button onClick={() => void load()}>Retry</button></div>}
    <div className="statistics-overview">
      <section className="storage-impact"><div className="storage-copy"><span>Space recovered</span><strong>{bytes(data.summary.bytesSaved)}</strong><p>Removed from {bytes(data.summary.sourceBytes)} of processed source media.</p></div><div className="storage-rate"><b>{percent(savingRate)}</b><span>smaller output</span></div><div className="storage-track" aria-label={`${percent(savingRate)} storage reduction`}><i style={{ width: `${Math.min(100, savingRate)}%` }}/></div></section>
      <section className="reliability"><div><span>Completion reliability</span><CheckCircle2 size={18}/></div><strong>{percent(data.summary.successRate)}</strong><div className="reliability-track"><i style={{ width: `${data.summary.successRate}%` }}/></div><p><b>{data.summary.succeeded}</b> succeeded <span>·</span> <b className="failed">{data.summary.failed}</b> failed</p></section>
    </div>
    <div className="statistics-strip"><Stat icon={Activity} label="Jobs created" value={String(data.summary.totalJobs)}/><Stat icon={HardDrive} label="Files processed" value={String(data.summary.processedFiles)}/><Stat icon={Clock3} label="Average runtime" value={duration(data.summary.averageDurationSeconds)}/><Stat icon={Cpu} label="Total compute" value={duration(data.summary.totalDurationSeconds)}/></div>
    <section className="statistics-panel throughput-panel"><header><div><h2>Processing activity</h2><p>Completed and failed jobs per day</p></div><div className="chart-key"><span><i className="success"/>Succeeded</span><span><i className="failure"/>Failed</span></div></header><ActivityChart rows={data.timeline}/></section>
    <div className="statistics-breakdowns">
      <Breakdown title="Video codecs" subtitle="Detected media streams" icon={Database} empty="No probed codecs in this period" rows={data.codecs.map((row) => ({ label: row.codec.toUpperCase(), value: row.count, note: `${row.count} files` }))}/>
      <Breakdown title="Libraries" subtitle="Recovered storage" icon={Library} empty="No processed libraries in this period" rows={data.libraries.map((row) => ({ label: row.name, value: row.bytesSaved, note: `${row.files} files · ${bytes(row.bytesSaved)}` }))}/>
      <Breakdown title="Flows" subtitle="Execution volume" icon={Route} empty="No flow executions in this period" rows={data.flows.map((row) => ({ label: row.name, value: row.jobs, note: `${row.succeeded}/${row.jobs} succeeded` }))}/>
      <Breakdown title="Nodes" subtitle="Assigned workload" icon={Server} empty="No worker assignments in this period" rows={data.workers.map((row) => ({ label: row.name, value: row.jobs, note: `${row.succeeded}/${row.jobs} succeeded` }))}/>
    </div>
    <section className="statistics-panel status-panel"><header><div><h2>Job states</h2><p>All jobs created during selected period</p></div></header><div className="status-distribution">{data.jobStatuses.length ? data.jobStatuses.map((row) => <div key={row.status}><span className={`status-dot ${row.status}`}/><strong>{row.status}</strong><b>{row.count}</b></div>) : <div className="statistics-empty"><Activity size={19}/><span>No jobs in this period</span></div>}</div></section>
  </section>;
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return <div><Icon size={16}/><span>{label}</span><strong>{value}</strong></div>;
}

function ActivityChart({ rows }: { rows: StatisticsData["timeline"] }) {
  const maximum = Math.max(1, ...rows.map((row) => row.succeeded + row.failed)); const total = rows.reduce((sum, row) => sum + row.succeeded + row.failed, 0);
  if (!total) return <div className="chart-empty"><Activity size={23}/><strong>No completed jobs yet</strong><span>Activity appears after first processing run.</span></div>;
  const labels = new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1]);
  return <div className="activity-chart"><div className="chart-bars">{rows.map((row, index) => <div className="chart-column" key={row.date} title={`${row.date}: ${row.succeeded} succeeded, ${row.failed} failed, ${bytes(row.bytesSaved)} saved`}><div className="chart-stack" style={{ height: `${Math.max(3, (row.succeeded + row.failed) / maximum * 100)}%` }}>{row.failed > 0 && <i className="failure" style={{ flex: row.failed }}/>} {row.succeeded > 0 && <i className="success" style={{ flex: row.succeeded }}/>}</div><span>{labels.has(index) ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${row.date}T00:00:00Z`)) : ""}</span></div>)}</div></div>;
}

function Breakdown({ title, subtitle, icon: Icon, rows, empty }: { title: string; subtitle: string; icon: LucideIcon; rows: Array<{ label: string; value: number; note: string }>; empty: string }) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return <section className="statistics-panel breakdown"><header><div><h2>{title}</h2><p>{subtitle}</p></div><Icon size={17}/></header>{rows.length ? <div className="breakdown-list">{rows.map((row) => <div key={row.label}><div><strong>{row.label}</strong><span>{row.note}</span></div><i><b style={{ width: `${row.value / maximum * 100}%` }}/></i></div>)}</div> : <div className="statistics-empty"><Icon size={19}/><span>{empty}</span></div>}</section>;
}

function StatisticsSkeleton() {
  return <section className="page statistics-page"><div className="skeleton title-skeleton"/><div className="statistics-overview"><div className="skeleton statistics-overview-skeleton"/><div className="skeleton statistics-overview-skeleton"/></div><div className="skeleton statistics-chart-skeleton"/></section>;
}
