export async function fingerprintPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function readSessionDraft(storageKey) {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    return value && typeof value.fingerprint === "string" && typeof value.event_id === "string" && typeof value.order_ref === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function writeSessionDraft(storageKey, value) {
  try { sessionStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { /* Keep the in-memory retry key when session storage is unavailable. */ }
}

export function clearSessionDraft(storageKey) {
  try { sessionStorage.removeItem(storageKey); }
  catch { /* The submitted request has already been accepted. */ }
}
