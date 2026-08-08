# TLS UAAP Roll Call Bot — Specification

Automated Telegram roll call for The LaSallian's UAAP Season 89 coverage.

**Platform:** Google Apps Script (bound to the Coverage Tracker spreadsheet)
**Language:** JavaScript (Apps Script runtime, V8)
**Triggers:** Time-driven, daily, 7:00–8:00 PM Asia/Manila — plus a Telegram webhook (Web App) for chat commands (§12)
**Behaviour:** Reads the tracker, finds tomorrow's game events, posts one roll call message per event into each sport's own Telegram group. Onboarding a new group is done from inside Telegram with `/rollsetup`.

Chosen over Python/Railway and GitHub Actions because it must run unattended for years after the original author leaves. No hosting account, no credentials file, no credit balance, no workflow-disable rule. Handoff is transferring ownership of the spreadsheet.

---

## 1. Repository layout

```
TLS-Automated-Roll-Call/
├── SPEC.md                  # this file
├── README.md                # handoff instructions for successors
├── tests/                   # Node-only; NEVER pushed to Apps Script (§3.4)
│   └── parser.test.js
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
| `SEASON_NUMBER` | `88` | Used in every roll call's title line (§4.1) — **must be updated each season** |
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
2. Column E is non-empty

That is the whole filter. Every row in a coverage tracker is, by definition, something the team is covering.

**This replaced an earlier rule that required an identifiable opponent**, and the reason matters. Requiring a `DLSU vs X` split silently discarded three whole families of real work:

- tournament-wide events — opening ceremonies, awardings, press conferences, the `Light of Hope` show
- every multi-day tournament session — `Fencing Day 1`, `Athletics Day 2`, `Golf Day 1`
- anything else typed without a matchup

None of these throw, log, or alert when dropped. The roll call simply never arrives.

Column G (`Game day`) is still **not** used: in the live tracker it reads `No` on most genuine games, so it distinguishes nothing.

Being permissive here is safe because **routing is the second gate** (§4.4). An event whose text matches no `Groups` keyword goes to the admin chat with a warning rather than to a GC, so a spurious row surfaces for a human instead of being discarded without trace.

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

Output message uses `[OPPONENT] vs DLSU` — i.e. **reversed** from the sheet — with the category in a bracket after it.

Fallbacks: if there is no `:`, treat the whole string as the matchup with an empty sport. If there is no `vs`/`v`, the event has no opponent and renders its `detail` text instead. **Never throw** on a malformed event name — degrade to raw text so the message still sends.

`parseEventName_` returns five fields:

| Field | From | Example (`Fencing Day 1: Men's Sabre Individual`) |
|---|---|---|
| `sport` | before the last `:`, as typed | `Fencing Day 1` |
| `family` | `sport` with round/day/category stripped | `Fencing` |
| `category` | `Men's` / `Women's` / `''` | `Men's` |
| `opponent` | the non-DLSU side of the `vs` split | `''` (`hasOpponent: false`) |
| `detail` | the non-matchup remainder | `Men's Sabre Individual` |

#### Sport family

`family` is what session-mode collation groups by (§4.5) and what the title line is built from. Four steps, in order:

1. **`Day N` delimits the sport from the session detail**, exactly like the colon does. `Fencing Day 1` is the sport; `Men's Sabre Individual` is one session of it. Safe to drop because collation is already scoped to a single date, and Day 1 and Day 2 are by definition different days. This is also what rescues colon-less names like `Athletics Day 1`.
2. Strip round prefixes (`R1`, `R4:`) — they number the fixture, not the sport.
3. Strip category words — they move to the bracket on the opponent line.

What survives is deliberately specific. `3x3 Basketball` stays distinct from `Basketball`, `Blitz Chess` from `Chess`, `Beach Volleyball` from `Volleyball`: these are separate competitions that happen to share a GC, and must never be merged into one another's roll call. Conversely `Men's Football` and `Women's Football` both reduce to `Football`, so they *can* share one when the sport is in session mode.

Verified against every real event name in `tests/parser.test.js` (`node tests/parser.test.js`). That file lives outside `apps-script/` on purpose — Apps Script concatenates every pushed file into one global scope, so a test file's declarations collide with the source's and break the project at parse time.

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

One template serves both modes (§4.5). A single football game and a fencing day with three sessions produce the same shape of message; only the block above the title differs. Two templates would drift apart, and a GC would see two different-looking roll calls depending on the sport.

```
SPORTS @rollcall

📍
[headline lines]
UAAP Season [SEASON_NUMBER] [FAMILY] Tournament
[Month] [Day] ([Weekday])
Time: [time]
Venue: [venue]

Recap: [recap handles]
Livetweet: [livetweet handles]

Don't forget to discuss w your co-writer on how to distribute captions!!

Deliverables:
[comma-separated deliverables]

[conditional reminders]

Thank you so much & enjoy!
```

