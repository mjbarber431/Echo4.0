import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PresentApp } from './Present'
import { StoreProvider } from './store'
import './styles.css'

// The presentation window loads this page too, with a bridge to its one document only.
if (window.echoPresent) {
  document.documentElement.classList.add('present')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PresentApp />
    </StrictMode>
  )
} else void window.echo.getState().then((state) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <StoreProvider initial={state}>
        <App />
      </StoreProvider>
    </StrictMode>
  )
})
