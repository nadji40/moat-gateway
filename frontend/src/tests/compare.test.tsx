import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../app/App'

describe('native Compare page', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('renders the migrated comparison content with the shared layout', () => {
    window.history.replaceState({}, '', '/compare')
    render(<App />)

    expect(screen.getByRole('heading', { name: /It is not what they check/i })).toBeInTheDocument()
    expect(screen.getByText('Run against their own code.')).toBeInTheDocument()
    expect(screen.getByText('Moat helps AI agents make authorized payments by verifying every action against the user\'s intent.')).toBeInTheDocument()
    expect(document.querySelectorAll('footer.foot')).toHaveLength(1)
    expect(document.querySelectorAll('.fcols > *')).toHaveLength(4)
  })
})
