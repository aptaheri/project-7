import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import Home from './pages/Home'
import MapView from './MapView'
import Admin from './pages/Admin'
import './App.scss'

export default function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/map" element={<MapView />} />
        <Route path="/7c-editor" element={<Admin />} />
      </Routes>
    </BrowserRouter>
  )
}
