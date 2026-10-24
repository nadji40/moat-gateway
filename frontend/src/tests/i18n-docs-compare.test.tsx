
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Docs from '../pages/Docs/Docs'
import Compare from '../pages/Compare/Compare'

describe('documentation and compare pages in Arabic', () => {
  beforeEach(() => {
    localStorage.setItem('moat.lang', 'ar')
  })

  afterEach(() => {
    localStorage.removeItem('moat.lang')
    window.history.replaceState({}, '', '/')
  })

  it('renders the documentation in Arabic, with code left as it is', async () => {
    window.history.replaceState({}, '', '/docs')
    render(<Docs />)

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Moat، من أول طلب إلى الإنتاج',
      }),
    ).toBeInTheDocument()

    expect(
      screen.queryByText(/from first call to production/i),
    ).not.toBeInTheDocument()

    const labels = [
      ...document.querySelectorAll('.docs-nav a'),
    ].map((a) => a.textContent)

    expect(labels).toContain('البدء السريع')
    expect(labels).toContain('مرجع السياسة')

    expect(
      document.querySelector('#quickstart pre')!.textContent,
    ).toContain('/v1/sandbox')

    expect(
      document.querySelector('#quickstart .chip'),
    ).toHaveTextContent('نسخ')

    // Identifiers remain unchanged in policy tables.
    expect(
      document.querySelector('#rules .tbl td code'),
    ).toHaveTextContent('payee-provenance')
  })

  it('renders the compare page in Arabic', async () => {
    window.history.replaceState({}, '', '/compare')
    render(<Compare />)

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /ليست المسألة\s*ما يفحصونه/,
      }),
    ).toBeInTheDocument()

    expect(
      screen.getByText('شُغّلت على شيفرتها نفسها'),
    ).toBeInTheDocument()

    expect(
      screen.queryByText('Run against their own code'),
    ).not.toBeInTheDocument()

    expect(
  document.querySelector('section#tested'),
).toBeInTheDocument()

expect(
  screen.getByRole('heading', {
    name: 'شُغّلت على شيفرتها نفسها',
  }),
).toBeInTheDocument()
  })
})
