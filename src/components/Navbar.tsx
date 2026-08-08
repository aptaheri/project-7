import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import logoUrl from '../assets/logo.svg'
import { useAuth } from '../lib/auth'
import './Navbar.scss'

const NAV_LINKS = [
  { label: 'Map', to: '/map' },
  { label: 'About', to: '/about' },
  { label: 'Donate', to: '/donate' },
]

const TRACK_LINK = { label: 'Live map', to: '/track' }
const SHARING_LINK = { label: 'Sharing', to: '/track/sharing' }

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [trackOpen, setTrackOpen] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  const { me } = useAuth()
  // Sharing is owner-only, so it is not advertised to anyone else.
  const isOwner = me?.role === 'owner'
  const onTrack = location.pathname.startsWith('/track')

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

  // Close the Track dropdown on outside click or Escape
  useEffect(() => {
    if (!trackOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (!trackRef.current?.contains(e.target as Node)) setTrackOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTrackOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [trackOpen])

  // Navigating away should not leave the dropdown hanging open
  useEffect(() => setTrackOpen(false), [location.pathname])

  return (
    <>
      <header className={`navbar${scrolled ? ' navbar--scrolled' : ''}`}>
        <Link to="/" className="navbar-logo" onClick={() => setMenuOpen(false)}>
          <img src={logoUrl} className="navbar-logo-icon" alt="" />
          <span className="navbar-logo-text">Project 7</span>
        </Link>

        {/* Desktop nav */}
        <nav className="navbar-links">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => isActive ? 'navbar-link active' : 'navbar-link'}>
              {l.label}
            </NavLink>
          ))}

          <div className="navbar-dropdown" ref={trackRef}>
            <button
              type="button"
              className={`navbar-link navbar-dropdown-toggle${onTrack ? ' active' : ''}`}
              onClick={() => setTrackOpen((v) => !v)}
              aria-expanded={trackOpen}
              aria-haspopup="menu"
            >
              Track
              <svg className="navbar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {trackOpen && (
              <div className="navbar-dropdown-menu" role="menu">
                <NavLink to={TRACK_LINK.to} end className="navbar-dropdown-item" role="menuitem">
                  {TRACK_LINK.label}
                </NavLink>
                {isOwner && (
                  <NavLink to={SHARING_LINK.to} className="navbar-dropdown-item" role="menuitem">
                    {SHARING_LINK.label}
                  </NavLink>
                )}
              </div>
            )}
          </div>
        </nav>

        {/* Mobile hamburger */}
        <button
          className={`navbar-hamburger${menuOpen ? ' open' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        >
          <span />
          <span />
        </button>
      </header>

      {/* Mobile full-screen menu */}
      <div className={`mobile-menu${menuOpen ? ' mobile-menu--open' : ''}`}>
        <div className="mobile-menu-header">
          <Link to="/" className="navbar-logo" onClick={() => setMenuOpen(false)}>
            <img src={logoUrl} className="navbar-logo-icon" alt="" />
            <span className="navbar-logo-text">Project 7</span>
          </Link>
          <button className="mobile-menu-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            ✕
          </button>
        </div>

        <nav className="mobile-menu-links">
          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className="mobile-menu-link"
              onClick={() => setMenuOpen(false)}
            >
              <span>{l.label}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </NavLink>
          ))}

          <span className="mobile-menu-section">Track</span>
          {[TRACK_LINK, ...(isOwner ? [SHARING_LINK] : [])].map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === TRACK_LINK.to}
              className="mobile-menu-link mobile-menu-link--nested"
              onClick={() => setMenuOpen(false)}
            >
              <span>{l.label}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </NavLink>
          ))}
        </nav>
      </div>
    </>
  )
}
