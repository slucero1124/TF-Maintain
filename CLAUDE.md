# TF-Maintain — Trello Power-Up

Maintenance-routine Power-Up for the UC Davis Tech Foundry (Davis/GBSF + Aggie Square, Sacramento). Staff and student workers check off recurring maintenance on Trello cards: machine cards (HAAS UMC 500, Kern lasers…), fleet cards (FDM printers, Formlabs SLA), and facility chore cards (sweeping, dusting, stock checks). Sibling of TF-Recharge, TF-Message, TF-Manufacture; same chassis, same visual language.

**Current version: 0.1** — the whole Power-Up is the single file `tf-maintain.html`. There is no build step: edit the file, bump `VERSION`, test, push.

## Owner shorthand

- **"send it" means "okay, go"**: proceed with the build or the step just discussed.
- Steven (owner) is not a developer: plain language, decisions first, short and direct.

## Non-negotiable conventions

1. **Bump `var VERSION` on every functional or visual change.** The card-back section title is `TF-Maintain v<VERSION>`; it is how Steven confirms GitHub Pages / Trello caches caught up.
2. **Palette:** Trello dark-card grays plus blue (`#579dff` / light `#0c66e4`). **Amber is approved for overdue and open issues** (owner decision for this Power-Up) and for warnings; nothing else. Monochrome line-SVG icons, no emoji. Light mode via `[data-color-mode="light"]`.
3. **Card back is one-tap only.** No input fields on the face. Notes, readings, backdating and editing hand off to the expanded view (opened at that task with `&task=<id>&do=log`).
4. **Refuse, never truncate.** Card data cap `MAX_BYTES = 3900`; every change goes through `mutate()`, which rolls back and warns if over. History is trimmed only by archiving into a card comment.
5. **Deterministic face URL.** No cache-busters, nothing volatile in `?view=summary&d=…` (lesson from TF-Message v1.19). Data `{m, q, n}` = mnt, comment high-water mark, member tag.
6. **Simulation-first.** `node test/run.js` must pass before shipping (Playwright + mock Trello; see Verification).
7. **Built-in templates are starting points**, grounded in the TF fleet (machine names from TF-Manufacture's catalog). Intervals are sensible defaults, not manufacturer schedules; staff tune them per card.

## Decisions from the brainstorm (Nov 2026)

- Cards already exist; the Power-Up attaches to them. Any card without a routine shows "No maintenance routine · Add routine…". **No auto-suggested template** from the card title.
- Mostly one machine per card; FDM and SLA fleets share one card each (units list); student chore cards for facility tasks.
- Scheduling: calendar intervals, **from last completion** (default) or **fixed schedule**. A task **opens**, has a **window of N workdays**, then is **overdue**. Weekends never count. **Holidays are not skipped** (owner decision).
- Fleet tasks: per task, either **whole fleet** (one check) or **each unit** (unit chips).
- Card-front badge **only when something is due (blue) or overdue (amber)**. No badge when all clear or when the card has no routine.
- Board button opens a **dashboard** of everything due/overdue plus open issues, filterable by site and owner.
- Completion = one tap (who + when). Optional note / reading / issue flag in the expanded view. Readings are optional and only for tasks that define a reading label.
- Issue flag: highlighted on card + dashboard **and posted as a Trello comment**.
- Owner per task (optional): anyone, a specific person, or a role (`CONFIG.ROLES`: Engineer, Technician). **Labels only, no enforcement**: anyone can complete any task.
- Site is card-level (Davis / Aggie Square / Both).
- History: recent entries on the card; older ones **archived to a card comment**.
- Templates: built-ins editable board-wide; any card's routine can be saved as a board template; "Copy from another card". Applying copies: **later template edits never change existing cards.**

## Architecture: five modes, one file

| Mode | Loaded as | Does |
|---|---|---|
| connector | bare URL, hidden iframe | `card-badges`, `card-back-section`, `board-buttons`; BroadcastChannel `tf-maint` relay (`save`, `saveT`, `open`); posts queued comments via REST |
| summary | `?view=summary&d=…` | Card face. One-tap check, unit chips, flag, clear issue, undo-today. Saves by relay to the connector **and** direct `t.set` (idempotent) |
| editor | `?view=editor[&task=&do=log]` | Expanded view: site, units, tasks (edit/log), open issues, history, templates, picker |
| dash | `?view=dash` | Board dashboard (REST read of all cards' pluginData) |
| standalone | file opened directly | Editor with `localStorage`; `?view=dash` standalone shows the local routine |

A `<head>` pre-paint script tags `<html>` with `v-summary|v-editor|v-dash|v-connector|v-standalone`; CSS shows only that view's root.

## Data model

Card shared `mnt` (compact keys):
```
{ v:1, s:'davis'|'as'|'both'|'', u:[unit names],
  k:[{ i, n, ev:'2w'|'1m'|'10d', w:windowWorkdays, md:'l'|'f', an:'YYYY-MM-DD' (fixed anchor),
       ap:'u' (each unit) | absent (whole card/fleet), rd:readingLabel, ow:owner,
       ld:'YYYY-MM-DD', lu:{unit:'YYYY-MM-DD'}, c:created }],
  h:[{ k:taskId, d:epochSec, by, u:[units]?, p:previous ld (string | {unit:prev}) for undo, nt?, r?, f? }],
  fl:[{ i, k, d, by, u?, nt? }],          // open issues
  q:[{ i:epochMs, x:commentText }] }      // comments waiting to post
```
Card shared `mntq` = `{h: id of last posted comment}`, written **only by the connector**, so stale face/editor copies can't re-post. Writers prune `q` items `<= h`.
Board shared `mntT` = `{id: {n, u, k:[tuples]}}`: board templates; a key equal to a built-in id is that built-in's board edit ("Revert to built-in" deletes it).

Template task tuple: `[name, interval, window, 'u'?, readingLabel, owner, schedule]` where schedule is `''` (from last), `'f:m1'` (fixed, day 1 monthly), `'f:w1'` (fixed weekly from Monday), or `'fYYYY-MM-DD'` (saved anchor). Template anchors resolve to the next occurrence on/after today so new tasks never start overdue. Never-done from-last tasks open on the day they're added (staff can set "Last done" in Edit).

## Scheduling (`slotStatus`)

- From last: `open = nextWorkday(lastDone + interval)`; never done → `open = nextWorkday(created)`.
- Fixed: occurrences `anchor + k·interval` (month math clamps, e.g. Jan 31 → Feb 28); done on/after the current occurrence → upcoming; missed occurrences collapse into the current one.
- `due = windowEnd(open, w)` (w workdays counting the open day). `today < open` → up; `<= due` → due; else over.
- Per-unit tasks evaluate each unit; task status is the worst unit; `doneN/total` = units not yet due again.
- `window.__TODAY = 'YYYY-MM-DD'` pins "today" (tests only).

## REST API (needed for comments, dashboard, copy-from-card)

`CONFIG.APP_KEY` is **empty in v0.1**. Until it's set, everything else works; comments queue on the card (visible count in the editor) and the dashboard/copy show setup text. Setup:
1. trello.com/power-ups/admin → TF-Maintain → API key → generate; add the GitHub Pages origin as an allowed origin.
2. Put the key in `CONFIG.APP_KEY`, bump version, ship.
3. Each member taps "Authorize TF-Maintain" once (editor history section or dashboard).

Known gap: two members viewing the same card at the same moment could both post the same queued comment (connector flush is per-browser). Rare; revisit if seen.

## Verification

```bash
node test/run.js
```
Uses the pre-installed Playwright/Chromium (don't `npm install playwright` in the cloud container). Serves the repo locally, replaces `p.trellocdn.com` with a mock `TrelloPowerUp` (shared `__store`, `__sets`, `__modals`, `__caps`), intercepts `api.trello.com`, pins today to Fri 2026-11-20. Covers: syntax of both script blocks, scheduling math, archive/refuse/prune rules, standalone editor flows, card face taps + relay + undo + unit chips + flag + handoffs, connector capabilities/deterministic URL/badges/relay/comment flush, dashboard filters. Screenshots land in `test/shots/` (git-ignored).

## Deploy

Served by GitHub Pages from this repo (`slucero1124/TF-Maintain`): `https://slucero1124.github.io/TF-Maintain/tf-maintain.html` once Pages is enabled on `main`. Trello Power-Up admin: iframe connector URL = that file; capabilities **Card Badges**, **Card Back Section**, **Board Buttons**. Toggle the Power-Up off/on after connector changes.

## Backlog

- Register the API key (above) so comments, the dashboard and copy-from-card go live.
- Flag from the face is only on visible rows (overdue/due/done today); upcoming tasks are flagged from the expanded view.
- Possible: Trello due date sync, holiday/closure list, "Next: date" quiet badge (both declined for v0.1).
