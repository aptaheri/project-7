import { Link } from 'react-router-dom'
import HomeMap from '../components/HomeMap'
import FontToggle from '../components/FontToggle'
import './Home.scss'

export default function Home() {
  return (
    <div className="home">
      <HomeMap />
      <div className="home-overlay" />
      <div className="home-content">
        <h1>Project 7</h1>
        <p>The first human-powered journey across the 7 continents</p>
        <Link to="/map" className="home-cta">Explore the Map</Link>
      </div>
      <div className="home-font-toggle">
        <FontToggle />
      </div>
    </div>
  )
}
