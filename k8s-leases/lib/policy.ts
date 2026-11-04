// The checks on an acquire that need only the settings: the cluster, its
// first-run approval, the hours, the GPU type, and the one-node rule.
import { Refusal } from "./refusal.ts";
import type { Config } from "./settings.ts";

export interface LeaseAsk {
  thread: string;
  cluster: string;
  namespace: string;
  gpuType: string;
  gpus: number;
  hours: number;
}

/** Throws the first rule the ask breaks; returns whether it is a multi-node lease. */
export function checkAsk(ask: LeaseAsk, cfg: Config): { multiNode: boolean } {
  const profile = cfg.clusters[ask.cluster];
  if (profile === undefined) throw new Refusal("cluster_not_allowed", `${ask.cluster} is not an allowed cluster.`);
  if (cfg.firstRuns[ask.cluster] === undefined) {
    throw new Refusal("first_run_unapproved", `The first run on ${ask.cluster} needs Ryan's approval.`);
  }
  if (!(ask.hours > 0) || ask.hours * 3_600_000 > cfg.maxLeaseMs) {
    throw new Refusal("too_many_hours", `A lease lasts more than 0 and at most ${cfg.maxLeaseMs / 3_600_000} hours.`);
  }
  const perNode = profile.gpusPerNode[ask.gpuType];
  if (perNode === undefined) throw new Refusal("gpu_type_not_on_cluster", `${ask.cluster} has no ${ask.gpuType} nodes in its profile.`);
  if (ask.gpus <= perNode) return { multiNode: false };
  const approved = cfg.multiNode.some(
    (a) => a.cluster === ask.cluster && a.namespace === ask.namespace && a.thread === ask.thread && ask.gpus <= a.maxGpus,
  );
  if (!approved) {
    throw new Refusal("multi_node_unapproved", `${ask.gpus} ${ask.gpuType} GPUs is more than one node holds (${perNode}); that needs Ryan's multi-node approval.`);
  }
  return { multiNode: true };
}
