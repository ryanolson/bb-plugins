// Which enforcement hosts a guard call goes to.
//
// Calls that only reduce or read (expire, inspect) go to every healthy host
// at once: one healthy answer is enough, so no choice of host can leave a
// lease unenforced. Calls that must run once (down) or in order (extend), and
// acquire's inspect, go to one host at a time, picked by recent outcomes: a
// host whose last call failed is tried last until its cool-down passes, or
// until it succeeds again.
import type { GuardFailure } from "./contract.ts";

/** No host could be reached, or none gave an answer. */
export class HostUnreachable extends Error {
  readonly attempts: string[];
  constructor(attempts: string[]) {
    super(attempts.length === 0 ? "no enforcement host is configured" : `no enforcement host answered: ${attempts.join("; ")}`);
    this.name = "HostUnreachable";
    this.attempts = attempts;
  }
}

/**
 * One host's reply to a fanned-out call: a guard result, or the reason the
 * host gave none. `seq` orders the calls by when they started: it only grows,
 * even within one millisecond.
 */
export type HostAnswer<R> = { hostId: string; seq: number; result: R } | { hostId: string; seq: number; unreachable: string };

export interface HostsDeps<Method extends string> {
  /** The raw host RPC. Rejects when the host cannot be reached. */
  call: (hostId: string, method: Method, input: unknown) => Promise<{ ok: boolean; code?: string; error?: string }>;
  now: () => number;
  /** Hosts with a good probe inside the heartbeat window, freshest first. */
  healthy: () => string[];
  /** Every configured host. */
  configured: () => string[];
  cooldownMs: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHosts<Method extends string>(deps: HostsDeps<Method>) {
  /** Last success and last failure of a guard call, by host. */
  const outcomes = new Map<string, { okAt: number; failAt: number }>();
  let seq = 0;

  function note(hostId: string, ok: boolean): void {
    const seen = outcomes.get(hostId) ?? { okAt: -Infinity, failAt: -Infinity };
    if (ok) seen.okAt = deps.now();
    else seen.failAt = deps.now();
    outcomes.set(hostId, seen);
  }

  function coolingDown(hostId: string): boolean {
    const seen = outcomes.get(hostId);
    return seen !== undefined && seen.failAt > seen.okAt && deps.now() - seen.failAt < deps.cooldownMs;
  }

  /** A guard failure other than `not_found` says the host could not do its part. */
  const hostFailed = (result: { ok: boolean; code?: string }) => !result.ok && result.code !== "not_found";

  /** Healthy hosts first (freshest probe first), then the rest; hosts cooling down after a failure go last. */
  function order(): string[] {
    const healthy = deps.healthy();
    const rest = deps.configured().filter((hostId) => !healthy.includes(hostId));
    const ranked = [...healthy, ...rest];
    return [...ranked.filter((h) => !coolingDown(h)), ...ranked.filter((h) => coolingDown(h))];
  }

  async function answer<R>(hostId: string, method: Method, input: unknown): Promise<HostAnswer<R>> {
    seq += 1;
    const mine = seq;
    try {
      const result = await deps.call(hostId, method, input);
      note(hostId, !hostFailed(result));
      return { hostId, seq: mine, result: result as R };
    } catch (error) {
      note(hostId, false);
      return { hostId, seq: mine, unreachable: message(error) };
    }
  }

  return {
    /**
     * Send a fresh call to every healthy host at once (every configured host
     * when none is healthy). Calls are never shared: an earlier call still
     * running may have done its work before a later write landed. `onAnswer`
     * sees each reply as it arrives.
     */
    all<R>(method: Method, input: unknown, onAnswer: (answer: HostAnswer<R>) => void = () => undefined): Promise<HostAnswer<R>[]> {
      const targets = deps.healthy().length > 0 ? deps.healthy() : deps.configured();
      return Promise.all(
        targets.map((hostId) =>
          answer<R>(hostId, method, input).then((reply) => {
            onAnswer(reply);
            return reply;
          }),
        ),
      );
    },

    /**
     * Send the call to one host at a time, in health order, until one gives an
     * answer: success, or `not_found`. When every host fails, the first guard
     * failure is returned; when none can be reached, it throws.
     */
    async one<R extends { ok: boolean } | GuardFailure>(method: Method, input: unknown): Promise<{ hostId: string; result: R }> {
      const attempts: string[] = [];
      let first: { hostId: string; result: R } | null = null;
      for (const hostId of order()) {
        const reply = await answer<R>(hostId, method, input);
        if ("unreachable" in reply) {
          attempts.push(`${hostId}: ${reply.unreachable}`);
          continue;
        }
        if (!hostFailed(reply.result as { ok: boolean; code?: string })) return reply;
        const failure = reply.result as unknown as GuardFailure;
        attempts.push(`${hostId}: ${failure.code}: ${failure.error}`);
        first ??= reply;
      }
      if (first !== null) return first;
      throw new HostUnreachable(attempts);
    },

    order,
  };
}

export type Hosts<Method extends string> = ReturnType<typeof createHosts<Method>>;
