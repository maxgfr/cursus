import './ui/global.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { openReplicaEarly } from './app/workspaceContext.tsx'

// The library loads while the first screen's code and language catalog do.
openReplicaEarly()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
