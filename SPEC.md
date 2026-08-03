# TLS UAAP Roll Call Bot — Specification

Automated Telegram roll call for The LaSallian's UAAP Season 89 coverage.

**Platform:** Google Apps Script (bound to the Coverage Tracker spreadsheet)
**Language:** JavaScript (Apps Script runtime, V8)
**Triggers:** Time-driven, daily, 7:00–8:00 PM Asia/Manila — plus a Telegram webhook (Web App) for chat commands (§12)
**Behaviour:** Reads the tracker, finds tomorrow's game events, posts one roll call message per event into each sport's own Telegram group. Onboarding a new group is done from inside Telegram with `/setup`.

Chosen over Python/Railway and GitHub Actions because it must run unattended for years after the original author leaves. No hosting account, no credentials file, no credit balance, no workflow-disable rule. Handoff is transferring ownership of the spreadsheet.

---

## 1. Repository layout

```
TLS-Automated-Roll-Call/
├── SPEC.md                  # this file
├── README.md                # handoff instructions for successors
└── apps-script/             # clasp-managed, pushed to Apps Script
    ├── .clasp.json
    ├── appsscript.json
    ├── Config.js
    ├── Sheets.js
    ├── Parser.js
    ├── Season.js       # cross-month reads for the commands (§12.4)
    ├── Groups.js       # per-sport routing + Groups tab writes (§4.4)
    ├── Staffers.js
    ├── Template.js
    ├── Telegram.js
    ├── Webhook.js      # doPost + command routing (§12.1)
    ├── Commands.js     # command handlers (§12.2)
    ├── Log.js
    └── Main.js
```

`clasp push` sends local code to Apps Script. `git push` sends it to GitHub. These are **separate operations** — Apps Script does not read from GitHub.

---

## 2. Spreadsheet structure

The tracker has **one tab per month**, named exactly the month in English: `September`, `October`, `November`, `December`, `January`, ... No year in the tab name.

Two additional tabs are added by this project: `Staffers` and `Config`. A third, `_log`, is created automatically by the script.

### 2.1 Event tab layout

Rows 1–4 are headers. Data begins at **row 5**.

| Col | Contents | Notes |
|---|---|---|
| A | (unused) | |
| B | Day of month | **Mixed types** — see §3.1 |
| C | Weekday abbreviation | `Fri`, `Mon`, ... Informational only; do not trust it, derive weekday from the resolved date |
| D | Time | Usually a Date/time value, sometimes free text |
| E | Event name | `R1 Men's Football: \nDLSU vs UE` — contains newlines |
| F | Venue | May be merged across rows |
| G | `Game day` | `Yes`/`No` — **not used for filtering**, see §3.3 |
| H | `HN` | Deliverable flag |
| I | `Livetweet` | Deliverable flag |
| J | `HT` | Deliverable flag |
| K | `Buzzer` | Deliverable flag |
| L | `POTG` | Deliverable flag |
| M | `Album` | Deliverable flag |
| N | `Recap Article` | Deliverable flag |
| O | `IGs` | Deliverable flag |
| P | Photo staffers | **Ignore** |
| Q | **Sports — Recap staffers** | Comma-separated names. **Used.** |
| R | **Sports — Livetweet staffers** | Comma-separated names. **Used.** |
| S–V | Web / Layout / Execs | **Ignore** |

Only **Q and R** are read for staffer assignment. Columns P and S–V exist in the sheet but are out of scope.

### 2.2 Header merge structure (for reference)

Row 2 has group headers (`B2:D4` = Date block, `G2:O2` = Deliverables, `P2:V2` = Staffers Assigned). Row 3 has sub-headers, some merged down into row 4 (`G3:G4`, `H3:H4`, ...). `Q3:R3` is a merged "Sports" header, with `Q4=Recap` and `R4=Livetweet` beneath it.

**Do not parse headers.** Column positions are fixed. Read by column index.

### 2.3 Staffers tab

| A | B |
|---|---|
| `Name` | `Handle` |
| `Staffer 1` | `@handle1` |
| `Staffer 2` | `@handle2` |

