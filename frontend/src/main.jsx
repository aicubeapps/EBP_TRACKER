import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { AppThemeProvider } from './context/ThemeContext'
import App from './App.jsx'
import './index.css'

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || 'pk_test_placeholder'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={CLERK_KEY}>
      <AppThemeProvider>
        <App />
      </AppThemeProvider>
    </ClerkProvider>
  </React.StrictMode>
)
