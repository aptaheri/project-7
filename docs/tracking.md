# Live tracking

The phone runs [OwnTracks](https://owntracks.org) in HTTP mode and POSTs a
location fix to this site on an interval. Fixes are stored in Neon Postgres and
drawn on a private map at `/track`.

```
OwnTracks (iPhone)  ──POST──▶  /api/owntracks  ──▶  Neon (locations table)
                                                          │
                       browser  ◀──GET──  /api/track  ◀────┘
```

## Pieces

| Path | What it is |
| --- | --- |
| `netlify/functions/owntracks.mts` | Ingest. Basic auth, validates, inserts. |
| `netlify/functions/track-feed.mts` | Read. Token-gated, returns latest fix + trail. |
| `netlify/lib/db.mts` | Neon client, applies the schema on cold start. |
| `netlify/lib/auth.mts` | Constant-time secret comparison, Basic auth check. |
| `src/pages/Track.tsx` | The map page. Polls every 30s. |
| `db/schema.sql` | Table definition, for reference. |

## Environment variables

Set these in **Netlify → Site configuration → Environment variables**. All four
are required; the endpoints return 500 until they exist.

| Variable | What it is |
| --- | --- |
| `NETLIFY_DB_URL` | Injected at runtime by Netlify Database. Nothing to do. |
| `OWNTRACKS_USER` | Username the phone sends via Basic auth. |
| `OWNTRACKS_PASS` | Password the phone sends. Generate it, don't pick it. |
| `OWNTRACKS_VIEW_TOKEN` | Secret in the `/track?key=…` URL. |

If you're using a Neon project created outside Netlify, set `DATABASE_URL` to
its **pooled** connection string instead — it takes precedence when both exist.

Generate the two secrets with:

```sh
openssl rand -hex 24
```

`VITE_MAPBOX_TOKEN` is already set and is used by the map.

## Database setup

Netlify provisions the Postgres instance for you — there is no separate Neon
signup and nothing to paste. Two things have to be true:

1. The **Neon extension** is enabled for the team.
2. **`@netlify/database` is a dependency** and the site has been deployed.

The second one is what actually turns it on. The package is not imported
anywhere — its presence at deploy time is the trigger, and the connection
string arrives at runtime as `NETLIFY_DB_URL`. Removing the dependency
un-provisions the database.

Check the state with:

```sh
npx netlify-cli@latest db status
```

Note this is `NETLIFY_DB_URL`, not `NETLIFY_DATABASE_URL` — the longer name
appears in some docs and is wrong.

No migration step — the ingest function runs `create table if not exists` on
cold start. `db/schema.sql` is the same DDL if you'd rather apply it by hand.
Netlify also has its own migrations directory at `netlify/database/migrations`,
applied automatically on deploy, which is the better route for future schema
changes.

## Phone setup

OwnTracks → Settings → Connection:

- **Mode**: HTTP
- **URL**: `https://project7.bike/api/owntracks`
- **Authentication**: on, with `OWNTRACKS_USER` / `OWNTRACKS_PASS`
- **Device ID / Tracker ID**: anything short, e.g. `JD`

OwnTracks → Settings → Advanced:

- **Monitoring**: `Move` for live updates
- **locatorInterval**: `30` (seconds between fixes)
- **locatorDisplacement**: `0`

`Move` mode is the battery-hungry one. `Significant` reports far less often and
costs almost nothing — worth switching to on rest days.

Points recorded with no signal are queued on the phone and flushed when
coverage returns, so gaps fill in retroactively. The `(device, tst)` unique
constraint makes the replay idempotent.

## Viewing

```
https://project7.bike/track?key=<OWNTRACKS_VIEW_TOKEN>
```

The token is the only thing keeping this private — the page is not linked from
the nav, but the URL is a secret. To revoke access, change
`OWNTRACKS_VIEW_TOKEN` in Netlify and redeploy.

## Local development

Netlify Functions do not run under `npm run dev`. Use:

```sh
npm i -g netlify-cli
netlify dev
```

with the four variables in a local `.env` (already gitignored).

## Checking it end to end

```sh
# Should return [] and insert a row.
curl -u "$OWNTRACKS_USER:$OWNTRACKS_PASS" \
  -H 'content-type: application/json' \
  -d '{"_type":"location","lat":40.9886,"lon":-111.8878,"tst":1786000000,"tid":"JD","topic":"owntracks/test/iphone"}' \
  https://project7.bike/api/owntracks

# Should return that point.
curl "https://project7.bike/api/track?key=$OWNTRACKS_VIEW_TOKEN"
```

Delete test rows with `delete from locations where device = 'owntracks/test/iphone';`
