import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ContentBlock } from './ContentBlock'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('./CodePreview', () => ({
  CodePreview: ({ code, layoutVersion }: { code: string; layoutVersion?: number }) => (
    <pre data-testid="code-preview" data-layout-version={layoutVersion}>
      {code}
    </pre>
  ),
}))

vi.mock('../contexts', () => ({
  useFullscreenLayer: () => ({ isOpen: false, open: vi.fn() }),
}))

describe('ContentBlock', () => {
  it('remeasures expanded content after its layout transition without paint containment', () => {
    const { container } = render(
      <ContentBlock label="Output" content="tool output" defaultCollapsed stateKey="content-block-transition-test" />,
    )

    const block = screen.getByText('Output').closest('.rounded-md')
    expect(block).not.toHaveClass('contain-content')

    fireEvent.click(screen.getByText('Output'))
    expect(screen.getByTestId('code-preview')).toHaveAttribute('data-layout-version', '0')

    const body = container.querySelector('[data-content-block-body]')
    expect(body).not.toBeNull()
    fireEvent.transitionEnd(body!)

    expect(screen.getByTestId('code-preview')).toHaveAttribute('data-layout-version', '1')
  })
})
