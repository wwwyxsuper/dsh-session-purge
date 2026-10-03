# dsh-session-purge

**Permanently delete a DSH session — straight from the archived list.**

DSH itself only offers *archive / unarchive*. Session logs are append-only, the persistence
seam exposes no delete, and the workspace registry only drops the *registration*, never the
session. This plugin closes that gap, and it is the only one that puts the action **on archived
sessions in the sidebar** — the place where sessions you are done with actually pile up.

[中文说明](./README.md)

## What it gives you

### 1. Two agent-side tools (host half)

| Tool | What it does |
|---|---|
| `session_purge_list` | Lists every session on disk: title, size, last modified, **archived / live-agent / current-session** flags (read-only; use it to confirm a target before deleting) |
| `session_purge_delete` | Deletes one session; needs `confirm: true`, optionally `allow_unarchived` / `allow_live` / `prune_registry` |

### 2. A UI entry (client half, since v0.2.0)

One additive seat on the sidebar session row (pure addition — `replaceRisk: none`):

| Seat | How it looks |
|---|---|
| `sidebar.workspaces.session.menu.item` | One extra row, **彻底删除 / Delete permanently**, inside a session's `⋯` menu (with a separator, right under *unarchive*) |

> An earlier revision also used `sidebar.workspaces.session.row.action` (a hover button at the
> end of the row). Users reported it looked bulky, so it was removed — the menu row is the
> only entry now.

**It renders only for ARCHIVED sessions.** "Is it archived?" is answered by the host half
(`GET /api/dsh-session-purge/state`); the client never guesses at an undocumented snapshot shape.

**Deleting cannot be undone, so it takes two clicks**: the first arms the row (`确认删除？`), the
second one deletes. There is no `window.confirm` — Electron renderers may disable it.

## What the delete actually removes

Three places, in one pass:

1. `<DSH_HOME>/sessions/<workspace>/<session id>/` — the session log itself
2. `<DSH_HOME>/storages/session_projcache/sessions/<session id>.json` — the projection cache (titles live here)
3. `<DSH_HOME>/storages/workspace.json` — the id in the registry (**backed up to `.bak-<stamp>` first**, then atomically replaced)

Plus an audit line in `<DSH_HOME>/session-purge.log`.

## Safety gates

| # | Gate |
|---|---|
| 1 | The UI entry only appears for **archived** sessions (the tool needs explicit `allow_unarchived: true` otherwise) |
| 2 | Refuses to delete **the session you are talking to** (self-destruct) |
| 3 | Refuses to delete a session that still has a **live agent** (it would be flushed back to disk) |
| 4 | Re-checks after deleting whether the files came back (`resurrected`) and says so plainly |
| 5 | Two-click confirm in the UI; the HTTP route requires a per-boot token injected into the page |

## HTTP routes (used only by this plugin's client half)

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/api/dsh-session-purge/state` | returns `{ ok, archived: [sessionId…] }` |
| `POST` | `/api/dsh-session-purge/delete` | body `{ sessionId, confirm: true }` |

Both require the header `x-dsh-session-purge`, and the static marker `ui` is accepted as well:
a custom request header forces a CORS preflight, and the route never approves one, so a
cross-origin page cannot reach it. The route lives on DSH's own loopback web server — no extra
port is opened.

## Install / update

It installs as a `file:` dependency into a profile (a copy, not a link). **After editing the
source you must re-copy it and restart DSH** — the client half never hot-reloads:

```powershell
$src = '<this repo>'
$dst = "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-session-purge"
robocopy $src $dst /MIR /XD node_modules
# then restart DSH
```

## Uninstall / rollback

Remove `dsh-session-purge` from the profile's `package.json` dependencies and from
`dsh.profile.bundles`, delete `node_modules\dsh-session-purge`, restart DSH. The menu row
disappears and nothing else changes.

> ⚠️ **A deleted session cannot be recovered** — that is the only irreversible part, which is why
> there is a confirmation step. The attachment directory (`$DSH_HOME/attachments/v1`) is
> content-addressed and may be shared between sessions, so it is deliberately left alone.

## Relationship to the other session-delete plugin

`dsh-session-purge` on npm is maintained by someone else and covers the same core idea. Its own
README states that **archived sessions are not visible in the sidebar, so their menu cannot be
reached** — you are told to unarchive first. This plugin is the opposite: it *only* shows on
archived sessions, which is exactly the list where deletion is wanted.

MIT License.