Row 1 is a header. Names must match what is typed in columns Q and R. Matching is **case-insensitive and whitespace-trimmed**.

### 2.4 Config tab

Key–value pairs, header in row 1.

| A (`Key`) | B (`Value`) | Purpose |
|---|---|---|
| `SEASON_START_YEAR` | `2025` | See §3.2 — **must be updated each season** |
| `SEASON_START_MONTH` | `9` | Month number the season begins |
| `DRY_RUN` | `TRUE` | `TRUE` = log only, never send |
| `LEAD_DAYS` | `1` | Days ahead to look (1 = tomorrow) |
| `SHOW_UNASSIGNED_WARNING` | `TRUE` | Emit ⚠️ line for empty Q or R |
| `SUMMARY_MODE` | `ATTENTION` | Post-run report to the admin chat — see §6.1 |

Telegram credentials live in **Script Properties**, not here — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, plus `WEB_APP_URL` and `WEBHOOK_SECRET` for the command layer (§12.5).

Config values must be read with sensible fallback defaults so a missing row does not crash the script.

---

## 3. Parsing rules

This is the hard part of the project. Everything else is plumbing.
2
### 3.1 Date resolution — column B

Column B is typed by hand and Google Sheets coerces inconsistently. Three cases:

| Cell state | Example | Handling |
|---|---|---|
| Real Date object | `2025-09-12` | Take `.getDate()` for the day |
| Number | `15`, `19` | Use directly as day of month |
| Empty string | (continuation row) | **Forward-fill** from the last non-empty value |

Empty cells occur because **date cells are merged across multi-event days**. `getValues()` returns the value in the top-left cell and `""` for every other cell in the merge — see the live sheet's currently-populated test tab (`TEST_MONTH` in Main.js, see §9) for confirmed merge ranges.

Implementation:

```js
let lastDay = null;
for (const row of rows) {
  const raw = row[COL.DATE];
  let day = null;
  if (raw instanceof Date) day = raw.getDate();
  else if (typeof raw === 'number' && raw > 0) day = raw;
  else if (raw === '' || raw === null) day = lastDay;   // forward-fill
  if (day !== null) lastDay = day;
  // ...
}
```

**Venue (column F) is also merged** in at least one case (`F14:F15`). Forward-fill venue the same way. Do **not** forward-fill Q or R — see §3.5.

### 3.2 Year resolution

Tab names carry no year, so the year cannot be derived from the sheet alone.

Rule: given `SEASON_START_YEAR` and `SEASON_START_MONTH` from Config, a tab whose month number is **>= SEASON_START_MONTH** belongs to `SEASON_START_YEAR`; a tab whose month is **< SEASON_START_MONTH** belongs to `SEASON_START_YEAR + 1`.

With `SEASON_START_YEAR=2025`, `SEASON_START_MONTH=9`: September–December → 2025, January–May → 2026.

**This is the one value a successor must update annually.** Document it prominently in README.md.

### 3.3 Event filtering

An event qualifies for a roll call if **both** hold:

1. Resolved date == today + `LEAD_DAYS` (default: tomorrow), in Asia/Manila
2. Column E's event name resolves to an identifiable opponent per §3.4 (i.e. the `vs`/`v` split has exactly one side reading as `DLSU`)

Column G (`Game day`) is **not** used as a filter — in practice it does not reliably distinguish real games from non-game entries, so an unambiguous opponent match is the source of truth instead. Non-game events (press conferences, opening ceremonies, `Light of Hope` show) have no `vs`/`v` opponent split and are **skipped entirely** as a natural consequence of §3.4's fallback behaviour, not because of an explicit flag check.

### 3.4 Event name parsing — column E

Format as typed: `[SPORT]: DLSU vs [OPPONENT]`, with a newline before `DLSU`.

Example raw value:
```
R1 Men's Football: \nDLSU vs UE
```

