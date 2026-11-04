// The k8s Leases page: every lease with its thread, cluster, namespace,
// GPUs, state and time left, an Extend button on each active lease, the
// capacity per GPU type, the enforcement hosts, and the open flags.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { LeaseView, Snapshot, rpcContract } from "./lib/contract.ts";
import { CHANNEL, QUICK_EXTENDS, customMinutes, sortLeases, timeLeft, type Unit } from "./lib/panel.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PANEL_PATH = "leases";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("snapshot", null).then(
      (next) => {
        setSnapshot(next);
        setLoadError(null);
      },
      (cause: unknown) => setLoadError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(CHANNEL, load);
  // Time left moves without a server change.
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);
  return { rpc, snapshot, loadError, load };
}

function Extend({ lease, maxHours, onDone }: { lease: LeaseView; maxHours: number; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<Unit>("min");

  if (lease.extendBlocked !== null) return <span className="text-xs text-muted-foreground">{lease.extendBlocked}</span>;

  async function extend(minutes: number) {
    setBusy(true);
    try {
      const result = await rpc.call("extend", { leaseId: lease.id, minutes });
      toast.success(
        result.synced
          ? `Extended to ${new Date(result.expiresAt).toLocaleString()}.`
          : `Extended to ${new Date(result.expiresAt).toLocaleString()}. The namespace's expires-at will follow within a minute.`,
      );
      setOpen(false);
      setAmount("");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
      onDone();
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Extend
      </Button>
    );
  }
  const custom = customMinutes(amount, unit, maxHours);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {QUICK_EXTENDS.map((choice) => (
        <Button key={choice.minutes} size="sm" variant="secondary" disabled={busy} onClick={() => void extend(choice.minutes)}>
          {choice.label}
        </Button>
      ))}
      <input
        aria-label="Custom amount"
        className="h-8 w-16 rounded-md border border-input bg-transparent px-2 text-xs"
        inputMode="decimal"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      <select
        aria-label="Unit"
        className="h-8 rounded-md border border-input bg-transparent px-1 text-xs"
        value={unit}
        onChange={(event) => setUnit(event.target.value === "h" ? "h" : "min")}
      >
        <option value="min">min</option>
        <option value="h">h</option>
      </select>
      <Button size="sm" disabled={busy || !custom.ok} onClick={() => custom.ok && void extend(custom.minutes)}>
        Add
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {amount !== "" && !custom.ok ? <span className="text-xs text-destructive">{custom.error}</span> : null}
    </div>
  );
}

const STATE_STYLE: Record<LeaseView["state"], string> = {
  active: "text-foreground",
  revoking: "text-destructive",
  releasing: "text-muted-foreground",
  released: "text-muted-foreground",
  "torn-down": "text-muted-foreground",
};

function LeasesPage() {
  const { snapshot, loadError, load } = useSnapshot();
  const navigate = useBbNavigate();
  if (snapshot === null) return <div className="p-6 text-sm text-muted-foreground">{loadError ?? "Loading leases..."}</div>;
  const leases = sortLeases(snapshot.leases);
  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">k8s leases</h1>
        <p className="text-sm text-muted-foreground">
          {snapshot.capacity.map((c) => `${c.gpuType} ${c.used}/${c.limit}`).join(" · ") || "No GPU limits set."}
        </p>
        <p className="text-xs text-muted-foreground">
          Hosts:{" "}
          {snapshot.hosts.length === 0
            ? "none set, so acquire is refused"
            : snapshot.hosts.map((h) => `${h.hostId} ${h.ok ? "ok" : `down (${h.detail})`}${h.at === null ? "" : `, last ${new Date(h.at).toLocaleTimeString()}`}`).join(" · ")}
        </p>
        {loadError === null ? null : <p className="text-xs text-destructive">{loadError}</p>}
      </header>

      <table className="w-full border-collapse text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Thread</th>
            <th className="py-1 pr-3 font-medium">Cluster</th>
            <th className="py-1 pr-3 font-medium">Namespace</th>
            <th className="py-1 pr-3 font-medium">GPUs</th>
            <th className="py-1 pr-3 font-medium">State</th>
            <th className="py-1 pr-3 font-medium">Time</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {leases.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-4 text-muted-foreground">
                No leases.
              </td>
            </tr>
          ) : (
            leases.map((lease) => (
              <tr key={lease.id} className="border-t border-border align-top">
                <td className="py-2 pr-3">
                  <button type="button" className="font-mono text-xs underline-offset-4 hover:underline" onClick={() => navigate.toThread(lease.thread)}>
                    {lease.thread}
                  </button>
                </td>
                <td className="py-2 pr-3 font-mono text-xs">{lease.cluster}</td>
                <td className="py-2 pr-3 font-mono text-xs" title={lease.id}>
                  {lease.namespace}
                </td>
                <td className="py-2 pr-3">
                  {lease.gpus} {lease.gpuType}
                  {lease.multiNode ? " (multi-node)" : ""}
                </td>
                <td className={cn("py-2 pr-3", STATE_STYLE[lease.state])}>
                  {lease.state}
                  {lease.lastError === null ? null : (
                    <div className="max-w-xs text-xs text-destructive" title={lease.lastError}>
                      {lease.lastError}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {timeLeft(lease, snapshot.now)}
                  {lease.extensions.length === 0 ? null : (
                    <div className="text-xs text-muted-foreground">
                      {lease.extensions.map((e) => `+${Math.round(e.minutes)} min (${e.source}, ${new Date(e.at).toLocaleTimeString()})`).join(", ")}
                    </div>
                  )}
                </td>
                <td className="py-2">
                  {lease.state === "active" || lease.state === "revoking" ? <Extend lease={lease} maxHours={snapshot.maxExtendHours} onDone={load} /> : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {snapshot.flags.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Open flags</h2>
          <ul className="flex flex-col gap-1 text-xs">
            {snapshot.flags.map((flag) => (
              <li key={flag.id}>
                <span className="font-mono">{flag.kind}</span> · {new Date(flag.at).toLocaleString()} · {flag.detail}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">The steward's digest reports these; it clears them with `bb k8s flag clear`.</p>
        </section>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "leases",
    title: "k8s leases",
    icon: "Layers",
    path: PANEL_PATH,
    component: LeasesPage,
  });
});
