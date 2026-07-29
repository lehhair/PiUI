import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NextTurnQueue } from './ChatArea'

describe('NextTurnQueue', () => {
  it('renders queued follow-ups as user bubbles after a queue divider', () => {
    const { container, rerender } = render(
      <NextTurnQueue
        items={['Run the focused tests', 'Then summarize the failures']}
        maxWidthClass="max-w-2xl"
        paddingClass="px-5"
      />,
    )

    expect(container.querySelector('[data-next-turn-queue="true"]')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('2')
    expect(screen.getByText('Run the focused tests')).toBeInTheDocument()
    expect(screen.getByText('Then summarize the failures')).toBeInTheDocument()

    rerender(<NextTurnQueue items={[]} maxWidthClass="max-w-2xl" paddingClass="px-5" />)
    expect(container.querySelector('[data-next-turn-queue="true"]')).not.toBeInTheDocument()
  })
})
