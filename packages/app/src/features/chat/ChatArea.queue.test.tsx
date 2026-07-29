import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QueuedUserMessageQueue } from './ChatArea'

describe('QueuedUserMessageQueue', () => {
  it('renders current-turn and next-turn queues as separate user bubble groups', () => {
    const { container, rerender } = render(
      <>
        <QueuedUserMessageQueue
          kind="current"
          items={['Correct the parser']}
          maxWidthClass="max-w-2xl"
          paddingClass="px-5"
        />
        <QueuedUserMessageQueue
          kind="next"
          items={['Run the focused tests', 'Then summarize the failures']}
          maxWidthClass="max-w-2xl"
          paddingClass="px-5"
        />
      </>,
    )

    expect(container.querySelector('[data-message-queue="current"]')).toBeInTheDocument()
    expect(container.querySelector('[data-message-queue="next"]')).toBeInTheDocument()
    expect(screen.getByText('Correct the parser')).toBeInTheDocument()
    expect(screen.getByText('Run the focused tests')).toBeInTheDocument()
    expect(screen.getByText('Then summarize the failures')).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(2)

    rerender(
      <QueuedUserMessageQueue kind="current" items={[]} maxWidthClass="max-w-2xl" paddingClass="px-5" />,
    )
    expect(container.querySelector('[data-message-queue]')).not.toBeInTheDocument()
  })
})
