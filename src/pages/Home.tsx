import { Link } from 'react-router-dom'
import HomeMap from '../components/HomeMap'
import CurrentCountry from '../components/CurrentCountry'
import './Home.scss'

export default function Home() {
  return (
    <div className="home">
      <HomeMap />
      <div className="home-overlay" />
      <CurrentCountry />
      <div className="home-content">
        <p>The first human-powered journey<br />across the 7 continents</p>
        <Link to="/map" className="home-cta">Explore the Map</Link>
      </div>
    </div>
  )
}
