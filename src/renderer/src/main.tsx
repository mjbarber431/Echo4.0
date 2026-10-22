import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { StoreProvider } from './store'
import './styles.css'

void window.echo.getState().then((state) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <StoreProvider initial={state}>
        <App />
      </StoreProvider>
    </StrictMode>
  )
})
