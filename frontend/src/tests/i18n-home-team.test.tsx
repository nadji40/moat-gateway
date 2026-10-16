import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../app/App'

describe('the homepage and team page in Arabic', () => {
  beforeEach(() => localStorage.setItem('moat.lang', 'ar'))
  afterEach(() => {
    localStorage.removeItem('moat.lang')
    window.history.replaceState({}, '', '/')
  })

  it('shows the homepage and its footer in Arabic', () => {
    window.history.replaceState({}, '', '/')
    render(<App />)

    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('وكيلك لا يدفع')
    expect(h1).toHaveTextContent('ما طلبتَه')
    expect(screen.queryByText(/your agent pays only/i)).toBeNull()

    expect(screen.getByRole('heading', { name: 'ما الذي يتحقق منه' })).toBeInTheDocument()
    expect(screen.getAllByText('مرفوضة').length).toBeGreaterThan(0)

    const footer = document.querySelector('footer.foot')!
    expect(footer).toHaveTextContent('المنتج')
    expect(footer.querySelector('a[href="/team"]')).toHaveTextContent('من نحن')
    expect(footer.querySelector('a[href="/docs"]')).toHaveTextContent('التوثيق')
  })

  it('shows the team page in Arabic, names kept in Latin script', () => {
    window.history.replaceState({}, '', '/team')
    render(<App />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('عشرة أشخاص يريدون للوكلاء')
    expect(document.querySelector('.mol-card .tm-role')).toHaveTextContent('المؤسس')
    expect([...document.querySelectorAll('.mol-node.team')].map((n) => n.getAttribute('aria-label')))
      .toEqual(['فريق الهندسة', 'فريق البحث', 'فريق البيانات', 'فريق الأمن'])
    expect(screen.getByRole('button', { name: 'Dhoha Boumediene، بيانات السياسات' })).toBeInTheDocument()
    expect(screen.getAllByText('مهندسة واجهات أمامية').length).toBeGreaterThan(0)
    expect(document.querySelector('svg.mol')).toHaveStyle({ direction: 'ltr' })
  })
})
