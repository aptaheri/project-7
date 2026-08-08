import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import Home from './pages/Home'
import MapView from './MapView'
import About from './pages/About'
import Donate from './pages/Donate'
import Admin from './pages/Admin'
import Track from './pages/Track'
import './App.scss'

export default function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/map" element={<MapView />} />
        <Route path="/about" element={<About />} />
        <Route path="/donate" element={<Donate />} />
        <Route path="/7c-editor" element={<Admin />} />
        <Route path="/track" element={<Track />} />
      </Routes>
    </BrowserRouter>
  )
}
