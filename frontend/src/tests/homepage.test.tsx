
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

  copy.querySelectorAll('style, script').forEach(node => node.remove());

  return copy.textContent?.replace(/\s/g, '') ?? '';
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

    const sections = [
      ...container.querySelectorAll(selector)
    ];

    const approved = [
      ...original.querySelectorAll(selector)
    ];

    // The approved page had a sandbox section (#api). It now lives on the
    // documentation page, so the homepage is one section shorter.
    const kept = approved.filter(node => node.id !== 'api');
    expect(kept).toHaveLength(8);
    expect(sections).toHaveLength(8);

    expect(sections.map(node => node.id)).toEqual(
      kept.map(node => node.id)
    );

    sections.forEach((node, index) => {
      if (node.tagName !== 'FOOTER') {
        expect(visibleText(node)).toBe(
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
        "Moat helps AI agents make authorized payments by verifying every action against the user's intent."
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
