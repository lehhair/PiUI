import { useEffect, useState } from 'react'
import { piFetch } from '../../pi/sessionApi'

export function useAuthenticatedObjectUrl(url: string | undefined, requiresAuth = false, enabled = true): string | undefined {
  const [objectUrl, setObjectUrl] = useState<string>()

  useEffect(() => {
    if (!url || !requiresAuth || !enabled) {
      setObjectUrl(undefined)
      return
    }
    const controller = new AbortController()
    let current: string | undefined
    void piFetch(url, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`image request failed: ${response.status}`)
        return response.blob()
      })
      .then(blob => {
        if (controller.signal.aborted) return
        current = URL.createObjectURL(blob)
        setObjectUrl(current)
      })
      .catch(() => {
        if (!controller.signal.aborted) setObjectUrl(undefined)
      })
    return () => {
      controller.abort()
      if (current) URL.revokeObjectURL(current)
    }
  }, [enabled, requiresAuth, url])

  return requiresAuth ? objectUrl : url
}

export function AuthenticatedImage({
  src,
  requiresAuth,
  ...props
}: Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string; requiresAuth?: boolean }) {
  const resolved = useAuthenticatedObjectUrl(src, requiresAuth)
  if (!resolved) return null
  return <img {...props} src={resolved} />
}
