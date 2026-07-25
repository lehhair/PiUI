import { useContext } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { SessionProvider } from './SessionContext'
import { SessionContext } from './SessionContext.shared'

vi.mock('../pi/sessionApi', () => ({
  isPiServerUp: vi.fn().mockResolvedValue(false),
  listPiSessions: vi.fn(),
  createPiSession: vi.fn(),
  deletePiSession: vi.fn(),
}))

vi.mock('./useDirectory', () => ({
  useDirectory: () => ({ currentDirectory: null }),
}))

describe('SessionProvider', () => {
  it('does not fall back to the legacy SDK when PiUI server is unavailable', async () => {
    const { result } = renderHook(() => useContext(SessionContext), { wrapper: SessionProvider })

    await waitFor(() => expect(result.current?.isLoading).toBe(false))
    expect(result.current?.sessions).toEqual([])
  })
})
