// The admin API client: one fetch wrapper that throws ApiError with the server's error name.

export class ApiError extends Error {
  constructor(
    /** The server's error name ("bad_credentials", ...), or "network" / "unknown". */
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export interface AuthState {
  setupNeeded: boolean;
  authenticated: boolean;
  name?: string;
  twoFactor: boolean;
  require2fa: boolean;
  mustEnrol2fa: boolean;
}

export interface Overview {
  address: string | null;
  addressSuggestion: string;
  people: number;
  profiles: number;
  bytesUsed: number;
  bytesFree: number;
  lastActivity: number | null;
  version: string;
  insecure: boolean;
}

export interface Person {
  id: string;
  name: string;
  state: "active" | "blocked";
  profiles: number;
  bytes: number;
  lastActivity: number | null;
  createdAt: number;
}

export interface Vault {
  id: string;
  shortId: string;
  bytes: number;
  files: number;
  lastActivity: number | null;
}

export type PersonDetail = Person & { vaults: Vault[] };

const BASE = "/admin/api";

let authLost: (() => void) | null = null;
/** Called when a call answers 401 `unauthorized` (the session ended). */
export function onAuthLost(handler: (() => void) | null): void {
  authLost = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", 0);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const code = typeof (data as { error?: unknown } | null)?.error === "string" ? (data as { error: string }).error : "unknown";
    if (res.status === 401 && code === "unauthorized") authLost?.();
    throw new ApiError(code, res.status);
  }
  return data as T;
}

const id = encodeURIComponent;

export const api = {
  state: () => request<AuthState>("GET", "state"),
  setup: (b: { code: string; name: string; password: string }) => request<void>("POST", "setup", b),
  login: (b: { name: string; password: string; totp?: string }) => request<void>("POST", "login", b),
  logout: () => request<void>("POST", "logout", {}),
  logoutAll: () => request<void>("POST", "logout-all", {}),
  changePassword: (current: string, next: string) => request<void>("POST", "password", { current, next }),
  enrol: (password: string) => request<{ secret: string; otpauthUrl: string }>("POST", "2fa/enrol", { password }),
  confirmTotp: (totp: string) => request<{ backupCodes: string[] }>("POST", "2fa/confirm", { totp }),
  disableTotp: (password: string) => request<void>("POST", "2fa/disable", { password }),
  overview: () => request<Overview>("GET", "overview"),
  people: () => request<Person[]>("GET", "people"),
  person: (pid: string) => request<PersonDetail>("GET", `people/${id(pid)}`),
  addPerson: (name: string) => request<{ person: Person; connectionCode: string }>("POST", "people", { name }),
  renamePerson: (pid: string, name: string) => request<Person>("PATCH", `people/${id(pid)}`, { name }),
  setPersonState: (pid: string, state: "active" | "blocked") => request<Person>("PATCH", `people/${id(pid)}`, { state }),
  deletePerson: (pid: string) => request<void>("DELETE", `people/${id(pid)}`),
  deleteVault: (pid: string, vaultId: string) => request<void>("DELETE", `people/${id(pid)}/vaults/${id(vaultId)}`),
  connectionCode: (pid: string, password: string) =>
    request<{ connectionCode: string }>("POST", `people/${id(pid)}/connection-code`, { password }),
  settings: () => request<{ publicUrl: string | null; blobQuotaBytes: number }>("GET", "settings"),
  saveBlobQuota: (blobQuotaBytes: number) => request<{ blobQuotaBytes: number }>("PUT", "settings", { blobQuotaBytes }),
  backupSize: () => request<{ estimatedBytes: number }>("GET", "backup/size"),
  saveAddress: (publicUrl: string) => request<{ publicUrl: string }>("PUT", "settings", { publicUrl }),
};

export const BACKUP_URL = `${BASE}/backup`;
