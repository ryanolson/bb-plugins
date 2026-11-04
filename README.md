# bb-plugins

Plugins for [bb](https://bb.dev), the agentic IDE.

| Plugin | What it does |
| --- | --- |
| [`roundtable/`](roundtable/) | A group chat where several agents (different providers) share one transcript, get tagged in with `@handle`, and go back and forth for a set number of turns on an idea or an implementation. |
| [`review-desk/`](review-desk/) | A GitHub pull request review page inside bb: Pierre diffs with inline GitHub threads and comment authoring, a chat with an analyst that has the PR checked out, code pills for pointing at lines, files, symbols, and threads, and a tree-sitter codemap. |
| [`k8s-leases/`](k8s-leases/) | GPU leases by type for agents on our k8s clusters: limits that hold across hosts, fenced writes, an Extend button, and teardown of every lease that expires, is returned, or loses its thread, through `k8s-guard`. |

Each directory is a self-contained plugin with its own `package.json`, README, and `PLUGIN_OVERVIEW.md`.

## Install

```
git clone git@github.com:ishandhanani/bb-plugins.git
cd bb-plugins
bb plugin install ./roundtable
bb plugin install ./review-desk
bb plugin install ./k8s-leases
```

Iterate with `bb plugin reload <id>`; type-check a plugin with `npx tsc -p .` inside its directory.
