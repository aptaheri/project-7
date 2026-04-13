import { useEffect, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import './Navbar.scss'

const NAV_LINKS = [
  { label: 'Map', to: '/map' },
  { label: 'About', to: '/about' },
  { label: 'Contact', to: '/contact' },
]

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

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

  return (
    <>
      <header className={`navbar${scrolled ? ' navbar--scrolled' : ''}`}>
        <Link to="/" className="navbar-logo" onClick={() => setMenuOpen(false)}>
          {/* Placeholder logo mark */}
          <svg className="navbar-logo-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" />
            <path d="M10 22 L16 10 L22 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 18 H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="navbar-logo-text">Project 7</span>
        </Link>

        {/* Desktop nav */}
        <nav className="navbar-links">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => isActive ? 'navbar-link active' : 'navbar-link'}>
              {l.label}
            </NavLink>
          ))}
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
            <svg className="navbar-logo-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" />
              <path d="M10 22 L16 10 L22 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 18 H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
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
        </nav>
      </div>
    </>
  )
}
