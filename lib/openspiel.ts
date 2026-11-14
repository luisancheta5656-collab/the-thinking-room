export function openspielBaseUrl(): string {
  return (process.env.OPENSPIEL_URL || "http://127.0.0.1:8765").replace(/\/$/, "");
}

export type OpenSpielStatus = { available: boolean; version?: string };

export async function openspielStatus(): Promise<OpenSpielStatus> {
  try {
    const response = await fetch(`${openspielBaseUrl()}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { available: false };
    const data = await response.json() as { ok?: boolean; version?: string };
    return { available: Boolean(data.ok), version: data.version };
  } catch {
    return { available: false };
  }
}

/** The agents that can take a side in AI vs AI. */
export async function openspielPlayers(): Promise<unknown[]> {
  const response = await fetch(`${openspielBaseUrl()}/players`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`The OpenSpiel engine could not list its agents: HTTP ${response.status}`);
  const data = await response.json() as { players?: unknown[] };
  return data.players ?? [];
}

export async function askOpenSpiel<T>(path: "/move", body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${openspielBaseUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Cannot reach the OpenSpiel engine. Restart the app, or run `npm run engine` in development.");
  }

  const data = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  if (!response.ok || data === null) {
    const detail = data && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(`The OpenSpiel engine could not answer: ${detail}`);
  }
  return data;
}
