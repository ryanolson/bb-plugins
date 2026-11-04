// The panel's logic, kept apart from React so it can be tested: the Extend
// choices, the custom amount, the time left, and the order of the list.
import type { LeaseView } from "./contract.ts";

/** Realtime channel: the leases changed; the panel reloads its snapshot. */
export const CHANNEL = "leases";

export const QUICK_EXTENDS = [
  { label: "+30 min", minutes: 30 },
  { label: "+1 h", minutes: 60 },
  { label: "+2 h", minutes: 120 },
] as const;

export type Unit = "min" | "h";

/** A custom amount typed in the panel, as minutes, or why it cannot be used. */
export function customMinutes(text: string, unit: Unit, maxHours: number): { ok: true; minutes: number } | { ok: false; error: string } {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value) || value <= 0) return { ok: false, error: "Type a number above 0." };
  const minutes = unit === "h" ? value * 60 : value;
  if (minutes > maxHours * 60) return { ok: false, error: `One extension adds at most ${maxHours} h.` };
  return { ok: true, minutes };
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function timeLeft(lease: LeaseView, now: number): string {
  if (lease.state === "active") return lease.expiresAt <= now ? "expired" : `${span(lease.expiresAt - now)} left`;
  if (lease.state === "revoking" && lease.graceDeadline !== null) {
    return lease.graceDeadline <= now ? "deleting" : `deleted in ${span(lease.graceDeadline - now)}`;
  }
  if (lease.state === "releasing") return "deleting";
  return "";
}

const RANK: Record<LeaseView["state"], number> = { revoking: 0, releasing: 0, active: 1, released: 2, "torn-down": 2 };

/** Teardowns in progress first, then active leases by expiry, then the ended ones. */
export function sortLeases(leases: readonly LeaseView[]): LeaseView[] {
  return [...leases].sort((a, b) => RANK[a.state] - RANK[b.state] || a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
}
