GPU leases by type for agents on our k8s clusters: limits that hold across hosts, one fenced write at a time, and teardown of every lease that expires, is returned, or loses its thread.

## What you get

- A **k8s leases** page in the left sidebar. It lists every lease with its thread, cluster, namespace, GPU type and count, state, and time left. It also shows the GPUs held of each type against its limit, the enforcement hosts and their last heartbeat, and the open flags.
- An **Extend** button on each active lease: +30 min, +1 h, +2 h, or a custom amount in minutes or hours. An extension also moves the namespace's `expires-at`, which `k8s-guard` keeps in the namespace. A revoking lease shows why, and has no button.
- `bb k8s` for k8s-guard and agents: `lease acquire`, `show`, `op begin`, `op end`, `release`, `renew`, then `leases` to see what runs where, and `flags` for the steward's digest.
- A reconcile every minute, on any healthy enforcement host. It scales revoked namespaces to 0 on every tick, and deletes them after the grace period, with the namespace UID as a precondition.

## For agents

The bundled `k8s-leases` skill gives the commands, the lease states, and the refusal codes.
