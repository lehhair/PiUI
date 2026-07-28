import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatedImage } from './AuthenticatedImage'

const piFetch = vi.hoisted(() => vi.fn())
vi.mock('../../pi/sessionApi', () => ({ piFetch }))

describe('AuthenticatedImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:authenticated-image'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('loads protected images through the authenticated Pi transport', async () => {
    piFetch.mockResolvedValue(new Response(new Blob(['image']), { status: 200 }))
    render(<AuthenticatedImage src="/api/protected-image" requiresAuth alt="result" />)

    await waitFor(() => expect(screen.getByAltText('result')).toHaveAttribute('src', 'blob:authenticated-image'))
    expect(piFetch).toHaveBeenCalledWith('/api/protected-image', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})