Steps:
1. Normalise: replace `\n` with a space, collapse repeated whitespace, trim
2. Split on the **last** `:` → left = sport (`R1 Men's Football`), right = matchup (`DLSU vs UE`). The last colon, not the first: the sport prefix is sometimes typed with an internal colon (e.g. `R1: Men's Basketball: DLSU vs ADMU`), but the matchup never contains one.
3. Split the matchup on `vs` or `v` (word-boundary, case-insensitive) → `DLSU`, `UE`
4. Identify the opponent as the side that is **not** DLSU (do not assume DLSU is always first)

Output message uses `[OPPONENT] vs DLSU` — i.e. **reversed** from the sheet — with the sport shown separately.

Fallbacks: if there is no `:`, treat the whole string as the matchup with an empty sport. If there is no `vs`/`v`, use the raw string as the matchup and skip the reversal. **Never throw** on a malformed event name — degrade to raw text so the message still sends.

### 3.5 Staffer parsing — columns Q and R

Comma-separated names. Split on `,`, trim each, drop empties.

**Do not forward-fill Q or R.** Two games on the same day have *different* staffers per game; an empty cell means genuinely unassigned, not "same as above."

Resolve each name via the `Staffers` tab (case-insensitive, trimmed). If a name has no matching handle, output the raw name followed by a marker rather than dropping it:

```
Recap: @handle1, Staffer 2 (no handle on file)
```

If a cell is empty and `SHOW_UNASSIGNED_WARNING` is TRUE, emit a warning line (§4.2).

### 3.6 Time parsing — column D

Usually a Date/time value → format as `h:mm a` (e.g. `4:30 PM`), lowercased to match house style (`4:30 pm`).

**Format with the spreadsheet's timezone, not the script's.** `getValues()` builds a time-only cell's `Date` against Google Sheets' 1899 epoch using the *spreadsheet's* timezone, whose historical LMT offset differs from the modern one by a few odd minutes. Reading it back with `.getHours()` (which uses the *script's* timezone) leaks that difference in as a skew — observed as `4:00 PM` coming out `4:23 pm`. Use `Utilities.formatDate(raw, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'h:mm a')`: building and formatting the instant with the same zone cancels the offset exactly.

Sometimes free text, e.g.:
```
2PM (Mass)

6PM Opening Program
```
When the value is not a Date, **pass the raw string through** with newlines collapsed to spaces. Do not attempt to parse it. (In practice these appear on non-game rows, which are filtered out anyway — but handle it defensively.)

### 3.7 Deliverables — columns G–O

Collect the columns marked `Yes` and map to display labels:

```js
const DELIVERABLE_LABELS = {
  G: 'Game Day',
  H: 'HN',
  I: 'Livetweet',
  J: 'HT',
  K: 'Buzzer',
  L: 'POTG',
  M: 'Album Caption',
  N: 'Recap',
  O: 'IGs',
};
```

Note two renames from the sheet headers: `Album` → `Album Caption`, `Recap Article` → `Recap`. Column G (`Game day`) **is** included in this list as `Game Day` — note it is still **not** used for event filtering (§3.3); the two roles are independent.

Join with `, ` in column order.

---

## 4. Message template

### 4.1 Format

One message per event. Existing house format, to be reproduced closely:

```
SPORTS @rollcall

[SPORT]
[OPPONENT] vs DLSU
[Month] [Day] ([Weekday])
Time: [time]
Venue: [venue]

Recap: [recap handles]
Livetweet: [livetweet handles]

Don't forget to discuss w your co-writer on how to distribute captions!

Deliverables: [comma-separated deliverables]

[conditional reminders]

Thank you so much & enjoy!
```

