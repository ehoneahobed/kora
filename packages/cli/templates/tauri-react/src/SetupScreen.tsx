import { useState } from 'react'
import { Monitor, Wifi, ArrowRight, Loader2, AlertCircle } from 'lucide-react'
import { testConnection } from './sync-config'

interface SetupScreenProps {
  onConnect: (syncUrl: string) => void
  onSkip: () => void
}

/**
 * First-launch setup screen.
 *
 * Shown when no sync server URL is configured. The user enters their
 * organization's sync server URL, or skips to use the app in local-only mode.
 *
 * The connection test is advisory — if the server is unreachable (e.g.,
 * during maintenance), the user can still save the URL and the app will
 * connect when the server comes back.
 */
export function SetupScreen({ onConnect, onSkip }: SetupScreenProps) {
  const [url, setUrl] = useState('')
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const validateUrl = (value: string): string | null => {
    if (!value.startsWith('ws://') && !value.startsWith('wss://')) {
      return 'URL must start with ws:// or wss://'
    }
    try {
      new URL(value.replace(/^ws/, 'http'))
    } catch {
      return 'Invalid URL format'
    }
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const syncUrl = url.trim()
    if (!syncUrl) return

    const validationError = validateUrl(syncUrl)
    if (validationError) {
      setError(validationError)
      return
    }

    setTesting(true)
    setError(null)
    setUnreachable(false)

    const reachable = await testConnection(syncUrl)
    setTesting(false)

    if (reachable) {
      onConnect(syncUrl)
    } else {
      // Server unreachable — let the user save anyway
      setUnreachable(true)
    }
  }

  const handleSaveAnyway = () => {
    onConnect(url.trim())
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: '480px', width: '100%', padding: '0 24px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <Monitor style={{ width: '48px', height: '48px', color: '#818cf8', margin: '0 auto 16px' }} />
          <h1 style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '8px' }}>Welcome</h1>
          <p style={{ color: '#6b7280', fontSize: '15px' }}>
            Connect to your organization's sync server to sync data across devices.
          </p>
        </div>

        {/* Connection form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: '500', marginBottom: '8px', color: '#d1d5db' }}>
              Sync server URL
            </label>
            <div style={{ position: 'relative' }}>
              <Wifi style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', width: '18px', height: '18px', color: '#6b7280' }} />
              <input
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(null); setUnreachable(false) }}
                placeholder="wss://your-server.example.com/kora-sync"
                autoFocus
                style={{
                  width: '100%',
                  borderRadius: '8px',
                  border: `1px solid ${error ? '#ef4444' : '#374151'}`,
                  background: '#111827',
                  padding: '12px 16px 12px 40px',
                  color: '#f3f4f6',
                  outline: 'none',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {error && (
              <p style={{ color: '#ef4444', fontSize: '13px', marginTop: '8px' }}>{error}</p>
            )}
          </div>

          {/* Server unreachable — offer to save anyway */}
          {unreachable && (
            <div style={{
              marginBottom: '16px',
              padding: '12px 16px',
              borderRadius: '8px',
              border: '1px solid #92400e',
              background: '#451a03',
            }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <AlertCircle style={{ width: '16px', height: '16px', color: '#fbbf24', flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <p style={{ fontSize: '13px', color: '#fde68a', marginBottom: '8px' }}>
                    Server is not reachable right now. This could be temporary (maintenance, network issues).
                  </p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={handleSaveAnyway}
                      style={{
                        fontSize: '13px',
                        color: '#fbbf24',
                        background: 'none',
                        border: '1px solid #92400e',
                        borderRadius: '6px',
                        padding: '4px 12px',
                        cursor: 'pointer',
                      }}
                    >
                      Save anyway — connect later
                    </button>
                    <button
                      type="submit"
                      style={{
                        fontSize: '13px',
                        color: '#9ca3af',
                        background: 'none',
                        border: '1px solid #374151',
                        borderRadius: '6px',
                        padding: '4px 12px',
                        cursor: 'pointer',
                      }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!unreachable && (
            <button
              type="submit"
              disabled={testing || !url.trim()}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                borderRadius: '8px',
                background: '#4f46e5',
                padding: '12px 20px',
                fontWeight: '500',
                color: 'white',
                border: 'none',
                cursor: testing || !url.trim() ? 'default' : 'pointer',
                opacity: testing || !url.trim() ? 0.5 : 1,
                fontSize: '14px',
                marginBottom: '12px',
              }}
            >
              {testing ? (
                <>
                  <Loader2 style={{ width: '16px', height: '16px', animation: 'spin 1s linear infinite' }} />
                  Testing connection...
                </>
              ) : (
                <>
                  Connect
                  <ArrowRight style={{ width: '16px', height: '16px' }} />
                </>
              )}
            </button>
          )}
        </form>

        {/* Skip option */}
        <div style={{ textAlign: 'center', marginTop: '24px' }}>
          <button
            onClick={onSkip}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              cursor: 'pointer',
              fontSize: '14px',
              textDecoration: 'underline',
              textUnderlineOffset: '3px',
            }}
          >
            Skip — use offline only
          </button>
          <p style={{ color: '#374151', fontSize: '12px', marginTop: '8px' }}>
            You can connect to a sync server later from settings.
          </p>
        </div>

        {/* Help text */}
        <div style={{
          marginTop: '48px',
          padding: '16px',
          borderRadius: '8px',
          border: '1px solid #1f2937',
          background: '#111827',
        }}>
          <p style={{ fontSize: '13px', color: '#9ca3af', lineHeight: '1.6' }}>
            <strong style={{ color: '#d1d5db' }}>Don't have a server URL?</strong>
            <br />
            Ask your administrator for the sync server address. For local development,
            use <code style={{ color: '#818cf8' }}>ws://localhost:3001/kora-sync</code>.
          </p>
        </div>
      </div>
    </div>
  )
}
