// The plugin's settings, as `bb plugin config k8s-leases` and the settings
// page show them, and the parser that turns them into one typed config.
//
// Only Ryan changes these (Charter). bb cannot enforce that: any agent can
// write plugin settings. So every change is recorded as a flag for the
// steward's digest (server.ts).
import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CLUSTER, GPU_TYPE, NAMESPACE, THREAD_ID, type GuardRun } from "./contract.ts";

const COUNT = z.number().int().min(0).max(4096);

const LIMITS = z.record(GPU_TYPE, COUNT);
const CLUSTERS = z.record(CLUSTER, z.object({ gpusPerNode: z.record(GPU_TYPE, z.number().int().min(1).max(64)) }).strict());
const FIRST_RUNS = z.record(CLUSTER, z.string().min(1));
const MULTI_NODE = z.array(
  z
    .object({
      cluster: CLUSTER,
      namespace: NAMESPACE,
      thread: THREAD_ID,
      maxGpus: z.number().int().min(1),
      record: z.string().min(1),
    })
    .strict(),
);
const HOSTS = z.array(z.string().min(1).max(128)).max(16);

/** A JSON-valued string setting, checked on save with the schema it must parse to. */
function json(schema: z.ZodType, what: string) {
  return z.string().refine((value) => {
    try {
      return schema.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }, what);
}

export const SETTINGS = {
  gpuLimits: {
    type: "string",
    label: "GPU limits by type",
    description: 'Most GPUs of each type held at once, over every cluster, as JSON: {"gb300":4}. A type not listed has a limit of 0.',
    experimental_multiline: true,
    default: JSON.stringify({ gb300: 4, b200: 8, gb200: 4, h100: 8 }),
    experimental_schema: json(LIMITS, 'Use JSON like {"gb300":4}.'),
  },
  maxLeaseHours: {
    type: "number",
    label: "Most hours per lease",
    description: "The longest an agent may ask for, and the most a renewal may leave.",
    default: 4,
    experimental_schema: z.number().positive().max(72),
  },
  maxRenewals: {
    type: "number",
    label: "Renewals per lease",
    default: 1,
    experimental_schema: z.number().int().min(0).max(10),
  },
  graceMinutes: {
    type: "number",
    label: "Grace before deletion (minutes)",
    description: "A revoked lease's namespace is deleted this long after its expiry.",
    default: 60,
    experimental_schema: z.number().int().min(0).max(24 * 60),
  },
  maxExtendHours: {
    type: "number",
    label: "Most hours one Extend adds",
    default: 24,
    experimental_schema: z.number().positive().max(24 * 14),
  },
  profilesCommand: {
    type: "string",
    label: "Cluster profiles reader",
    description: "Run with --list on each host to print the cluster profiles as JSON. The profiles decide which clusters are allowed, their GPU type, and GPUs per node.",
    default: "~/.agents/skills/k8s-clusters/scripts/k8s-check",
    experimental_schema: z.string().regex(/^(~\/|\/)[^\0]*$|^[A-Za-z0-9._-]+$/, "Use ~/path, an absolute path, or a command name."),
  },
  clusters: {
    type: "string",
    label: "Fallback clusters",
    description: 'Used only when no host can read the cluster profiles: cluster names (used as the kube context too), each with its GPUs per node by type, as JSON: {"<name>":{"gpusPerNode":{"gb300":4}}}.',
    experimental_multiline: true,
    default: "{}",
    experimental_schema: json(CLUSTERS, 'Use JSON like {"<context>":{"gpusPerNode":{"gb300":4}}}.'),
  },
  firstRunApprovals: {
    type: "string",
    label: "First-run approvals",
    description: 'Clusters (profile names) whose first run Ryan approved, each with its record, as JSON: {"<name>":"<record>"}.',
    experimental_multiline: true,
    default: "{}",
    experimental_schema: json(FIRST_RUNS, 'Use JSON like {"<context>":"<record>"}.'),
  },
  multiNodeApprovals: {
    type: "string",
    label: "Multi-node approvals",
    description: 'Leases Ryan approved to span nodes, as a JSON array of {"cluster","namespace","thread","maxGpus","record"}.',
    experimental_multiline: true,
    default: "[]",
    experimental_schema: json(MULTI_NODE, "Use a JSON array of {cluster, namespace, thread, maxGpus, record}."),
  },
  hosts: {
    type: "string",
    label: "Enforcement hosts",
    description: 'The bb machine ids whose host entry may run k8s-guard, as a JSON array: ["host_abc"]. With none, acquire fails closed.',
    default: "[]",
    experimental_schema: json(HOSTS, 'Use a JSON array of machine ids: ["host_abc"].'),
  },
  guardCommand: {
    type: "string",
    label: "k8s-guard command",
    description: "The guard on each enforcement host: ~/path, an absolute path, or a name on PATH. The k8s-clusters skill deploys it at the default.",
    default: "~/.agents/skills/k8s-clusters/scripts/k8s-guard",
    experimental_schema: z.string().regex(/^(~\/[^\0]*|\/[^\0]*|[A-Za-z0-9._-]+)$/, "Use ~/path, an absolute path, or a command name."),
  },
  bbServerUrl: {
    type: "string",
    label: "bb server URL on the hosts",
    description: "BB_SERVER_URL for the bb CLI that k8s-guard runs on each enforcement host. Host entries get no BB_* variables.",
    default: "http://127.0.0.1:38900",
    experimental_schema: z.string().url("Use a URL."),
  },
  kubeconfig: {
    type: "string",
    label: "KUBECONFIG on the hosts",
    description: "The bot's kubeconfig path, passed to k8s-guard. Empty: inherit.",
    default: "",
    experimental_schema: z.string().refine((value) => value === "" || value.startsWith("/"), "Use an absolute path, or leave it empty."),
  },
} satisfies Record<string, PluginSettingDescriptor>;

export interface ClusterProfile {
  gpusPerNode: Record<string, number>;
}

export interface MultiNodeApproval {
  cluster: string;
  namespace: string;
  thread: string;
  maxGpus: number;
  record: string;
}

export interface Config {
  limits: Record<string, number>;
  maxLeaseMs: number;
  maxRenewals: number;
  graceMs: number;
  maxExtendMs: number;
  clusters: Record<string, ClusterProfile>;
  firstRuns: Record<string, string>;
  multiNode: MultiNodeApproval[];
  hosts: string[];
  run: GuardRun;
  profilesCommand: string;
}

type Values = { [K in keyof typeof SETTINGS]: (typeof SETTINGS)[K]["default"] extends number ? number : string };

/**
 * Parse saved settings. A JSON setting that does not parse falls back to
 * its most closed value (no limit, no cluster, no approval, no host), so a
 * bad edit can only refuse leases, never grant one.
 */
export function parseConfig(values: Values): Config {
  const parse = <T>(schema: z.ZodType<T>, text: string, closed: T): T => {
    try {
      const result = schema.safeParse(JSON.parse(text));
      return result.success ? result.data : closed;
    } catch {
      return closed;
    }
  };
  return {
    limits: parse(LIMITS, values.gpuLimits, {}),
    maxLeaseMs: values.maxLeaseHours * 3_600_000,
    maxRenewals: values.maxRenewals,
    graceMs: values.graceMinutes * 60_000,
    maxExtendMs: values.maxExtendHours * 3_600_000,
    clusters: parse(CLUSTERS, values.clusters, {}),
    firstRuns: parse(FIRST_RUNS, values.firstRunApprovals, {}),
    multiNode: parse(MULTI_NODE, values.multiNodeApprovals, []),
    hosts: parse(HOSTS, values.hosts, []),
    profilesCommand: values.profilesCommand,
    run: {
      command: values.guardCommand,
      serverUrl: values.bbServerUrl,
      kubeconfig: values.kubeconfig === "" ? null : values.kubeconfig,
    },
  };
}
