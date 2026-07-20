import { useState, useEffect } from 'react'

export function useAssets() {
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Stub: will call GET /user/me/assets when Worker is wired
    setLoading(false)
  }, [])

  return { assets, loading, error, setAssets }
}
