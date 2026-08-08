import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './components/Navbar'
import ErrorBoundary from './components/ErrorBoundary'
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
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/map" element={<MapView />} />
          <Route path="/about" element={<About />} />
          <Route path="/donate" element={<Donate />} />
          <Route path="/track" element={<Track />} />
          <Route path="/track/sharing" element={<Admin />} />
          {/* Former home of the sharing panel, kept so old links still land. */}
          <Route path="/7c-editor" element={<Navigate to="/track/sharing" replace />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  )
}
