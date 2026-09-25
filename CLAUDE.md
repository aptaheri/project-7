# Project 7

John Nitti's ride across seven continents: a public site, and a live tracker
behind Google sign-in. React + Vite SPA on Netlify, Netlify Functions for the
API, Neon Postgres for fixes and viewers, Mapbox for maps, Resend for email.

## Commands

```sh
npm run dev      # vite; API routes are not served — use `netlify dev` for those
npm run build    # tsc -b && vite build
npm run check    # every check suite; run before pushing
```

The suites are also individually runnable: `check-sql` (daily email),
`check-feed` (live tracker), `check-where` (public country line),
`check-access` (sign-in, roles, names), `check-fact` (destination lines).

**Build with Node 22.** The machine default is 20.18.3, and Vite 8 / rolldown
need `^20.19 || >=22.12`. `@rolldown/binding-darwin-arm64` is an *optional*
dependency, so npm silently skips it — and running `npm install` under Node 20
will *remove* a binding that was already there. The failure reads as a
lockfile problem and is not.

```sh
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
```

## Layout

| Path | What lives there |
|---|---|
| `src/` | The SPA. Pages in `src/pages`, shared bits in `src/components`. |
| `netlify/functions/` | One file per endpoint. Thin: parse, gate, delegate. |
| `netlify/lib/` | Where the thinking happens — feed, rollups, email, auth, facts. |
| `public/_redirects` | API routes. **First match wins**, so specific paths come before general ones, and the SPA catch-all comes last. Netlify processes this file before `netlify.toml`. |
| `scripts/check-*.mjs` | The test suite. See Testing below. |
| `netlify/database/migrations/` | Schema, for the record — see Schema below. |

Public pages: `/` (hero, with the country line), `/map`, `/about`, `/donate`.
Behind sign-in: `/track` (the live map), `/track/sharing` (owner-only admin).

## The route: plan versus actual

`src/data/itinerary.json` is **the plan he set out with** — 467 days, written
before he left. It is never written to at runtime, and it is the only thing
"a day behind schedule" can honestly be measured against (`daysFromPlan`).

`route_days` is **the route as it now stands**, and John edits it himself from
`/track/route`. Only days he has changed are in it; `loadRoute()` lays them over
the plan and everything downstream — email, tracker, fact warmer — reads that
merge. A day's distance is his if he gives one and Mapbox's cycling route
otherwise, and the cycling geometry is stored with it for the map and the email.

If an edit ever reaches the plan, the drift figure silently becomes zero
forever and looks entirely plausible while doing it. `check-route` asserts the
plan on disk is unchanged after a save.

## Rules that are load-bearing

Each of these has a check that fails if it is broken. They are listed because
they are the things a reasonable change would otherwise undo.

1. **`/api/where` is public and says only which country he is in.** Name, ISO
   code, flag — never coordinates, town, timestamp, or distance. The narrowing
   happens before the JSON exists, and `check-where` asserts the payload has
   nothing else in it. Everything else about live position stays behind
   `requireTrackViewer`.

2. **A tracker poll never reads the whole history.** Finished days live in
   `day_rollups` and the route behind him in `trail_cache`, both written by
   `loadRollups`; a poll reads those and computes only today. `check-feed`
   asserts no unbounded read of `locations` and no rebuild on a repeat poll.
   This is what stops the database bill growing with the length of the trip.

3. **"Today" is a range of instants, not a date expression.** Use
   `localDayRange` from `lib/day.mts`. Writing
   `(tst at time zone $zone)::date = $today` wraps the column in a function
   call, so the index on `tst` cannot answer it and Postgres reads the table.

4. **Crossing a timezone re-buckets the stored days.** Day boundaries fall at
   different instants in a new zone; without the rebuild, fixes either side of
   the old boundary are counted twice. The trip changes continent seventeen
   times.

5. **The daily email never writes a destination line.** Generating one takes
   15–25 seconds because the model searches the web first, and the send has
   about thirty to read the day's riding, render, and hand forty messages to
   Resend. `fact-warm.mts` writes them hours ahead; the send does a lookup.
   That function makes **one model call per run**, success or failure — two
   timeouts in a run would exceed the limit and lose the whole run — and
   rotates its queue so a slow place cannot take every run's attempt.

5a. **The destination piece is two questions, asked on different runs.** A
   place gets a paragraph about its past and a second about what it is now, and
   asking for both in one call does not come back inside the deadline —
   measured at the full 25 seconds on Davos, Kavala and Scuol, all three
   returning nothing at all. `Mode` in `lib/fact.mts` names the four questions a
   run may ask (`fresh`, `expand`, `curated`, `now`) and `ensureFact` picks
   exactly one: the paragraph first, then a thin one expanded, then the ride
   line — which can be *wrong* rather than merely missing — and the present
   last. Two questions of twenty seconds fit where one of forty does not.

