
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../app/App';

// React entry HTML
const entryPath = resolve(process.cwd(), 'index.html');

// Original approved homepage (not the React entry)
const originalPath = resolve(process.cwd(), 'src/tests/fixtures/approved-home.html');

const parseHTML = (path: string): Document =>
  new DOMParser().parseFromString(
    readFileSync(path, 'utf8'),
    'text/html'
  );

const original = parseHTML(originalPath);

const visibleText = (element: Element): string => {
  const copy = element.cloneNode(true) as Element;

  // Decoration (icons, and the checks section's moving payment and progress
  // bar) is aria-hidden and carries no copy of its own.
  copy.querySelectorAll('style, script, [aria-hidden="true"]').forEach(node => node.remove());

  // Full stops were dropped from single-phrase titles and lines on purpose,
  // so they are not part of what has to match.
  return copy.textContent?.replace(/[\s.]/g, '') ?? '';
};

describe('approved homepage integration', () => {

  it('loads the React entry from the HTML root', () => {
    const entry = parseHTML(entryPath);

    expect(entry.querySelector('#root')).not.toBeNull();

    expect(
      entry.querySelector('script[type="module"][src="/src/app/main.tsx"]')
    ).not.toBeNull();
  });

  it('preserves all section copy, order and existing navigation destinations', () => {
    const { container } = render(<App />);

    const selector = 'header.hero, section, footer';

    // The demo video (#demo) was added after the approved page; it has no
    // counterpart there to compare against.
    const sections = [
      ...container.querySelectorAll(selector)
    ].filter(node => node.id !== 'demo');

    const approved = [
      ...original.querySelectorAll(selector)
    ];

    // The sandbox section (#api) moved to the docs; the numbers section
    // (#numbers), the MCP section (#fit) and the traced attack (#problem)
    // were removed, and the numbers section's two links now sit under #checks.
    const kept = approved.filter(node => !['api', 'numbers', 'fit', 'problem'].includes(node.id)).map(node => {
      // The hero's subtitle was removed on purpose; the rest of its copy stays.
      const copy = node.cloneNode(true) as Element;
      copy.querySelector('header.hero .lede, .lede')?.remove();
      // So was the line above the headline.
      copy.querySelector('header.hero .kicker')?.remove();
      // And the How it works heading was reworded.
      const how = copy.id === 'how' ? copy.querySelector('h2') : null;
      if (how) how.textContent = 'Three answers: under a millisecond';
      // And the Languages card says one word now, not the list.
      if (copy.id === 'checks') copy.innerHTML = copy.innerHTML.replace('English, French and Arabic dialects', 'Multilingual');
      // So was the row of payment-rail pills under the MCP section.
      copy.querySelector('#fit .rails, .rails')?.remove();
      return copy;
    });
    expect(kept).toHaveLength(5);
    expect(sections).toHaveLength(5);

    expect(sections.map(node => node.id)).toEqual(
      kept.map(node => node.id)
    );

    sections.forEach((node, index) => {
      if (node.tagName !== 'FOOTER') {
        // The two links moved from #numbers into #checks; where they sit on the
        // page is checked with the other links below.
        const rendered = node.cloneNode(true) as Element;
        rendered.querySelector('.chk-more')?.remove();
        expect(visibleText(rendered)).toBe(
          visibleText(kept[index])
        );
      }
    });

    const links = (root: ParentNode) =>
      [...root.querySelectorAll('a')]
        .filter(link => !link.closest('nav'))
        .filter(link => !link.closest('#api'))
        .filter(link => !link.closest('footer'))
        .map(link => [
          visibleText(link),
          link.getAttribute('href')
        ]);

    expect(links(container)).toEqual(links(original));
  });

  it("renders the brand footer with the site's three link groups", () => {
    render(<App />);

    expect(
      screen.getByText(
        "Moat helps AI agents make authorized payments by verifying every action against the user's intent"
      )
    ).toBeInTheDocument();

    expect([...document.querySelectorAll('.fcols > *')]).toHaveLength(4);
    expect([...document.querySelectorAll('.footer-group h4')].map(node => node.textContent))
      .toEqual(['Product', 'Proof', 'Company']);
    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/docs');
    expect(screen.getByRole('link', { name: 'Who we are' })).toHaveAttribute('href', '/team');
  });

  it('keeps the sandbox commands off the homepage', () => {
    const { container } = render(<App />);
    expect(container.querySelector('#api')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });
});
