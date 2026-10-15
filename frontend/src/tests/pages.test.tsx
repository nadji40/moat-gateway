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

  it('draws the team as a molecule: founder at the centre, four teams, ten people', () => {
    window.history.replaceState({}, '', '/team')
    render(<App />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/pay only what was asked/i)
    expect(document.querySelectorAll('.mol-node.center')).toHaveLength(1)
    expect([...document.querySelectorAll('.mol-node.team')].map((n) => n.getAttribute('aria-label')))
      .toEqual(['Engineering team', 'Research team', 'Data team', 'Security team'])
    expect(document.querySelectorAll('.mol-node.member')).toHaveLength(9)
    expect(document.querySelectorAll('.mol-edge')).toHaveLength(13)

    // Choosing a person shows who they are and lights their path.
    fireEvent.click(screen.getByRole('button', { name: 'Dhoha Boumediene, Policy data' }))
    expect(document.querySelector('.mol-card h3')).toHaveTextContent('Dhoha Boumediene')
    expect(document.querySelector('.mol-card .tm-role')).toHaveTextContent('Data team')
    expect(document.querySelectorAll('.mol-edge.on')).toHaveLength(2)

    // A given photo is used in the molecule and the list; everyone else
    // keeps a placeholder until theirs arrives.
    expect(document.querySelector('.mol-node.center image')).toHaveAttribute('href', '/team/nadji.jpg')
    expect(document.querySelectorAll('.tm-groups .tm-card')).toHaveLength(10)
    const photos = document.querySelectorAll('.tm-groups img.tm-pic').length
    const pending = document.querySelectorAll('.tm-groups .tm-initials[data-photo="pending"]').length
    expect(photos).toBeGreaterThan(0)
    expect(photos + pending).toBe(10)
    expect(document.querySelectorAll('.mol-node image')).toHaveLength(photos)
  })

})