5b. **An empty answer to the present is written down as an empty string.**
   Same trap as rule 9, one question over: a hamlet with nothing scheduled
   answers "nothing" correctly, and a null would mean never-asked and buy the
   question again every run forever. `now_line = ''` is the record of having
   asked; `factFor` reads it back as no paragraph. And the brief for it must
   forbid the model writing about itself — asked about Bad Wiessee it signed
   off "I could not reach any news sources tonight", which is addressed to a
   developer and was going to forty readers. `withoutAsides` drops such
   sentences and keeps the rest if enough of it survives.

6. **Hand-written facts beat generated ones**, always
   (`src/data/destination-facts.json`). Correcting a bad generated line means
   adding it there. A hand-written place still gets a *distance* sentence
   written for it — that is the second half of what the warmer stores, and the
   only way those mornings get one — but its fact is never regenerated, and
   never lengthened either. 30 of the 33 in that file are under 50 words, which
   is why a famous destination can still read thin: that is an editorial choice
   in a file, not something the warmer can reach. It does get the *present*
   paragraph written for it, the same as any other place — that half is about
   the town today and is not a correction anybody made.

7. **A short *generated* fact is asked once whether there is more.** Asking the
   brief for length does not work — four rewrites, a hard floor, a three-beat
   structure and a run at medium effort all produced the same two sentences,
   because the model writes what it verified in one pass and stops. Under
   `MIN_FACT_WORDS` it is handed back its own answer and asked a second question
   on a later run. If it cannot do better the row is marked `thin` and never
   asked again, so a village of four hundred people is not re-asked eight times
   a day forever.

8. **`FORMAT_VERSION` in `lib/fact.mts` is what makes a change to the brief
   take effect.** Rows below it are rewritten on the next warming run, and
   every place previously given up on is asked again. Without bumping it, a
   longer or differently-shaped line only ever appears for places nobody has
   warmed yet, and two shapes of email go out depending on when a place
   happened to come up.

9. **A row in `destination_facts` with a null `fact` is a record of having
   tried.** The model answering "nothing" is correct behaviour, not an error,
   but nothing was stored when it did, so the same village was re-asked every
   run forever. After `GIVE_UP_AFTER` refusals the warmer stops asking. The
   send treats a null fact exactly like no row at all.

10. **Bootstrap owners cannot be removed from the sharing page.** Every address
   in `TRACK_OWNER_EMAILS` is re-seeded as an owner on each load and re-promoted
   on each sign-in, so a delete succeeds and is undone a moment later. The API
   refuses with a 409 that says so; the row is tagged "Always owner".

11. **A morning the schedule missed can only be recovered by hand.** Every gate
    in `runDailyEmail` can decide *not* to send and nothing more, so a day it
    skipped at 07:00 — he had not set off yet — stayed skipped once the window
    closed. `/api/email-admin?send=all` is an owner overruling that: it ignores
    the clock, the fix age and the movement gate, sends to the whole subscriber
    list, and records `sent_emails`, so the hourly schedule will not then send
    the same day again. It **refuses a day already on record** — it is reached
    by opening a URL, and reloading one is not a decision to mail everybody a
    second copy; three clicks sent three copies on 1 September and none of them
    could be recalled, because Resend can only cancel mail that has not gone
    yet. `send=all&force=1` overrules that, which is how a day claimed by a run
    whose send then failed gets unstuck. `send=me` still goes only to the
    signed-in owner and still leaves the day unclaimed. `check-sql` asserts all
    of it.

12. **Falling behind is an edit, not a special case.** He loses days routinely —
    that is why `daysFromPlan` measures against the plan and never against
    `route_days`. `shiftFrom` slides the editor's window one day later, each day
    taking what the day before it held, and it deliberately touches **only the
    window** `/api/route` already shows: he replans as he rides and the days
    beyond it are left on the plan to be shifted when they come into view. It
    fetches no directions — a leg moved to another date is the same road between
    the same two towns, so its distance and geometry travel with it — and it
    writes every day in **one statement**, because a shift that stopped halfway
    would leave a route half slipped and half not. `check-route` asserts the
    window moves, the day before it does not, nothing past it does, and no
    Mapbox call is made.

