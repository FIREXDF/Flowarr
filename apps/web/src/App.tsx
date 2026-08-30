import { useEffect, useState } from "react";
import { Activity, Boxes, Files, Gauge, GitFork, Library, LogOut, Menu, Plug, Settings, Workflow, X } from "lucide-react";
import { api, auth } from "./api";
import { Dashboard } from "./pages/Dashboard";
import { Libraries } from "./pages/Libraries";
import { Flows } from "./pages/Flows";
import { FilesPage } from "./pages/Files";
import { Nodes } from "./pages/Nodes";
import { Integrations } from "./pages/Integrations";
import { Statistics } from "./pages/Statistics";

type Page = "dashboard" | "files" | "libraries" | "flows" | "nodes" | "integrations" | "statistics";
const nav = [
  { id: "dashboard" as const, label: "Dashboard", icon: Gauge },
  { id: "files" as const, label: "Files", icon: Files },
  { id: "libraries" as const, label: "Libraries", icon: Library },
  { id: "flows" as const, label: "Flows", icon: Workflow },
  { id: "nodes", label: "Nodes", icon: Boxes },
  { id: "tasks", label: "Tasks", icon: GitFork },
  { id: "integrations" as const, label: "Integrations", icon: Plug },
  { id: "statistics" as const, label: "Statistics", icon: Activity }
];

export function App() {
  const [ready, setReady] = useState(false); const [setup, setSetup] = useState(false); const [token, setToken] = useState(auth.get());
  const [page, setPage] = useState<Page>("dashboard"); const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => { api<{ setupRequired: boolean }>("/api/auth/status").then((value) => { setSetup(value.setupRequired); setReady(true); }).catch(() => setReady(true)); }, []);
  if (!ready) return <div className="boot"><div className="mark">F</div><span>Starting Flowarr</span></div>;
  if (!token) return <AuthScreen setup={setup} onSuccess={(value) => { auth.set(value); setToken(value); }} />;
  const body = page === "libraries" ? <Libraries /> : page === "flows" ? <Flows /> : page === "files" ? <FilesPage /> : page === "nodes" ? <Nodes /> : page === "integrations" ? <Integrations /> : page === "statistics" ? <Statistics /> : <Dashboard />;
  return <div className="shell">
    <aside className={mobileNav ? "sidebar open" : "sidebar"}>
      <div className="brand"><strong>Flowarr</strong><button className="icon mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18}/></button></div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} disabled={!(["dashboard", "files", "libraries", "flows", "nodes", "integrations", "statistics"] as string[]).includes(id)} className={page === id ? "active" : ""} onClick={() => { if (["dashboard", "files", "libraries", "flows", "nodes", "integrations", "statistics"].includes(id)) setPage(id as Page); setMobileNav(false); }}><Icon size={18}/><span>{label}</span>{!["dashboard", "files", "libraries", "flows", "nodes", "integrations", "statistics"].includes(id) && <small>soon</small>}</button>)}</nav>
      <div className="sidebar-foot"><button disabled><Settings size={18}/>Settings<small>soon</small></button><button onClick={() => { auth.clear(); setToken(null); }}><LogOut size={18}/>Sign out</button></div>
    </aside>
    <main><header className="topbar"><button className="icon menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={20}/></button><div className="crumb">Flowarr <span>/</span> {page}</div></header>{body}</main>
  </div>;
}

function AuthScreen({ setup, onSuccess }: { setup: boolean; onSuccess: (token: string) => void }) {
  const [username, setUsername] = useState("admin"); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const result = await api<{ token: string }>(`/api/auth/${setup ? "setup" : "login"}`, { method: "POST", body: JSON.stringify({ username, password }) }); onSuccess(result.token); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <main className="auth"><section><div className="brand auth-brand"><strong>Flowarr</strong></div><h1>{setup ? "Create an administrator account" : "Sign in to Flowarr"}</h1><p>{setup ? "Create the local administrator." : "Continue managing your local media automation."}</p><form onSubmit={submit}><label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required/></label><label>Password<input type="password" autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 12 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required/><small>{setup && "12 characters minimum"}</small></label>{error && <div className="error" role="alert">{error}</div>}<button className="primary" disabled={busy}>{busy ? "Working…" : setup ? "Create administrator" : "Sign in"}</button></form></section></main>;
}
