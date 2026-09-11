import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Missing root element')
}

createRoot(container).render(
  <StrictMode>
    <main>Movie Harbor</main>
  </StrictMode>,
)
