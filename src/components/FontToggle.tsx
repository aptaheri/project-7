import { useState } from 'react'
import './FontToggle.scss'

const FONTS = [
  { id: 'tt-norms',  label: 'TT Norms Pro' },
  { id: 'inter',     label: 'Inter'         },
  { id: 'nunito',    label: 'Nunito Sans'   },
] as const

type FontId = typeof FONTS[number]['id']

const STACKS: Record<FontId, string> = {
  'tt-norms': "'TT Norms Pro', system-ui, sans-serif",
  'inter':    "'Inter', system-ui, sans-serif",
  'nunito':   "'Nunito Sans', system-ui, sans-serif",
}

function getSaved(): FontId {
  const v = localStorage.getItem('p7-font')
  return (FONTS.find((f) => f.id === v)?.id ?? 'tt-norms') as FontId
}

function applyFont(id: FontId) {
  document.documentElement.style.setProperty('--font-sans', STACKS[id])
  localStorage.setItem('p7-font', id)
}

export default function FontToggle() {
  const [active, setActive] = useState<FontId>(getSaved)

  function select(id: FontId) {
    setActive(id)
    applyFont(id)
  }

  return (
    <div className="font-toggle">
      <span className="font-toggle-label">Font</span>
      {FONTS.map((f) => (
        <button
          key={f.id}
          className={`font-toggle-btn${active === f.id ? ' active' : ''}`}
          onClick={() => select(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}
