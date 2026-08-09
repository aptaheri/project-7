import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import logoUrl from '../assets/logo.svg'
import { signOut, useAuth, refreshMe } from '../lib/auth'
import type { Me } from '../lib/auth'
import './Navbar.scss'

const NAV_LINKS = [
  { label: 'About', to: '/about' },
  { label: 'Donate', to: '/donate' },
]

interface MapItem {
  label: string
  to: string
  enabled: boolean
  /** Shown as a tooltip on a disabled item, so the reason is never a mystery. */
  reason?: string
}

/**
 * Destinations a visitor could reach by gaining access are listed but disabled,
 * so the site does not silently change shape. Sharing is different: it is
 * owner-only administration that would never become available to a viewer, so
 * advertising it just raises a question with no answer.
 */
function mapItems(me: Me | null): MapItem[] {
  const authed = me?.authenticated === true
  const role = me?.role
  const canView = me?.canView === true
  const isOwner = role === 'owner'

  const locked = !authed
    ? 'Sign in to view'
    : role === 'pending'
      ? 'Awaiting owner approval'
      : undefined

  return [
    { label: 'Route', to: '/map', enabled: true },
    {
      label: 'Live',
      to: '/track',
      enabled: canView,
      reason: locked ?? 'Viewer access required',
    },
    ...(isOwner ? [{ label: 'Sharing', to: '/track/sharing', enabled: true }] : []),
  ]
}

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const mapRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  const { me } = useAuth()
  const authed = me?.authenticated === true
  const items = mapItems(me)
  const onMapSection =
    location.pathname.startsWith('/map') || location.pathname.startsWith('/track')

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

  // Close the Map dropdown on outside click or Escape
  useEffect(() => {
    if (!mapOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (!mapRef.current?.contains(e.target as Node)) setMapOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMapOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [mapOpen])

  useEffect(() => setMapOpen(false), [location.pathname])

  function handleSignOut() {
    setMenuOpen(false)
    setMapOpen(false)
    signOut().finally(refreshMe)
  }

  function renderItem(item: MapItem, className: string) {
    if (!item.enabled) {
      return (
        <span
          key={item.to}
          className={`${className} ${className}--disabled`}
          aria-disabled="true"
          title={item.reason}
        >
          <span>{item.label}</span>
          {item.reason && <span className="navbar-item-reason">{item.reason}</span>}
        </span>
      )
    }
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to === '/track'}
        className={className}
        onClick={() => { setMenuOpen(false); setMapOpen(false) }}
      >
        <span>{item.label}</span>
      </NavLink>
    )
  }

  return (
    <>
      <header className={`navbar${scrolled ? ' navbar--scrolled' : ''}`}>
        <Link to="/" className="navbar-logo" onClick={() => setMenuOpen(false)}>
          <img src={logoUrl} className="navbar-logo-icon" alt="" />
          <span className="navbar-logo-text">Project 7</span>
        </Link>

        {/* Desktop nav */}
        <nav className="navbar-links">
          <div className="navbar-dropdown" ref={mapRef}>
            <button
              type="button"
              className={`navbar-link navbar-dropdown-toggle${onMapSection ? ' active' : ''}`}
              onClick={() => setMapOpen((v) => !v)}
              aria-expanded={mapOpen}
              aria-haspopup="menu"
            >
              Map
              <svg className="navbar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {mapOpen && (
              <div className="navbar-dropdown-menu" role="menu">
                {items.map((item) => renderItem(item, 'navbar-dropdown-item'))}
              </div>
            )}
          </div>

          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => isActive ? 'navbar-link active' : 'navbar-link'}>
              {l.label}
            </NavLink>
          ))}

          {authed ? (
            <button type="button" className="navbar-auth" onClick={handleSignOut} title={me?.email}>
              Sign out
            </button>
          ) : (
            <Link to="/track" className="navbar-auth">
              Log in
            </Link>
          )}
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
          <span className="mobile-menu-section">Map</span>
          {items.map((item) => renderItem(item, 'mobile-menu-link'))}

          {NAV_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className="mobile-menu-link"
              onClick={() => setMenuOpen(false)}
            >
              <span>{l.label}</span>
            </NavLink>
          ))}

          <div className="mobile-menu-auth">
            {authed ? (
              <>
                <span className="mobile-menu-email">{me?.email}</span>
                <button type="button" className="navbar-auth" onClick={handleSignOut}>
                  Sign out
                </button>
              </>
            ) : (
              <Link
                to="/track"
                className="navbar-auth"
                onClick={() => setMenuOpen(false)}
              >
                Log in
              </Link>
            )}
          </div>
        </nav>
      </div>
    </>
  )
}
