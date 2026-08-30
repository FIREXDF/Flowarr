import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Copy, Cpu, Plus, RefreshCw, Server, X } from "lucide-react";
import type { WorkerInfo, WorkerSchedule } from "@flowarr/shared";
import { api } from "../api";
import { PageError } from "./Dashboard";

const formatMemory = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const dayOptions = [{ value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" }, { value: 6, label: "Sat" }, { value: 0, label: "Sun" }];

export function Nodes() {
  const [workers, setWorkers] = useState<WorkerInfo[] | null>(null);
  const [error, setError] = useState("");
  const [registration, setRegistration] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingPriority, setSavingPriority] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
  const load = useCallback(() => {
    setError("");
    return api<WorkerInfo[]>("/api/workers").then(setWorkers).catch((value) => setError(value.message));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const createToken = async () => {
    setBusy(true); setError("");
    try { setRegistration(await api("/api/workers/tokens", { method: "POST", body: JSON.stringify({ ttlHours: 24 }) })); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };

  const replaceWorker = (updated: WorkerInfo) => {
    setWorkers((current) => current?.map((item) => item.id === updated.id ? updated : item).sort((a, b) => b.priority - a.priority) ?? null);
  };

  const updatePriority = async (worker: WorkerInfo) => {
    setSavingPriority(worker.id); setError("");
    try { replaceWorker(await api<WorkerInfo>(`/api/workers/${worker.id}`, { method: "PATCH", body: JSON.stringify({ priority: worker.priority }) })); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); await load(); }
    finally { setSavingPriority(null); }
  };

  const updateSchedule = async (workerId: string, schedule: WorkerSchedule) => {
    const updated = await api<WorkerInfo>(`/api/workers/${workerId}`, { method: "PATCH", body: JSON.stringify({ schedule }) });
    replaceWorker(updated);
  };

  const editPriority = (workerId: string, value: string) => {
    const priority = Math.max(0, Math.min(100, Number.parseInt(value || "0", 10)));
    setWorkers((current) => current?.map((worker) => worker.id === workerId ? { ...worker, priority } : worker) ?? null);
  };

  const scheduledWorker = workers?.find((worker) => worker.id === editingSchedule) ?? null;
  if (error && !workers) return <PageError message={error} retry={load}/>;
  return <section className="page">
    <div className="page-head">
      <div><h1>Nodes</h1><p>Compatible nodes receive jobs by availability, schedule, then priority.</p></div>
      <div className="page-actions"><button className="secondary" onClick={load}><RefreshCw size={16}/>Refresh</button><button className="primary" onClick={createToken} disabled={busy}><Plus size={16}/>{busy ? "Creating…" : "Registration token"}</button></div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {registration && <div className="token-reveal"><div><strong>One-time worker token</strong><code>{registration.token}</code><small>Expires {new Date(registration.expiresAt).toLocaleString()}. It disappears when this page reloads.</small></div><button className="secondary" onClick={() => navigator.clipboard.writeText(registration.token)}><Copy size={15}/>Copy</button></div>}
    {!workers ? <div className="skeleton table-skeleton"/> : workers.length ? <div className="table-wrap nodes-table"><table>
      <thead><tr><th>Node</th><th>Status</th><th>Priority</th><th>Schedule</th><th>System</th><th>FFmpeg</th><th>Path access</th></tr></thead>
      <tbody>{workers.map((worker) => <tr key={worker.id}>
        <td><strong>{worker.name}</strong><span className={`node-kind ${worker.kind}`}>{worker.kind === "local" ? "Local server" : "Remote worker"}</span><small className="path-line mono">{worker.id.slice(0, 12)}</small></td>
        <td><span className={`status ${worker.status}`}><i/>{worker.status}</span><small className="mono">{new Date(worker.lastSeenAt).toLocaleString()}</small></td>
        <td><div className="priority-control"><input aria-label={`Priority for ${worker.name}`} type="number" min="0" max="100" value={worker.priority} disabled={savingPriority === worker.id} onChange={(event) => editPriority(worker.id, event.target.value)} onBlur={() => void updatePriority(worker)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}/><small>Higher first</small></div></td>
        <td><button className={`schedule-button ${scheduleState(worker)}`} onClick={() => setEditingSchedule(worker.id)} aria-label={`Edit schedule for ${worker.name}`}><CalendarClock size={15}/><span><strong>{scheduleTitle(worker)}</strong><small>{scheduleDetail(worker)}</small></span></button></td>
        <td><span className="worker-cap"><Cpu size={14}/>{worker.capabilities.logicalCpus} threads · {formatMemory(worker.capabilities.freeMemory)} free</span><small>{worker.capabilities.platform} / {worker.capabilities.architecture}</small></td>
        <td><strong>{worker.capabilities.ffmpeg.available ? worker.capabilities.ffmpeg.version?.replace(/^ffmpeg version\s*/i, "")?.split(" ")[0] ?? "available" : "Unavailable"}</strong><small>{worker.capabilities.ffmpeg.encoders.length} encoders</small></td>
        <td>{worker.kind === "local" ? <><strong>Direct</strong><small>Uses server paths</small></> : worker.pathMappings.map((mapping) => <small className="path-line mono" key={`${mapping.serverPath}-${mapping.workerPath}`}>{mapping.serverPath} → {mapping.workerPath}</small>)}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty large"><Server size={28}/><strong>No nodes available</strong><span>The local server will appear automatically. Install FFmpeg on it or register a remote worker.</span><button className="primary" onClick={createToken}><Plus size={15}/>Create token</button></div>}
    {scheduledWorker && <ScheduleDialog key={scheduledWorker.id} worker={scheduledWorker} close={() => setEditingSchedule(null)} save={updateSchedule}/>}
  </section>;
}

function ScheduleDialog({ worker, close, save }: { worker: WorkerInfo; close: () => void; save: (workerId: string, schedule: WorkerSchedule) => Promise<void> }) {
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [schedule, setSchedule] = useState<WorkerSchedule>({ ...worker.schedule, days: [...worker.schedule.days], timezone: worker.schedule.mode === "always" && worker.schedule.timezone === "UTC" ? browserTimezone : worker.schedule.timezone });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggleDay = (day: number) => setSchedule((current) => ({ ...current, days: current.days.includes(day) ? current.days.filter((value) => value !== day) : [...current.days, day].sort((a, b) => a - b) }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await save(worker.id, schedule); close(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };
  return <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}><dialog open aria-labelledby="schedule-title" className="schedule-dialog">
    <div className="dialog-head"><div><h2 id="schedule-title">Node schedule</h2><p>{worker.name}</p></div><button className="icon" onClick={close} aria-label="Close"><X size={18}/></button></div>
    <form onSubmit={submit}>
      <div className="schedule-modes" role="group" aria-label="Availability mode">
        {(["always", "scheduled", "disabled"] as const).map((mode) => <button type="button" key={mode} className={schedule.mode === mode ? "selected" : ""} aria-pressed={schedule.mode === mode} onClick={() => setSchedule((current) => ({ ...current, mode }))}>{mode === "always" ? "Always" : mode === "scheduled" ? "Scheduled" : "Disabled"}</button>)}
      </div>
      {schedule.mode === "always" && <p className="schedule-explanation">This node can receive a new job whenever it is online and compatible.</p>}
      {schedule.mode === "disabled" && <p className="schedule-explanation warning">This node stays connected but will not receive new jobs.</p>}
      {schedule.mode === "scheduled" && <>
        <fieldset className="schedule-days"><legend>Working days</legend><div>{dayOptions.map((day) => <button type="button" key={day.value} aria-pressed={schedule.days.includes(day.value)} className={schedule.days.includes(day.value) ? "selected" : ""} onClick={() => toggleDay(day.value)}>{day.label}</button>)}</div></fieldset>
        <div className="schedule-times"><label>Start<input aria-label="Schedule start" type="time" value={schedule.start} onChange={(event) => setSchedule((current) => ({ ...current, start: event.target.value }))} required/></label><label>End<input aria-label="Schedule end" type="time" value={schedule.end} onChange={(event) => setSchedule((current) => ({ ...current, end: event.target.value }))} required/></label></div>
        <label>Timezone<input aria-label="Schedule timezone" list="flowarr-timezones" value={schedule.timezone} onChange={(event) => setSchedule((current) => ({ ...current, timezone: event.target.value }))} required/><small>Overnight windows are supported. Days refer to the start of the window.</small></label>
        <datalist id="flowarr-timezones"><option value={browserTimezone}/><option value="UTC"/><option value="Europe/Paris"/><option value="America/New_York"/><option value="Asia/Tokyo"/></datalist>
      </>}
      <p className="schedule-footnote">Running jobs finish normally when a window closes. Only new assignments are paused.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy || (schedule.mode === "scheduled" && !schedule.days.length)}>{busy ? "Saving…" : "Save schedule"}</button></div>
    </form>
  </dialog></div>;
}

function scheduleState(worker: WorkerInfo): string {
  if (worker.schedule.mode === "disabled") return "disabled";
  if (worker.schedule.mode === "scheduled" && !worker.scheduleActive) return "paused";
  return "active";
}
function scheduleTitle(worker: WorkerInfo): string { return worker.schedule.mode === "always" ? "Always" : worker.schedule.mode === "disabled" ? "Disabled" : formatScheduleDays(worker.schedule.days); }
function scheduleDetail(worker: WorkerInfo): string {
  if (worker.schedule.mode === "always") return "Accepting jobs";
  if (worker.schedule.mode === "disabled") return "No new jobs";
  return `${worker.schedule.start}–${worker.schedule.end} · ${worker.scheduleActive ? "open" : "closed"}`;
}
function formatScheduleDays(days: number[]): string {
  if (days.length === 7) return "Every day";
  if ([1, 2, 3, 4, 5].every((day) => days.includes(day)) && days.length === 5) return "Mon–Fri";
  return dayOptions.filter((day) => days.includes(day.value)).map((day) => day.label).join(", ");
}
