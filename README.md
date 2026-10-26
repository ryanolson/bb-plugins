# bb-plugins

Plugins for [bb](https://bb.dev), the agentic IDE.

| Plugin | What it does |
| --- | --- |
| [`roundtable/`](roundtable/) | A group chat where several agents (different providers) share one transcript, get tagged in with `@handle`, and go back and forth for a set number of turns on an idea or an implementation. |
| [`review-desk/`](review-desk/) | A GitHub pull request review page inside bb: Pierre diffs with inline GitHub threads and comment authoring, a chat with an analyst that has the PR checked out, code pills for pointing at lines, files, symbols, and threads, and a tree-sitter codemap. |
| [`sgc-steward/`](sgc-steward/) | A page in bb for the questions a steward agent asks on Linear check-in issues: answer them there, get one notification per question block, and the answers go back to Linear as unsigned comments. |

Each directory is a self-contained plugin with its own `package.json`, README, and `PLUGIN_OVERVIEW.md`.

## Install

```
git clone git@github.com:ishandhanani/bb-plugins.git
cd bb-plugins
bb plugin install ./roundtable
bb plugin install ./review-desk
```

`sgc-steward` is in the `ryanolson/bb-plugins` fork:

```
bb plugin install git:https://github.com/ryanolson/bb-plugins.git --subdirectory sgc-steward
```

Iterate with `bb plugin reload <id>`; type-check a plugin with `npx tsc -p .` inside its directory.
