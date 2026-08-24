import React from 'react'
import { createRoot } from 'react-dom/client'
import { DialRoot } from 'dialkit'
import 'dialkit/styles.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <DialRoot position="top-right" productionEnabled />
  </React.StrictMode>
)
