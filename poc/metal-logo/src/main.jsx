import React from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { DialRoot } from 'dialkit'
import 'dialkit/styles.css'
import './dialkit-skin.css'
import App from './App.jsx'

// DialKit renders inline, inside the shared settings sheet index.html already
// put on the page — so the panel is the sheet's content rather than a second
// floating window of its own. Popover mode would fight it for the corner and
// bring its own drag, collapse bubble and shadow.
function Settings() {
  const mount = document.getElementById('dial-mount')
  if (!mount) return null
  // theme="dark" pins DialKit to one of its own palettes. dialkit-skin.css
  // repaints nearly all of it from the site's tokens, but not quite all —
  // and the default, "system", makes whatever is left follow the OS. The
  // panel would then go light while the page stayed in night. Pinned, it
  // follows the site theme and nothing else.
  return createPortal(<DialRoot mode="inline" theme="dark" productionEnabled />, mount)
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <Settings />
  </React.StrictMode>
)
