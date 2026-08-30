const TOKEN_KEY = "flowarr-token";
export const auth = { get: () => localStorage.getItem(TOKEN_KEY), set: (token: string) => localStorage.setItem(TOKEN_KEY, token), clear: () => localStorage.removeItem(TOKEN_KEY) };

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = auth.get();
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed: ${response.status}`);
  return data;
}