Send with `parse_mode: 'HTML'` (safer than Markdown — Telegram's legacy Markdown breaks on unescaped `_`, which appears in handles like `@handle2`). Escape `&`, `<`, `>` in all interpolated values.

### 4.2 Conditional lines

| Condition | Line |
|---|---|
| `HN` is a deliverable | `Pls send HN at least 30 min before the game starts!` |
| `Buzzer` is a deliverable | `And pls prep buzzer before the game ends!` |
| Column Q empty | `⚠️ Recap: UNASSIGNED` |
| Column R empty | `⚠️ Livetweet: UNASSIGNED` |

The HN and Buzzer reminders are emitted **only** when those deliverables are checked. Both, one, or neither may appear.

Unassigned warnings replace the corresponding `Recap:`/`Livetweet:` line rather than appearing alongside it.

### 4.3 Multiple events

Send **separate messages** per event, not one combined digest. Two games on the same day have different staffers, times, and venues; separate messages are easier to act on and to reply to.

### 4.4 Per-sport routing (Telegram forum topics)

Roll calls are **not** all sent to one chat. Each sport has its own Telegram group, and each group is a **forum** whose tabs are topics (threads). Roll calls post into that group's **Roll Call** topic. Selecting a topic requires two values on the Telegram `sendMessage` call: `chat_id` (the group) and `message_thread_id` (the topic).

A `Groups` tab maps sport → destination:

| A (`Sport keyword`) | B (`Chat ID`) | C (`Thread ID`) | D (`Notes`) | E (`Group title`) | F (`Last updated`) | G (`Active`) |
|---|---|---|---|---|---|---|
| `Basketball` | `-100…` | `<Roll Call topic id>` | covers Men's, Women's, 3x3 | `UAAP 88 Basketball GC` | `2025-09-01 19:04` | `TRUE` |
| `Football` | `-100…` | `<Roll Call topic id>` | | `UAAP 88 Football GC` | | `TRUE` |

- **Row order is priority.** For each event, the first row whose keyword (case-insensitive, apostrophe-normalised) is a substring of the event's `sport` wins. Specific keywords (e.g. `3x3`) go above general ones (e.g. `Basketball`) when a sub-variant needs its own topic; otherwise the general row covers all its variants.
- Rows missing a keyword or Chat ID are skipped (safe as templates).
- **Column G `Active`:** `FALSE` retires a row without deleting it (`/unmap` writes this). **Blank counts as active** — the column was added after rows existed by hand, and an empty cell must never silently disable a working mapping.
- Columns E and F are written by `/setup` for humans; the script never reads them.
- **Unmapped sport → admin/fallback chat.** `TELEGRAM_CHAT_ID` (Script Properties) is the admin chat: error alerts (§6) and any roll call with no matching Groups row go here, the latter with an appended warning so it's never silently lost.
- `Thread ID` blank ⇒ send with no `message_thread_id` (posts to a non-forum group's main view).

Rows are normally written by `/setup` from inside the GC (§12.2). `setupGroupsTab()` still creates and seeds the tab for a manual start; `harvestChatIds()` remains as a webhook-down fallback but is superseded by `/whereami`.

**Insertion order is derived from the data, not guessed.** Appending a new keyword is wrong whenever an existing broader rule already matches the same games — a `3x3` row below `Basketball` never wins, because a 3x3 game's sport contains both words. Keyword *length* is not a usable proxy for specificity either (`basketball` is longer than `3x3`). So `upsertGroupMapping_` collects the sport strings the new keyword matches, finds the first existing rule that also matches any of them, and inserts directly above it. Nothing conflicting ⇒ append.

---

## 5. Idempotency

The bot must never double-post. Apps Script triggers can fire more than once, and manual test runs can overlap with the scheduled run.

Maintain a hidden tab `_log`:

| A | B | C |
|---|---|---|
| `Timestamp` | `EventKey` | `Status` |

`EventKey` = a stable hash or concatenation of `resolvedDate + sport + opponent + time`.

Before sending, check whether that `EventKey` already appears with status `SENT`. If so, skip and log `SKIPPED_DUPLICATE`.

A **dry run must never write `SENT`** — doing so would poison the ledger and make a later real send skip the event as a duplicate. Dry runs log the distinct status `DRY_RUN`, which the duplicate check ignores (only `SENT` counts). So the recognised statuses are `SENT`, `SKIPPED_DUPLICATE`, `DRY_RUN`, and `ERROR`.

Create the tab automatically if missing. Hide it from normal view.

---

## 6. Error handling

Wrap the entire `main()` in `try/catch`. On exception:

1. Log to `_log` with status `ERROR` and the message text
2. Send a plain-text Telegram message to the same chat: `⚠️ Roll call bot error: [message]`

A silent failure is the worst outcome — the newsroom would assume no events rather than a broken bot. Loud failure is correct here.

Guard individually so one bad row does not kill the whole run: if a single event fails to parse, log it, notify, and continue to the next event.

### 6.1 Post-run report

`sendMatchingEvents_` returns one outcome per event (`{event, status, matched, dest, unassigned}`) and `reportRun_` turns them into a message to the admin chat. `SUMMARY_MODE` (Config tab) selects the policy:

| Value | Behaviour |
|---|---|
| `ATTENTION` (default) | Report only when something needs a human |
| `ALWAYS` | Report every night, clean or not |
| `NEVER` | No report; error alerts (§6) still send |

Three things count as needing a human: an event whose sport has **no Groups mapping** (its roll call went to the admin chat instead of the staffers), a **blank Recap or Livetweet cell** for a game happening tomorrow, and an event that **failed outright**.

The default is silence-on-success by design. A nightly "all good" message is read for a week and ignored forever after, which is worse than no message at all — the signal has to stay rare to stay meaningful. A duplicate skip is not reported as a problem: it is the idempotency ledger working, and it is the *expected* state for any game already pushed manually with `/rollcall`.

---

## 7. Timezone

Set the Apps Script project timezone to **Asia/Manila** (Project Settings → Time zone).

Use `Utilities.formatDate(date, 'Asia/Manila', pattern)` for all formatting. Never rely on the runtime default. Compute "tomorrow" in Manila time, not UTC.

---

## 8. Configuration reference

**Script Properties** (Project Settings → Script Properties):

| Key | Example |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | `-1234567890` |

Chat ID is negative for groups. Note: if the group is ever upgraded to a **supergroup**, its ID changes (gains a `-100` prefix) and sending will fail. Re-fetch via `getUpdates` if messages stop arriving.

`DRY_RUN` lives in the **Config tab**, not Script Properties, so a non-technical successor can toggle it from the spreadsheet.

---

## 9. Build order

Build and verify one step at a time. Do not proceed until the current step works in the Apps Script editor.

| # | Deliverable | Verification |
|---|---|---|
| 1 | `testRead()` — log first 20 rows of the `TEST_MONTH` tab | Execution log shows raw values |
| 2 | Config + Staffers readers | Log parsed config object and staffer map |
| 3 | Date resolver with forward-fill | Log resolved date per row; confirm merged-cell rows inherit correctly |
| 4 | Event filter (tomorrow + identifiable opponent) | Log matched rows for a hardcoded test date |
| 5 | Event name parser (sport / opponent split) | Log structured objects for all `TEST_MONTH` rows |
| 6 | Deliverables + staffer resolution | Log full event objects with handles |
| 7 | Message renderer | Log the exact string that would be sent |
| 8 | Telegram send | Set `DRY_RUN=FALSE`, confirm in test group |
| 9 | `_log` tab + idempotency check | Run twice, confirm second run skips |
| 10 | Error handling + notification | Force an exception, confirm alert arrives |
| 11 | Time-driven trigger | Wait one night |

For steps 3–7, `testEventFilter`/`testFullEventBuild`/`testMessageRender` (Main.js) default to the `TEST_DATE` constant since the Apps Script editor's Run button can't pass arguments; pass an explicit `dateString` to try a different date without editing code. `TEST_MONTH`/`TEST_DATE` in Main.js point at whichever month tab currently holds populated sample game data — update those two constants (and re-push) when switching to a different reference tab. A day with multiple events and at least one merged date cell across rows makes the best fixture.

---

## 10. Handoff notes (for README.md)

Write a README covering:

- **Annual task:** update `SEASON_START_YEAR` in the Config tab at the start of each season
- Adding a staffer: add a row to the `Staffers` tab, no code change needed
- Changing send time: Apps Script → Triggers → edit the existing trigger
- Pausing the bot: set `DRY_RUN` to `TRUE` in the Config tab
- If messages stop: check the group is still a plain group (not upgraded to supergroup), check the `_log` tab for errors
- Tab naming convention must stay exactly the English month name

---

## 11. Explicit non-goals

- Photo, Web, Layout, Execs columns (P, S–V) — not read
- Non-game events — skipped, never announced
- Per-event reminders at N hours before start — v2 at the earliest; current scope is one 7 PM run the day before
- Reading replies or confirmations from staffers — the bot reads **commands** (§12) but never tracks who acknowledged a roll call
- Editing the spreadsheet — read-only except the `_log` tab and, since §12, the `Groups` tab (written only by `/setup` and `/unmap`)

---

## 12. Command layer

Roll calls are one message per game across a dozen sport GCs, and each GC has to be wired to the tracker before its first game. Doing that by hand — post a message, run `harvestChatIds()`, read the log, paste two IDs into a row, get the row order right — is a dozen chances to typo an ID into a mapping that fails silently in three weeks. The commands move onboarding into the place where the person doing it already is: the Telegram group itself.

### 12.1 Transport

Telegram delivers updates to the Web App's `/exec` URL. `doPost` (Webhook.js) parses the update and routes to a handler in Commands.js.

```
Telegram group                     Apps Script                     Coverage Tracker
──────────────                     ───────────                     ────────────────
 admin types            webhook POST
 /setup          ──────────────────► doPost(e)
                                        │  secret check
                                        ▼
                                    handleUpdate_()
                                        │  parseCommand_ → {command, args}
                                        ▼
                                    handleSetup_()  ──── read ────► month tabs
                                        │                           (sports list)
                                        │  ◄─── write ────────────► Groups tab
                                        ▼
 reply in-thread ◄──── sendReply_ ──────┘
```

Rules that are not optional:

- **`doPost` must answer 200, and must return NOTHING to do it.** Returning a `ContentService` output looks like the polite thing to do and is a trap: Apps Script serves those via a **302 redirect** to `googleusercontent.com`, Telegram does not follow redirects on a webhook response, and it reads the 302 as a failed delivery. It then retries the same update, the handler processes it again and replies again — an unbounded loop of identical messages. *This was observed in production:* a single `/help` produced a stream of identical replies until the webhook was removed. Falling off the end of `doPost` returns a bare empty 200, which is what Telegram wants. Handler exceptions are caught by `runCommand_`, which replies with the error rather than letting it escape.
- **Updates are deduplicated by `update_id`** (`isDuplicateUpdate_`, 6-hour `CacheService` entry). Telegram guarantees only *at-least-once* delivery, so a slow or lost response brings the same update back regardless of how correct the response path is. Correctness cannot rest on every response being perfect when the cost of being wrong is a duplicate roll call posted to a GC of staffers. Fails **open**: if the cache is unavailable the update is processed, because a rare double reply beats commands silently doing nothing.
- **Edited messages are ignored.** Editing `/next` into `/rollcall` must not fire a post.
- **Unknown commands exit silently.** Other bots share these groups; answering `/recap` with "unknown command" would be noise.
- **Replies are plain text, never HTML.** They quote group titles, sheet values, and user input; one stray `<` in HTML mode makes Telegram reject the whole message, turning a helpful error into silence. Only the roll call itself uses `parse_mode: HTML` (§4.1).

### 12.2 Commands

| Command | Who | Effect |
|---|---|---|
| `/setup [sport]` | admins | Map this topic as the sport's Roll Call destination. Writes the `Groups` row. |
| `/rollcall [sport] [force]` | admins | Post the next upcoming roll call for this GC now; logs `SENT`. |
| `/next [sport]` | anyone | Preview the next game and its exact message. Sends nothing, logs nothing. |
| `/whereami` | anyone | Chat/thread IDs, mapping, `DRY_RUN`, season, trigger status. |
| `/groups` | anyone | Every mapping in priority order, plus sports with upcoming games and no GC. |
| `/unmap` | admins | Sets `Active = FALSE` on this topic's rows. |
| `/help`, `/start` | anyone | Command list + whether this GC is mapped. |

Admin gating uses `getChatMember` and **fails closed** — an API error denies. Anonymous admin posts carry no user id and will not pass; post normally.

`/setup` and `/unmap` take `LockService.getScriptLock()`: the `Groups` write is read-modify-write and may insert a row, so two GCs being set up at once must serialise.

### 12.3 `/setup` — deriving the sport

With no argument, the sport is inferred from the group's title; `/setup <keyword>` overrides it. The derivation:

1. Strip punctuation, lowercase, drop bare numbers and noise words (`gc`, `uaap`, `season`, …) — `TITLE_NOISE_WORDS` in Groups.js.
2. Generate every contiguous n-gram of what's left, **longest first**, so `Beach Volleyball GC` prefers `beach volleyball` over the bare `volleyball` that would also swallow every indoor game.
3. Take the first candidate that appears in a sport name **actually present in the tracker**.

Step 3 is the important one. A keyword is only accepted if the tracker really has that sport, because the failure mode of a wrong mapping is invisible: no error, no alert, just a roll call that never arrives, discovered weeks later by the staffer who wasn't told about their game. Nothing matches ⇒ `/setup` refuses, lists the sports it does know, and asks for an explicit keyword.

The reply reports what it matched, how many upcoming games that covers, the next fixture, the exact destination, and — when it applies — that `DRY_RUN` is still `TRUE`.

Re-running `/setup` for the same keyword **updates the row in place** rather than appending. That is what makes a season rollover cheap: same sports, new GCs, one `/setup` per group.

### 12.4 Finding "the next game"

The nightly run knows its target date, so it knows which month tab to open. The commands don't: the next Football game may be in this tab, the next one, or the one after. `Season.js` resolves every month tab to its season year (§3.2), sorts chronologically, and walks forward, returning as soon as it has enough matches — normally one tab read. Tabs that aren't English month names are skipped by name, so `Config`, `Staffers`, `Groups`, and `_log` need no exclusion list and a new month tab needs no code change.

### 12.5 Guards on the manual push

`/rollcall` shares the idempotency ledger with the nightly run (§5) — same `EventKey`, same `SENT` status — which is the entire point: a game pushed by hand at noon is skipped by the 7 PM run automatically.

- **Already sent** ⇒ refuse and say when. `force` overrides (for a post someone deleted).
- **More than 14 days out** ⇒ refuse and show the date. A push that far ahead is almost always the wrong GC or a sport whose season hasn't started. `force` overrides.
- **`DRY_RUN` is deliberately ignored.** It pauses the *unattended* run; someone typing a command is not unattended. The reply says so when `DRY_RUN` is `TRUE`, so the operator knows the nightly run is still paused.
- The `_log` Detail column records the pusher (`manual: @handle`), so the ledger stays auditable.

### 12.6 Onboarding a new GC

Adding the bot to a group fires a `my_chat_member` update; the bot replies with the sport it inferred from the title and the one command to run. Setup starts before anyone has to remember a command exists — which is why `setupWebhook()` subscribes to `my_chat_member` and not just `message`.

### 12.7 Deployment constraints

- **One webhook per bot token.** Registering here silently steals updates from any other script sharing the token. `setupWebhook()` refuses when a webhook already points elsewhere; `replaceExistingWebhook()` is the deliberate override. `checkWebhook()` prints the bot username and current URL.
- **Always edit the existing deployment.** A new deployment mints a new `/exec` URL, and Telegram keeps POSTing to the dead one. Deploy → Manage deployments → ✏️ → New version.
- **`getUpdates` and a webhook are mutually exclusive** — with the webhook live, `harvestChatIds()` returns 409.
- **The `/exec` URL is public.** Apps Script cannot read request headers, so Telegram's `secret_token` header is unusable; the secret rides in the query string instead (`WEBHOOK_SECRET`, checked by `webhookSecretOk_`). Unset, the endpoint accepts anything that finds it.
- **`SPREADSHEET_ID`** is an optional Script Property. A webhook request is a different execution context than an editor run or a trigger, and `getActiveSpreadsheet()` is only guaranteed for the bound ones; `getSpreadsheet_()` falls back to `openById` when it's set.