**Headline lines** — what is actually happening:

- Rows *with* an opponent collapse per category, so five chess games become two lines. A single opponent skips the brackets; they exist to punctuate a list.
  ```
  [FEU, UST] vs DLSU [Men's]
  ADMU vs DLSU [Women's]
  ```
- Rows *without* an opponent contribute their `detail` text instead — which is what a fencing or athletics day is made of. A group can contain both; opponents lead.
  ```
  Men's Sabre Individual
  Women's Foil Team
  ```

**Title line** — `UAAP Season 88 Fencing Tournament`, from `SEASON_NUMBER` and the family. Events already named `UAAP …` (ceremonies, shows, press conferences) carry their own full title in the sheet and render it as typed; wrapping one would produce `UAAP Season 88 UAAP Season 88 Collegiate Basketball Press Conference Tournament`.

**Weekday** is the full name (`Friday`), not the abbreviation.

**Collapsed fields** — a group's rows are reduced to one line each:

| Field | Rule |
|---|---|
| Time | All equal ⇒ that time. Differing ⇒ `Beginning at [earliest]`. None ⇒ `TBA`. A round hour prints as `10 am`, not `10:00 am`. |
| Venue | Distinct venues in sheet order, comma-joined. Usually one — merged cells see to that. |
| Deliverables | Union across the group, re-emitted in column order. |
| Recap / Livetweet | Union across the group, deduplicated case-insensitively, order preserved. |

Assignment is judged across the whole message: one staffer named on any row of a fencing day covers that day, and warning otherwise would cry wolf on every session that lists its staffers on the first row only.

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

How many messages a day produces is decided per sport by the `Mode` column — see §4.5.

### 4.4 Per-sport routing (Telegram forum topics)

Roll calls are **not** all sent to one chat. Each sport has its own Telegram group, and each group is a **forum** whose tabs are topics (threads). Roll calls post into that group's **Roll Call** topic. Selecting a topic requires two values on the Telegram `sendMessage` call: `chat_id` (the group) and `message_thread_id` (the topic).

**One GC = one Roll Call topic = one row.** The GCs have per-category topics (`Men's`, `Women's`, `Beach 🏖️`, `3x3`) for discussion, but every roll call posts to the single Roll Call topic, so a group needs exactly one mapping.

A `Groups` tab maps sport → destination:

| A (`Sport keyword(s)`) | B (`Chat ID`) | C (`Thread ID`) | D (`Notes`) | E (`Group title`) | F (`Last updated`) | G (`Active`) | H (`Mode`) |
|---|---|---|---|---|---|---|---|
| `3x3` | `-100…` | `<Roll Call topic id>` | Men's + Women's play as one block | `UAAP S88 Basketball` | `2025-09-01 19:04` | `TRUE` | `session` |
| `Basketball` | `-100…` | `<Roll Call topic id>` | covers Men's and Women's | `UAAP S88 Basketball` | | `TRUE` | `event` |
| `esports, valorant, nba2k` | `-100…` | `<Roll Call topic id>` | three titles, one GC | `UAAP S88 Esports` | | `TRUE` | `event` |

