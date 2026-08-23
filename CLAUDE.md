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

6. **Hand-written facts beat generated ones**, always
   (`src/data/destination-facts.json`). Correcting a bad generated line means
   adding it there. A hand-written place still gets a *distance* sentence
   written for it — that is the second half of what the warmer stores, and the
   only way those mornings get one — but its fact is never regenerated.

7. **`FORMAT_VERSION` in `lib/fact.mts` is what makes a change to the brief
   take effect.** Rows below it are rewritten on the next warming run, and
   every place previously given up on is asked again. Without bumping it, a
   longer or differently-shaped line only ever appears for places nobody has
   warmed yet, and two shapes of email go out depending on when a place
   happened to come up.

8. **A row in `destination_facts` with a null `fact` is a record of having
   tried.** The model answering "nothing" is correct behaviour, not an error,
   but nothing was stored when it did, so the same village was re-asked every
   run forever. After `GIVE_UP_AFTER` refusals the warmer stops asking. The
   send treats a null fact exactly like no row at all.

9. **Bootstrap owners cannot be removed from the sharing page.** Every address
   in `TRACK_OWNER_EMAILS` is re-seeded as an owner on each load and re-promoted
   on each sign-in, so a delete succeeds and is undone a moment later. The API
   refuses with a 409 that says so; the row is tagged "Always owner".

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
`netlify/database/migrations/` mirror it for the record but are not applied
automatically. Put new schema in **both**: nobody has the connection string to
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
