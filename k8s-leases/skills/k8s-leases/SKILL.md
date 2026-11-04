---
name: k8s-leases
description: GPU leases on our k8s clusters with `bb k8s`. Use to see what runs where (`bb k8s leases`), to renew or release your own lease, or to read the flags the steward's digest reports (`bb k8s flags`). k8s-guard calls the other lease commands for you; do not call acquire or op begin by hand.
---

# k8s leases

A lease holds GPUs of one type, in one namespace on one cluster, for one thread. The k8s Leases plugin keeps the limits, and tears down every lease that expires, is returned, or loses its thread.

## Rules for agents

- Write to a cluster only through `k8s-guard`. It takes the lease and fences each write for you.
- Never call the plugin's `extend` RPC, and never change the plugin's settings. Only Ryan does that.
- A lease lasts at most 4 hours. You can renew it once.
- More than one node, a new cluster, or the first run on a cluster needs Ryan's approval first.

## Commands

```
bb k8s leases [--all] [--json]       # what runs where
bb k8s lease show <lease_id>         # one lease, as JSON
bb k8s lease renew <lease_id>        # once, by the owner thread
bb k8s lease release <lease_id>      # return it; the namespace is torn down
bb k8s flags [--json]                # open flags for the steward's digest
bb k8s flag clear <id>               # the steward clears a flag it reported
```

k8s-guard calls these:

```
bb k8s lease acquire --cluster <c> --namespace <ns> --uid <uid> --thread <id> --gpu-type <t> --gpus <n> --hours <h>
bb k8s lease op begin <lease_id>     # {token, deadline}; slot_busy while another write holds it
bb k8s lease op end <lease_id> <token>
```

Every lease command prints JSON on stdout. A refusal exits 1 with `{"error": "...", "code": "..."}`.

## Lease states

| State | Meaning |
|---|---|
| `active` | GPUs are yours until `expires_at`. |
| `revoking` | It expired, its thread is gone, or it held more GPUs than leased. DGDs go to 0 on every tick. The namespace is deleted at `grace_deadline`. |
| `releasing` | Its thread returned it. The namespace is being deleted. |
| `released`, `torn-down` | The namespace is gone, and its GPUs are free. |

A lease frees its GPUs only when a host reports its namespace gone.

## Refusal codes of acquire

`not_your_thread`, `cluster_not_allowed`, `cluster_never`, `cluster_read_only`, `cluster_profile_incomplete`, `first_run_unapproved`, `too_many_hours`, `gpu_type_not_on_cluster`, `gpu_type_no_limit`, `multi_node_unapproved`, `enforcement_unhealthy`, `namespace_leased`, `over_limit`, `thread_not_live`, `namespace_not_found`, `uid_mismatch`, `not_your_namespace`, `namespace_over_lease`, `gpu_type_mismatch`.