- **Column A holds a LIST.** `esports, valorant, nba2k` is one rule with three keywords, any of which routes here. Necessary because a GC's sports do not always share a word: `esports` appears in `Esports Mobile Legends: Bang Bang!` but not in `VALORANT` or `NBA2k`, and `baseball` is nowhere in `Women's Softball`. Before this, `/rollsetup` in the Esports GC would match the one title, report success, and **silently** never route the other two. A single keyword is just a list of one.
- **Row order is priority.** For each event, the first row with a matching keyword wins. Specific keywords (`3x3`, `blitz chess`, `beach volleyball`) go above general ones (`basketball`, `chess`, `volleyball`) — they need separate rows when they collate differently or post elsewhere.
- **Matching is two-pass** (`resolveTarget_`): every rule is tested against the event's `sport` first, then every rule against the **whole event text**. The second pass exists because not every row has a colon — `Athletics Day 1` and `Golf Day 2` carry their sport in a name the §3.4 split leaves with an empty `sport`, and without the fallback they match nothing forever. Running the passes in that order keeps a loose full-text hit from outranking a real sport-prefix one.
- Rows missing a keyword or Chat ID are skipped (safe as templates).
- **Column G `Active`:** `FALSE` retires a row without deleting it (`/unmap` writes this). **Blank counts as active** — the column was added after rows existed by hand, and an empty cell must never silently disable a working mapping.
- **Column H `Mode`:** `session` or `event`. Blank, unknown, and misspelled all fall back to `event`, the safe direction — a wrong `event` just means extra messages, whereas a wrong `session` silently merges fixtures that should have been announced separately. See §4.5.
- Columns E and F are written by `/rollsetup` for humans; the script never reads them.
- **Unmapped sport → admin/fallback chat.** `TELEGRAM_CHAT_ID` (Script Properties) is the admin chat: error alerts (§6) and any roll call with no matching Groups row go here, the latter with an appended warning so it's never silently lost.
- `Thread ID` blank ⇒ send with no `message_thread_id` (posts to a non-forum group's main view).

Rows are normally written by `/rollsetup` from inside the GC (§12.2). `setupGroupsTab()` still creates and seeds the tab for a manual start; `harvestChatIds()` remains as a webhook-down fallback but is superseded by `/rollwhere`.

**Insertion order is derived from the data, not guessed.** Appending a new keyword is wrong whenever an existing broader rule already matches the same games — a `3x3` row below `Basketball` never wins, because a 3x3 game's sport contains both words. Keyword *length* is not a usable proxy for specificity either (`basketball` is longer than `3x3`). So `upsertGroupMapping_` collects the sport strings the new keyword matches, finds the first existing rule that also matches any of them, and inserts directly above it. Nothing conflicting ⇒ append.

### 4.5 Collation — `session` vs `event`

How many messages a sport produces in a day is **configuration, not inference.**

`event` (the default) sends one roll call per fixture. Right for Football, Basketball, Volleyball, Baseball/Softball, and each Esports title: each game stands alone with its own staffers, time and venue.

`session` merges every row matching that rule, on one date, into a single message. Right for Fencing, Athletics, Golf, 3x3 and Chess, where the categories play as one block. A `Fencing Day 1` with three bouts at 9 AM and 1 PM becomes one roll call, not three.

**Why it cannot be derived.** `R4 Men's Blitz Chess:` and `R1 Men's Football:` are typed identically in the sheet and behave oppositely — chess merges, football does not. `Day N` is a reliable tell for the sports that use it, but Blitz Chess and 3x3 carry no such marker. There is no signal in the tracker that separates them, so the answer has to be stored. `/rollsetup` *suggests* `session` when it sees `Day N` in the sport's rows, but never assumes it.

**Grouping key** — `(date, chat, thread, family)`. Venue plays no part: a session-mode sport running at two venues in one day still posts one message, listing both. Different sports resolve to different families and different GCs, so they never merge into each other regardless of sharing a date, a time, or a venue.

Unmapped events (admin chat) always fall into `event` mode and are never silently merged with anything.

**Changing mode mid-season** is a one-cell edit and nothing migrates — but it changes the shape of the ledger key (§5), so a roll call already sent under the old mode is invisible to a lookup under the new one. `findPriorSend_` therefore checks the alternate-mode keys too, and a hit under the other mode is reported as `SKIPPED_MODE_CHANGED` rather than `SKIPPED_DUPLICATE`: skipping is the safe half of that decision, but it can leave rows unannounced, so §6.1 tells a human instead of swallowing it.

---

## 5. Idempotency

The bot must never double-post. Apps Script triggers can fire more than once, and manual test runs can overlap with the scheduled run.

Maintain a hidden tab `_log`:

| A | B | C |
|---|---|---|
| `Timestamp` | `EventKey` | `Status` |

**The unit is the MESSAGE, not the row** — a session-mode sport posts one roll call covering several rows (§4.5), and keying on the row would let the same fencing day be announced three times.

| Mode | `EventKey` |
|---|---|
| `session` | `year\|month\|day\|family\|session` |
| `event` | `year\|month\|day\|family\|category\|opponent-or-detail\|time` |

The event-mode discriminator falls back to `detail` because a row without an opponent still has to be distinguishable from its neighbours; two rows of the same family, category and time would otherwise collide.

The key deliberately **excludes the chat and thread.** Routing is derived from the event, and including the destination would make re-pointing a GC mid-season look like a brand new message and re-announce everything already sent.

Before sending, `findPriorSend_` checks that key **and the keys the same rows would have had under the other mode** — see §4.5. A same-mode hit logs `SKIPPED_DUPLICATE`; an other-mode hit logs `SKIPPED_MODE_CHANGED` and is surfaced in the post-run report.

A **dry run must never write `SENT`** — doing so would poison the ledger and make a later real send skip the message as a duplicate. Dry runs log the distinct status `DRY_RUN`, which the duplicate check ignores (only `SENT` counts). So the recognised statuses are `SENT`, `SKIPPED_DUPLICATE`, `SKIPPED_MODE_CHANGED`, `DRY_RUN`, and `ERROR`.

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
| 4 | Event filter (tomorrow + non-empty name) | Log matched rows for a hardcoded test date |
| 5 | Event name parser (sport / family / category / opponent) | Log structured objects for all `TEST_MONTH` rows; check `family` when collation misbehaves |
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

- **Annual task:** update `SEASON_NUMBER` and `SEASON_START_YEAR` in the Config tab at the start of each season
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
- Editing the spreadsheet — read-only except the `_log` tab and, since §12, the `Groups` tab (written only by `/rollsetup` and `/unmap`)

---

## 12. Command layer

Roll calls are one message per game across a dozen sport GCs, and each GC has to be wired to the tracker before its first game. Doing that by hand — post a message, run `harvestChatIds()`, read the log, paste two IDs into a row, get the row order right — is a dozen chances to typo an ID into a mapping that fails silently in three weeks. The commands move onboarding into the place where the person doing it already is: the Telegram group itself.

### 12.1 Transport

Telegram delivers updates to the Web App's `/exec` URL. `doPost` (Webhook.js) parses the update and routes to a handler in Commands.js.

```
Telegram group                     Apps Script                     Coverage Tracker
──────────────                     ───────────                     ────────────────
 admin types            webhook POST
 /rollsetup          ──────────────────► doPost(e)
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
| `/rollsetup [sports] [session\|event] [force]` | admins | Map this topic as the Roll Call destination. Writes the `Groups` row. Keywords may be comma-separated; `session`/`event` sets the mode (§4.5); bare `/rollsetup session` retunes what is already mapped here; `force` maps a sport the tracker does not have yet. |
| `/rollcall [sport] [force]` | admins | Post the next upcoming roll call for this GC now; logs `SENT`. |
| `/next [sport]` | anyone | Preview the next roll call and its exact message, including how many rows it collates. Sends nothing, logs nothing. |
| `/rollwhere` | anyone | Chat/thread IDs, mapping, `DRY_RUN`, season, trigger status. |
| `/groups` | anyone | Every mapping in priority order, plus sports with upcoming games and no GC. |
| `/unmap` | admins | Sets `Active = FALSE` on this topic's rows. |
| `/help`, `/start` | anyone | Command list + whether this GC is mapped. |

