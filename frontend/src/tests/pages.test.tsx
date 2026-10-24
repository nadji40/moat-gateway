import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'

describe('documentation and team pages', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('renders the documentation with every section reachable from its list', async () => {
    window.history.replaceState({}, '', '/docs')
    render(<App />)

    expect(await screen.findByRole('heading', { level: 1, name: /from first call to production/i })).toBeInTheDocument()
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

  it('lays the team out as the deck does: two rows of five, the founder larger in the middle', async () => {
    window.history.replaceState({}, '', '/team')
    render(<App />)

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/an algerian team with a global dream/i)

    const tiles = [...document.querySelectorAll('.tm-deck .tm-tile')]
    expect(tiles).toHaveLength(10)
    // The founder is the third tile: the middle of the first row of five.
    expect(tiles[2]).toHaveClass('founder')
    expect(tiles[2]!.querySelector('img')).toHaveAttribute('src', '/team/deck/nadji.jpg')
    expect(tiles[2]!.querySelector('.tm-role')).toHaveTextContent(/founder/i)
    expect(document.querySelectorAll('.tm-tile.founder')).toHaveLength(1)

    // Everyone has a portrait on the deck's notched tile, and a name whose
    // given name is the warm word.
    expect(document.querySelectorAll('.tm-tile .tm-photo.gl-notch img')).toHaveLength(10)
    const names = tiles.map((t) => t.querySelector('.tm-name')?.textContent)
    expect(names).toContain('Dhoha Boumediene')
    expect(names).toContain('Redwan Benmoussa')
    expect(tiles.find((t) => t.textContent?.includes('Dhoha'))!.querySelector('.tm-name b')).toHaveTextContent('Dhoha')
    expect(tiles.find((t) => t.textContent?.includes('Dhoha'))!.querySelector('.tm-role')).toHaveTextContent('Policy data')

    // The three facts stay under the people.
    expect(document.querySelectorAll('.tm-how .tm-fact')).toHaveLength(3)
  })

})
