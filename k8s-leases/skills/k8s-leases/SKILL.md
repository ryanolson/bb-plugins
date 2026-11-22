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

k8s-guard calls these. Take a lease with `k8s-guard lease acquire`, which passes `--uid` and `--thread` for you, or claim the pre-made namespace with `k8s-guard ns claim`.

```
bb k8s lease acquire --cluster <c> --namespace <ns> --uid <uid> --thread <id> --gpu-type <t> --gpus <n> --hours <h>
bb k8s lease acquire --claim --request <req_...> --replaces <lease_id|none> --cluster <c> --namespace <premade> --uid <uid> --gpu-type <t> --gpus <n> --hours <h> [--audit-trial]
bb k8s lease latest --cluster <c> --namespace <ns>   # the latest lease on it, live or ended
bb k8s lease op begin <lease_id>     # {token, deadline}; slot_busy while another write holds it
bb k8s lease attempt begin <lease_id> <token> --attempt <att_...> --verb <v> --kind <k> --name <n> [--uid <u> --rv <v>]
bb k8s lease attempt resolve <lease_id> <att_...> --outcome committed|failed|superseded
bb k8s lease op end <lease_id> <token>
```

A claim's owner is the calling thread. The pre-made namespace must carry `dynamo.nvidia.com/agent-lease-fence: "true"`. The fence is two Kyverno policies: `agent-lease-fence` (Pods only under the open lease) and `agent-lease-fence-canary` (refuses one probe Pod, to show which webhook answered). Before every new claim, a host runs `k8s-guard fence probe`. A claim needs the canary refused by its own entry (canary `finegrained`), and the fence armed and enforcing through its own webhook (mode `enforcing`, scope `finegrained`). A missing canary policy or a Kyverno outage refuses. Otherwise it refuses `enforcement_unhealthy`, quotes the probe and gives its `cause`. A trial (`--audit-trial`) is for a cluster's first run while the policy is in Audit: it needs `--gpus 1`, Ryan's first-run approval, and mode `audit` with scope `finegrained`. A claim's reply carries `seq`, which only rises on a namespace of that name under any kube context, and `trial`.

A person on a host, never a thread, records the proof that a stranded claim's fence is retired for good. The plugin refuses a bb thread (`not_from_thread`) only by `BB_THREAD_ID`, a convention an agent's shell can drop; the binding checks are on the host, where the guard needs the namespace's label no longer `true` and the canary admitted:

```
bb k8s lease fence-retired <lease_id> --proof <url>
```

Every lease command prints JSON on stdout. A refusal exits 1 with `{"error": "...", "code": "..."}`.

## Lease states

| State | Meaning |
|---|---|
| `active` | GPUs are yours until `expires_at`. |
| `revoking` | It expired, its thread is gone, or it held more GPUs than leased. DGDs go to 0 on every tick. The namespace is deleted at `grace_deadline`. |
| `releasing` | Its thread returned it. The namespace is being deleted. |
| `released`, `torn-down` | The namespace is gone (a claimed one: the lease's objects are gone), and its GPUs are free. |

A lease frees its GPUs only when a host reports its namespace gone. A claimed lease (the pre-made namespace) frees them only when a teardown on a host reports nothing of the lease left and no write attempt open. Its namespace is never deleted. The teardown must also report its gate closed for this lease and `seq`, a drain of at least 120 s, probes no more than 8 s apart, and the fence armed throughout (for a trial lease, Audit through its own webhook; or retired, with a recorded proof).

In Audit the canary proves only its own entry. During a Kyverno outage, a refused create proves one of the two entries, not both. Scaling the Kyverno admission controller to 0 deletes every Kyverno webhook: the probe reads not armed, the GPUs stay charged, and the cause says so.

## Flags of the fence

- `fence_disarmed`: a teardown found the fence not armed, with the guard's cause.
- `fence_disarmed_live`: the live probe (every 5 minutes) found the fence not armed, with the cause. A trial under Audit is not flagged.
- `fence_probe_failed`: the live probe could not run (no host answered, or the call failed). It says nothing about the fence.
- After either `fence_disarmed` kind, the GPUs stay charged until ops re-arm the fence, or retire it and a person records the proof. A stuck lease's `last_error` in `bb k8s lease show` carries the cause too.
- `fence_retired_refused`: the guard refused a recorded proof (the namespace is still labelled, or the canary still refused). The proof is cleared, and teardown takes the armed path again.
- `fence_retired_completion`: a claimed lease completed under a retired fence.

## Refusal codes of acquire

`not_your_thread`, `cluster_not_allowed`, `cluster_never`, `cluster_read_only`, `cluster_profile_incomplete`, `first_run_unapproved`, `too_many_hours`, `gpu_type_not_on_cluster`, `gpu_type_no_limit`, `multi_node_unapproved`, `enforcement_unhealthy`, `namespace_leased`, `over_limit`, `thread_not_live`, `namespace_not_found`, `uid_mismatch`, `not_your_namespace`, `namespace_over_lease`, `gpu_type_mismatch`. With `--claim` also: `profiles_unavailable`, `namespace_not_premade`, `namespace_not_ours`, `namespace_not_enrolled`, `predecessor_mismatch` (with `current`), `request_conflict`, `invalid_argument` (`--audit-trial` without `--claim` or with more than 1 GPU). `enforcement_unhealthy` from the fence probe carries `canary`, `mode` and `scope`.

`lease fence-retired` refuses `not_from_thread`, `lease_not_claimed` and `lease_not_in_teardown`.

`op begin` and `attempt begin` refuse `attempt_unresolved` while an earlier write's outcome is unknown; `attempt begin` refuses `slot_lost` without the live slot's token.