**Why `/rollsetup` and `/rollwhere` and not the obvious `/setup` and `/whereami`:** this bot shares its groups with The LaSallian's `/recap` bot, which already owns `/setup`, `/recap`, `/sports`, and `/whereami`. Telegram broadcasts a bare command to **every** bot in a group — there is no way for a bot to claim a name — so both bots answered `/setup`, one with a success and one with a usage error. Distinct names are the only fix that works without asking staffers to remember a suffix. Do not "tidy" these back to `/setup`.

The `@botname` suffix (`/rollsetup@SportsRollCall_bot`) is the complementary half: `parseCommand_` drops any command explicitly addressed to a *different* bot, so the two never both respond to a suffixed command either. It **fails open** when the bot's own username can't be resolved — answering a command that might not be ours beats going mute because `getMe` hiccuped. `BOT_USERNAME` (Script Property) short-circuits that lookup entirely.

Admin gating uses `getChatMember` and **fails closed** — an API error denies. Anonymous admin posts carry no user id and will not pass; post normally.

`/rollsetup` and `/unmap` take `LockService.getScriptLock()`: the `Groups` write is read-modify-write and may insert a row, so two GCs being set up at once must serialise.

### 12.3 `/rollsetup` — deriving the sport

With no argument, the sport is inferred from the group's title; `/rollsetup <keyword>` overrides it. The derivation:

1. Strip punctuation, lowercase, drop bare numbers and noise words (`gc`, `uaap`, `season`, …) — `TITLE_NOISE_WORDS` in Groups.js.
2. Generate every contiguous n-gram of what's left, **longest first**, so `Beach Volleyball GC` prefers `beach volleyball` over the bare `volleyball` that would also swallow every indoor game.
3. Take the first candidate that appears in a sport name **actually present in the tracker**.

Step 3 is the important one. A keyword is only accepted if the tracker really has that sport, because the failure mode of a wrong mapping is invisible: no error, no alert, just a roll call that never arrives, discovered weeks later by the staffer who wasn't told about their game. Nothing matches ⇒ `/rollsetup` refuses, lists the sports it does know, and asks for an explicit keyword.

The reply reports what it matched, how many upcoming games that covers, the next fixture, the exact destination, and — when it applies — that `DRY_RUN` is still `TRUE`.

Re-running `/rollsetup` for the same keyword **updates the row in place** rather than appending. That is what makes a season rollover cheap: same sports, new GCs, one `/rollsetup` per group.

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