13. **Access is granted to an identity, never to an email address.** Microsoft
    lets any tenant set a user's email attribute to anything and signs no
    `email_verified` claim, and this app accepts tokens from **any** tenant
    because every university is its own — so an address in a Microsoft token is
    a claim, not proof. `auth_identities` holds the `(provider, subject)` an
    owner actually approved; the address beside it is what the owner reads and
    where the daily mail goes. A Microsoft identity signing in for the first
    time is **not** signed in: a link goes to the address it claims, and
    clicking it is what binds them. Google binds directly, because its
    `email_verified` means something. `check-access` asserts that a second
    tenant claiming a bound address is a stranger.

14. **Which way in somebody uses is observed, not inferred.** Guessing from the
    domain's MX records was tried and does not survive this list: Cornell's mail
    is Microsoft's and its people sign in with Google, Mayo runs its own, and
    Harvard, Stanford and JPMorgan sit behind gateways that say nothing about
    who authenticates them. All three buttons are offered; `viewers.last_provider`
    records what worked so it can be offered first next time.

15. **The road ahead is one line, cut into a segment per night.** The geometry
    comes from `public/geojson/stage*-map.geojson` — the whole world route,
    already drawn by Mapbox as cycling, one LineString per stage. `TrackMap`
    finds his position on it and walks forward, cutting a slice between each
    day's town and the next. That is what gives a segment its date, and
    therefore what it says when clicked. Nothing before his position is drawn:
    he is not going to Venice any more and the plan's road through it should
    not still be there.

16. **A day John has edited replaces its slice.** `saveDay` routes an edit when
    he saves it and stores the line on the day; `upcomingRoute` carries that,
    and it wins over the plan's road for that night. So the red line reads as
    the plan except where he has changed his mind. It rides on
    `/api/track/history`, not the live feed, because it changes when he *edits*
    — which is why `version()` folds in `max(updated_at)` from `route_days`,
    wrapped, since a coarser token costs a stale road and a throw costs the
    whole feed.

## Testing

Every change to SQL or to a rule gets an assertion in `scripts/check-*.mjs`.
These are not unit tests: each one bundles the **real** handler or lib with its
database import swapped for PGlite — actual Postgres, so the planner and parser
are the ones Neon runs — and stubs outbound HTTP (Mapbox, Resend, Anthropic).
Both SQL bugs that ever reached production came from queries that compiled
fine, which is why the tests exercise the real module rather than a retyped
copy of the query.

Assert the rule, not only the answer. `check-feed` checks the *shape* of the
queries a poll runs, because a regression to full scans would still return
correct numbers.

## Schema

`ensureSchema` in `lib/db.mts` creates every table and index and applies every
`add column if not exists` at cold start. The files in
`netlify/database/migrations/` **are applied on deploy, and are checksummed** —
editing one that has already run fails the build with *"migration has been
modified after being applied"*, and the deploy stops. Corrections go in a new
numbered file, never as an edit to an old one. Put new schema in **both**: nobody has the connection string to
hand — it is injected by Netlify at runtime only — so a deploy has to heal its
own schema before the code that needs a column can ship.

## Environment

| Variable | Used for |
|---|---|
| `VITE_MAPBOX_TOKEN` | Maps in the browser, static maps in email, reverse geocoding the country |
| `DATABASE_URL` / `NETLIFY_DATABASE_URL` | Postgres. Injected at runtime; absent locally |
| `GOOGLE_CLIENT_ID`, `SESSION_SECRET` | Sign-in and the session cookie |
| `TRACK_OWNER_EMAILS` | Bootstrap owners — see rule 9 |
| `TRACK_TEST_DEVICES` | Devices whose fixes are test data; everything else is real |
| `RESEND_API_KEY`, `EMAIL_FROM` | The daily email |
| `EMAIL_PAUSED`, `EMAIL_SEND_FROM_HOUR`, `EMAIL_SEND_UNTIL_HOUR` | Hold or shift the send without a deploy |
| `ANTHROPIC_API_KEY` | Writing destination lines |
| `OWNTRACKS_*` | The phone posting fixes |

Netlify bakes these in at deploy time — changing one does nothing until a
rebuild. A stale `RESEND_API_KEY` reports "domain not verified", which reads
like a DNS problem and is not.

## Scheduled functions

`daily-email` runs hourly, `fact-warm` every three hours. **Netlify crons are
UTC**, whatever the machine you are testing from thinks. Scheduled functions get
about 30 seconds — the reason rule 5 exists.

## Deploying

Pushing `main` deploys production. Each deploy costs credits, so batch work
into one push rather than pushing per commit, and ask before pushing.
