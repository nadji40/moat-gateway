import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../i18n'

// jsdom cannot navigate, so the two ways of leaving the page are stood in for.
function stubLocation(href: string) {
  const reload = vi.fn()
  const replace = vi.fn()
  vi.stubGlobal('location', { href, reload, replace })
  return { reload, replace }
}

describe('switching language', () => {
  afterEach(() => localStorage.clear())

  it('reloads a page whose address has a # in it, which a replace would not', () => {
    const { reload, replace } = stubLocation('https://moat.test/dashboard#pane-keys')
    setLang('ar')
    expect(localStorage.getItem('moat.lang')).toBe('ar')
    expect(reload).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
  })

  it('reloads a plain page too', () => {
    const { reload } = stubLocation('https://moat.test/team')
    setLang('en')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('drops a ?lang= from the address, so the link cannot switch it back', () => {
    const { reload, replace } = stubLocation('https://moat.test/docs?lang=ar#policy')
    setLang('en')
    expect(reload).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith('https://moat.test/docs#policy')
  })
})
