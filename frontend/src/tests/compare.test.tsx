
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Navbar from '../components/layout/Navbar'
import Compare from '../pages/Compare/Compare'

describe('native Compare page', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('renders the migrated comparison content with the shared layout', async () => {
    window.history.replaceState({}, '', '/compare')

    render(
      <>
        <Navbar />
        <Compare />
      </>
    )

    // Verify the Compare page heading.
    expect(
      await screen.findByRole('heading', {
        name: /It is not what\s+they check/i,
      }),
    ).toBeInTheDocument()

    // Verify the evidence section heading.
    expect(
      screen.getByRole('heading', {
        name: /run against their own code/i,
      }),
    ).toBeInTheDocument()

    // Verify the evidence section exists.
    expect(
      document.querySelector('section#tested'),
    ).toBeInTheDocument()

    // Verify the shared footer structure.
    expect(
      document.querySelectorAll('footer.foot'),
    ).toHaveLength(1)

    expect(
      document.querySelectorAll('.fcols > *'),
    ).toHaveLength(4)
  })
})
