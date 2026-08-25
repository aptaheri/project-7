import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { GeocodeError, searchPlaces } from '../lib/geocode'
import type { Place } from '../lib/geocode'
import './RouteEditor.scss'

/**
 * Where John changes his own route, from the road.
 *
 * Written for the state he is actually in when he uses it: end of a long day,
 * on a phone, in a village, tired. So it is not a table of 467 editable rows —
 * it is today and the days around it, and the two things he ever needs to say
 * are the two buttons at the top of each card: he stopped somewhere else, or
 * tomorrow he is going somewhere else.
 *
 * The distance fills itself in from the cycling route between the two towns, so
 * that "how far was that?" is a question he can ignore rather than estimate.
 * When he does type a number it wins — for Chanac to Aubenas the roads say 71
 * miles and he rode 78, because he does not ride the route an API would pick.
 */

interface Day {
  day: number
  date: string
  kind: 'ride' | 'rest' | 'travel' | 'other'
  from: string | null
  to: string | null
  miles: number | null
  note: string
  fromCoords: [number, number] | null
  toCoords: [number, number] | null
  needsReview: boolean
  cyclingMiles?: number | null
  edited?: boolean
  editedBy?: string | null
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

function label(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export default function RouteEditor() {
  const { me, loading: authLoading } = useAuth()
  const isOwner = me?.role === 'owner'
  const [days, setDays] = useState<Day[]>([])
  const [today, setToday] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The day being edited, and what is being typed into it.
  const [editing, setEditing] = useState<string | null>(null)
  const [place, setPlace] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [chosen, setChosen] = useState<Place | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [miles, setMiles] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/route')
      if (!response.ok) throw new Error(response.status === 403 ? 'Owners only.' : 'Could not load the route.')
      const body = (await response.json()) as { today: string; days: Day[] }
      setDays(body.days)
      setToday(body.today)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the route.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOwner) void load()
  }, [isOwner, load])

  // Typing a town looks it up, a moment after he stops typing.
  useEffect(() => {
    if (!editing || place.trim().length < 2) {
      setResults([])
      return
    }
    const day = days.find((d) => d.date === editing)
    const timer = setTimeout(() => {
      searchPlaces(place, day?.fromCoords ?? day?.toCoords ?? null, MAPBOX_TOKEN)
        .then((found) => {
          setResults(found)
          setSearchError(found.length === 0 ? `No town found matching "${place}".` : null)
        })
        .catch((e: unknown) => {
          setResults([])
          // Said out loud rather than swallowed. An empty list and a broken
          // lookup look identical to somebody typing, and only one of them is
          // something they can do anything about.
          setSearchError(
            e instanceof GeocodeError ? e.message : 'Place search is not responding.',
          )
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [place, editing, days])

  function begin(day: Day) {
    setEditing(day.date)
    setSearchError(null)
    setPlace(day.to ?? '')
    setChosen(null)
    setResults([])
    setMiles(day.miles !== null ? String(day.miles) : '')
    setNote(day.note ?? '')
  }

  function cancel() {
    setEditing(null)
    setChosen(null)
    setResults([])
    setSearchError(null)
  }

  async function save(day: Day, kind: Day['kind'], rechain: boolean) {
    setSaving(true)
    try {
      // What he typed, resolved to somewhere real. Previously this fell back to
      // the day's existing destination whenever no suggestion had been tapped,
      // so typing a new town and pressing Save changed the mileage and silently
      // kept the old destination — which is exactly what happened to John on
      // the 26th: 76 miles saved, Chambéry stayed.
      let destination = chosen
      const typed = place.trim()
      if (!destination && typed && typed !== (day.to ?? '')) {
        const found = await searchPlaces(
          typed,
          day.fromCoords ?? day.toCoords ?? null,
          MAPBOX_TOKEN,
        ).catch(() => [])
        if (found.length === 0) {
          throw new Error(
            `Couldn't find "${typed}". Check the spelling, or try the nearest larger town.`,
          )
        }
        destination = found[0]
      }

      const response = await fetch('/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          date: day.date,
          kind,
          from: day.from,
          fromCoords: day.fromCoords,
          // Name and coordinates always move together. Saving a new name
          // against the old coordinates would put him on the map in a town he
          // is not riding to, which is worse than not saving at all.
          to: destination ? destination.name : day.to,
          toCoords: destination ? destination.coords : day.toCoords,
          // Blank asks for the cycling distance rather than storing nothing.
          miles: miles.trim() === '' ? null : Number(miles),
          note,
          needsReview: false,
          rechain,
        }),
      })
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error ?? 'Could not save.')
      }
      cancel()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  if (authLoading) return <main className="route-editor"><p className="muted">Loading…</p></main>
  if (!isOwner) {
    return (
      <main className="route-editor">
        <h1>The route</h1>
        <p className="muted">Only owners can change the route.</p>
        <Link to="/track" className="back">← Back to the tracker</Link>
      </main>
    )
  }
  if (loading) return <main className="route-editor"><p className="muted">Loading…</p></main>

  return (
    <main className="route-editor">
      <header>
        <h1>The route</h1>
        <p className="muted">
          Change where a day ends and everything follows — the map, tomorrow's email, the
          tracker. Leave the distance blank and it is taken from the cycling route between
          the two towns.
        </p>
        <Link to="/track" className="back">← Back to the tracker</Link>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <ol className="days">
        {days.map((day) => {
          const isToday = day.date === today
          const isPast = day.date < today
          const open = editing === day.date

          return (
            <li key={day.date} className={[
              'day',
              isToday ? 'is-today' : '',
              isPast ? 'is-past' : '',
              day.edited ? 'is-edited' : '',
              day.needsReview ? 'needs-review' : '',
            ].filter(Boolean).join(' ')}>
              <div className="when">
                <span className="date">{label(day.date)}</span>
                {isToday && <span className="tag today">Today</span>}
                {day.kind === 'rest' && <span className="tag rest">Rest</span>}
                {day.edited && <span className="tag edited">Changed</span>}
                {day.needsReview && <span className="tag review">Needs a destination</span>}
              </div>

              <div className="leg">
                <span className="from">{day.from ?? '—'}</span>
                <span className="arrow">→</span>
                <span className="to">{day.to ?? '—'}</span>
                <span className="miles">
                  {day.miles !== null ? `${day.miles} mi` : 'distance unknown'}
                </span>
              </div>

              {!open && (
                <div className="actions">
                  <button type="button" onClick={() => begin(day)}>
                    {isPast || isToday ? 'I stopped somewhere else' : 'Change where I am going'}
                  </button>
                </div>
              )}

              {open && (
                <div className="edit">
                  <label>
                    <span>Where the day ends</span>
                    <input
                      value={place}
                      onChange={(e) => { setPlace(e.target.value); setChosen(null) }}
                      placeholder="Type a town…"
                      autoFocus
                    />
                  </label>

                  {results.length > 0 && !chosen && (
                    <ul className="results">
                      {results.map((r) => (
                        <li key={`${r.name}-${r.coords.join(',')}`}>
                          <button type="button" onClick={() => { setChosen(r); setPlace(r.name); setResults([]) }}>
                            <strong>{r.name}</strong>
                            <span>{r.context}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {chosen && <p className="chosen">{chosen.context}</p>}
                  {searchError && !chosen && <p className="search-error">{searchError}</p>}
                  {!chosen && !searchError && place.trim() && place.trim() !== (day.to ?? '') && (
                    <p className="chosen">
                      Pick a town from the list, or press Save and it will be looked up.
                    </p>
                  )}

                  <label>
                    <span>Miles <em>— leave blank to use the cycling route</em></span>
                    <input
                      value={miles}
                      onChange={(e) => setMiles(e.target.value)}
                      inputMode="decimal"
                      placeholder={day.cyclingMiles ? `about ${Math.round(day.cyclingMiles)}` : 'auto'}
                    />
                  </label>

                  <label>
                    <span>Note <em>— optional, shown to nobody but you</em></span>
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth remembering" />
                  </label>

                  <div className="edit-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={saving}
                      onClick={() => void save(day, day.kind === 'rest' ? 'rest' : 'ride', true)}
                    >
                      {saving ? 'Saving…' : 'Save, and start tomorrow here'}
                    </button>
                    <button type="button" disabled={saving} onClick={() => void save(day, day.kind === 'rest' ? 'rest' : 'ride', false)}>
                      Save this day only
                    </button>
                    <button type="button" className="ghost" disabled={saving} onClick={cancel}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </main>
  )
}
