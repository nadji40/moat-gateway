import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Snapshot = { file: string; origin: string; sha256: string }
const snapshots: Snapshot[] = JSON.parse(readFileSync(
  resolve('src/tests/fixtures/provenance.json'), 'utf8',
))

describe('pinned upstream assets and approved fixture', () => {
  it.each(snapshots)('$file matches the documented immutable snapshot of $origin', ({ file, sha256 }) => {
    expect(createHash('sha256').update(readFileSync(resolve(file))).digest('hex')).toBe(sha256)
  })
})

describe('unchanged shared navigation behavior', () => {
  afterEach(() => {
    document.body.replaceChildren()
    localStorage.clear()
  })

  it.each([false, true])('preserves the signed-in state (%s), destinations and mobile menu', signedIn => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }))
    document.body.innerHTML = '<nav aria-label="Main"></nav>'
    if (signedIn) localStorage.setItem('moat.admin', 'frontend-test-only')
    // Execute the unmodified classic script in the DOM test environment.
    new Function(readFileSync(resolve('public/shared/app.js'), 'utf8'))()

    expect(document.querySelector('#auth')?.textContent).toBe(signedIn ? 'Dashboard' : 'Log in')
    expect(document.querySelector('#auth')?.getAttribute('href')).toBe('/dashboard')
    expect([...document.querySelectorAll('#navlinks a')].map(a => a.getAttribute('href')))
      .toEqual(['/docs', '/compare', '/tests', '/status', '/team'])
    const toggle = document.querySelector<HTMLButtonElement>('#navtoggle')!
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    toggle.click()
    // A hash link: jsdom cannot navigate to another page, and the point is
    // only that choosing a link closes the menu.
    const link = document.querySelector<HTMLAnchorElement>('#navlinks a')!
    link.setAttribute('href', '#top')
    link.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})
