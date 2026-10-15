import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'

describe('documentation and team pages', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('renders the documentation with every section reachable from its list', () => {
    window.history.replaceState({}, '', '/docs')
    render(<App />)

    expect(screen.getByRole('heading', { level: 1, name: /from first call to production/i })).toBeInTheDocument()
    const listed = [...document.querySelectorAll('.docs-nav a')].map((a) => a.getAttribute('href')!.slice(1))
    const present = [...document.querySelectorAll('.docs-body section')].map((s) => s.id)
    expect(listed).toEqual(present)
    expect(listed).toContain('quickstart')
    expect(listed).toContain('policy')
    expect(document.querySelector('#quickstart pre')!.textContent).toContain('/v1/sandbox')
    expect(document.querySelectorAll('footer.foot')).toHaveLength(1)
  })

  it('copies a documentation code block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    window.history.replaceState({}, '', '/docs')
    render(<App />)

    const button = document.querySelector<HTMLButtonElement>('#quickstart .chip')!
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveTextContent('Copied'))
    expect(writeText).toHaveBeenCalledWith(document.querySelector('#quickstart pre')!.textContent)
  })

  it('renders every team member with a placeholder until a photo is given', () => {
    window.history.replaceState({}, '', '/team')
    render(<App />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/pay only what was asked/i)
    const cards = document.querySelectorAll('.tm-card')
    expect(cards).toHaveLength(10)
    expect(document.querySelectorAll('.tm-initials[data-photo="pending"]')).toHaveLength(10)
    expect(screen.getByText('Nadji Sabri')).toBeInTheDocument()
    expect(screen.getByText('Adam Belkadi')).toBeInTheDocument()
  })
})
