/**
 * Klient na Supabase pro MindPages.
 *
 * Přístup k datům hlídá RLS v `db/mindpages-plans.sql` přes `auth.uid()`.
 * Přihlášení je jeden účet: e-mail je v konfiguraci, uživatel zadává jen
 * heslo. Když e-mail v konfiguraci chybí, formulář ho nabídne k vyplnění.
 *
 * Tokeny se ukládají do localStorage. Access token platí hodinu, proto se
 * před požadavkem obnoví, když je po expiraci.
 */

const baseUrl = (import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const authEmail = (import.meta.env.VITE_AUTH_EMAIL ?? "").trim();

const SESSION_KEY = "mindpages-session";

export type PlanPayload = {
  nodes: unknown[];
  links: unknown[];
  // Povinné, ne volitelné: listPlans vždy doplní prázdné pole, i když v řádku
  // v databázi žádné nebyly.
  zones: unknown[];
  viewport: { x: number; y: number; zoom: number };
};

export type StoredPlan = {
  id: string;
  name: string;
  payload: PlanPayload;
  payloadVersion: number;
  updatedAt: number;
};

export type PlanWrite = Pick<StoredPlan, "id" | "name" | "payload"> & { payloadVersion?: number };

type Session = { accessToken: string; refreshToken: string; expiresAt: number };

export function isSupabaseConfigured(): boolean {
  return /^https:\/\//.test(baseUrl) && anonKey.length > 0;
}

/** True, když se má ve formuláři objevit i pole pro e-mail. */
export function needsLoginEmail(): boolean {
  return authEmail.length === 0;
}

/* --------------------------------------------------------------- session */

function readSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session> | null;
    if (!parsed) return null;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
    if (typeof parsed.expiresAt !== "number") return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeSession(session: Session | null) {
  try {
    if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Bez localStorage se přihlášení neuloží a bude se ptát znovu. Jinak to funguje.
  }
}

/** Synchronní kontrola pro první vykreslení. Obnovu tokenu řeší accessToken(). */
export function isUnlocked(): boolean {
  return readSession() !== null;
}

export function lock() {
  writeSession(null);
}

function toSession(payload: unknown): Session | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== "string" || typeof record.refresh_token !== "string") return null;
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 3600;
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Přihlášení heslem. Vrací false jen při špatném heslu; technické chyby hází.
 * `email` se použije, jen když není v konfiguraci.
 */
export async function unlock(password: string, email?: string): Promise<boolean> {
  if (!isSupabaseConfigured()) throw new Error("Chybí konfigurace Supabase.");
  const loginEmail = (authEmail || email || "").trim();
  if (!loginEmail) throw new Error("Zadej e-mail.");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: loginEmail, password }),
    });
  } catch {
    throw new Error("Připojení se nezdařilo. Zkontroluj internet.");
  }

  // Supabase vrací špatné heslo jako 400 invalid_grant.
  if (response.status === 400 || response.status === 401) return false;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const message = record ? String(record.msg ?? record.error_description ?? record.error ?? "") : "";
    throw new Error(message || "Přihlášení selhalo.");
  }

  const session = toSession(payload);
  if (!session) throw new Error("Server nevrátil přihlášení.");
  writeSession(session);
  return true;
}

async function refreshSession(session: Session): Promise<Session | null> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
  } catch {
    throw new Error("Připojení se nezdařilo. Zkontroluj internet.");
  }

  if (!response.ok) {
    // Refresh token je neplatný: přihlášení skončilo.
    writeSession(null);
    return null;
  }

  const next = toSession(await response.json().catch(() => null));
  if (next) writeSession(next);
  return next;
}

// Jednorázová obnova pro všechny souběžné požadavky. Bez toho by dva requesty
// obnovily token naráz a druhý by dostal už neplatný refresh token.
let refreshing: Promise<string> | null = null;

async function accessToken(): Promise<string> {
  const session = readSession();
  if (!session) throw new Error("Nejsi přihlášený.");

  // Minutová rezerva, aby token nevypršel během požadavku.
  if (Date.now() < session.expiresAt - 60_000) return session.accessToken;

  if (!refreshing) {
    refreshing = (async () => {
      const current = readSession();
      if (!current) throw new Error("Nejsi přihlášený.");
      if (Date.now() < current.expiresAt - 60_000) return current.accessToken;
      const next = await refreshSession(current);
      if (!next) throw new Error("Přihlášení vypršelo. Zadej heslo znovu.");
      return next.accessToken;
    })().finally(() => {
      refreshing = null;
    });
  }

  return refreshing;
}

/* ------------------------------------------------------------------- data */

function readError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      if (message.includes("violates row-level security")) {
        return "Databáze přístup odmítla. Zkontroluj, že je spuštěný db/mindpages-plans.sql.";
      }
      if (message.includes("does not exist")) {
        return "Tabulka v databázi chybí. Spusť db/mindpages-plans.sql.";
      }
      return message;
    }
  }
  if (status === 0) return "Připojení se nezdařilo. Zkontroluj internet.";
  if (status === 401 || status === 403) return "Přístup do databáze byl odepřen.";
  if (status === 409) return "Tento plán už v databázi existuje.";
  return "Databáze odpověděla chybou.";
}

async function call(path: string, init: RequestInit, method: string): Promise<{ status: number; payload: unknown }> {
  const token = await accessToken();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      method,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new Error("Připojení se nezdařilo. Zkontroluj internet.");
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  return { status: response.status, payload };
}

export async function listPlans(): Promise<StoredPlan[]> {
  const query = "mindpages_plans?select=id,name,payload,payload_version,updated_at&order=created_at.asc";
  const { status, payload } = await call(query, {}, "GET");
  if (status < 200 || status >= 300) throw new Error(readError(payload, status));
  if (!Array.isArray(payload)) return [];

  return payload
    .map((row) => {
      const record = row as Partial<StoredPlan> & { payload_version?: number; updated_at?: string };
      const plan = record.payload;
      if (typeof record.id !== "string" || typeof record.name !== "string") return null;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.nodes) || !Array.isArray(plan.links)) return null;
      return {
        id: record.id,
        name: record.name,
        payload: {
          nodes: plan.nodes,
          links: plan.links,
          // Whitelist! Zapomeneš tady na zones, zóny se po každém načtení
          // tiše zahodí, bez chyby a bez varování.
          zones: Array.isArray(plan.zones) ? plan.zones : [],
          viewport: plan.viewport,
        },
        payloadVersion: typeof record.payload_version === "number" ? record.payload_version : 1,
        updatedAt: Date.parse(record.updated_at ?? "") || Date.now(),
      } satisfies StoredPlan;
    })
    .filter((plan): plan is StoredPlan => plan !== null);
}

export async function upsertPlan(plan: PlanWrite): Promise<void> {
  const { status, payload } = await call(
    "mindpages_plans?on_conflict=id",
    {
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: plan.id,
        name: plan.name,
        payload: plan.payload,
        payload_version: plan.payloadVersion ?? 1,
      }),
    },
    "POST",
  );
  if (status < 200 || status >= 300) throw new Error(readError(payload, status));
}

export async function deleteStoredPlan(planId: string): Promise<void> {
  const { status, payload } = await call(`mindpages_plans?id=eq.${encodeURIComponent(planId)}`, {}, "DELETE");
  if (status < 200 || status >= 300) throw new Error(readError(payload, status));
}
