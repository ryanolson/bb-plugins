// The checks on an acquire that need only the settings and the cluster
// profiles: the cluster, its first-run approval, the hours, the GPU type and
// its limit, and the one-node rule.
//
// The profiles (read on the hosts with `k8s-check --list`) decide which
// clusters are allowed, their kube context, GPU type and GPUs per node. The
// `clusters` setting is used only when no host could read them.
import type { Profiles } from "./contract.ts";
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

/** What the plugin needs from a cluster's profile. */
export interface ClusterRule {
  context: string;
  /** GPUs on one node, by GPU type. */
  gpusPerNode: Record<string, number>;
  source: "profiles" | "settings";
}

/** The cluster's rule, or the refusal that names why it cannot be used. */
export function clusterRule(name: string, cfg: Config, profiles: Profiles | null): ClusterRule {
  if (profiles === null) {
    const fallback = cfg.clusters[name];
    if (fallback === undefined) throw new Refusal("cluster_not_allowed", `${name} is not an allowed cluster (no host could read the profiles).`);
    return { context: name, gpusPerNode: fallback.gpusPerNode, source: "settings" };
  }
  const profile = profiles.clusters[name];
  if (profile === undefined) throw new Refusal("cluster_not_allowed", `${name} has no cluster profile.`);
  if (profile.allowed === "never") throw new Refusal("cluster_never", `${name}'s profile says never to use it.`);
  if (profile.bot_can_write !== true) throw new Refusal("cluster_read_only", `The bot may not write on ${name}.`);
  if (profile.gpu_type === undefined || profile.gpus_per_node === undefined) {
    throw new Refusal("cluster_profile_incomplete", `${name}'s profile has no gpu_type or gpus_per_node.`);
  }
  return { context: profile.context, gpusPerNode: { [profile.gpu_type]: profile.gpus_per_node }, source: "profiles" };
}

/** Throws the first rule the ask breaks; returns the cluster's context and whether the lease spans nodes. */
export function checkAsk(ask: LeaseAsk, cfg: Config, profiles: Profiles | null): { context: string; approvals: string[] | null } {
  const rule = clusterRule(ask.cluster, cfg, profiles);
  if (cfg.firstRuns[ask.cluster] === undefined) {
    throw new Refusal("first_run_unapproved", `The first run on ${ask.cluster} needs Ryan's approval.`);
  }
  if (!(ask.hours > 0) || ask.hours * 3_600_000 > cfg.maxLeaseMs) {
    throw new Refusal("too_many_hours", `A lease lasts more than 0 and at most ${cfg.maxLeaseMs / 3_600_000} hours.`);
  }
  const perNode = rule.gpusPerNode[ask.gpuType];
  if (perNode === undefined) throw new Refusal("gpu_type_not_on_cluster", `${ask.cluster} has no ${ask.gpuType} nodes in its profile.`);
  if (cfg.limits[ask.gpuType] === undefined) throw new Refusal("gpu_type_no_limit", `There is no GPU limit for ${ask.gpuType}, so it cannot be leased.`);
  if (ask.gpus <= perNode) return { context: rule.context, approvals: null };
  const approvals = cfg.multiNode
    .filter((a) => a.cluster === ask.cluster && a.namespace === ask.namespace && a.thread === ask.thread && ask.gpus <= a.maxGpus)
    .map((a) => JSON.stringify([a.cluster, a.namespace, a.thread, a.maxGpus, a.record]));
  if (approvals.length === 0) {
    throw new Refusal("multi_node_unapproved", `${ask.gpus} ${ask.gpuType} GPUs is more than one node holds (${perNode}); that needs Ryan's multi-node approval.`);
  }
  return { context: rule.context, approvals };
}
