
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

    expect(approved).toHaveLength(9);
    expect(sections).toHaveLength(9);

    expect(sections.map(node => node.id)).toEqual(
      approved.map(node => node.id)
    );

    sections.forEach((node, index) => {
      if (node.id !== 'api' && node.tagName !== 'FOOTER') {
        expect(visibleText(node)).toBe(
          visibleText(approved[index])
        );
      }
    });

    const links = (root: ParentNode) =>
      [...root.querySelectorAll('a')]
        .filter(link => !link.closest('nav'))
        .filter(link => !link.closest('#api'))
        .filter(link => !link.classList.contains('social-link'))
        .map(link => [
          visibleText(link),
          link.getAttribute('href')
        ]);

    expect(links(container)).toEqual(links(original));
  });

  it('renders the reusable brand footer without changing navigation groups', () => {
    render(<App />);

    expect(
      screen.getByText(
        "Moat helps AI agents make authorized payments by verifying every action against the user's intent."
      )
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'LinkedIn' }))
      .toHaveAttribute('href', 'https://www.linkedin.com');
    expect(screen.getByRole('link', { name: 'WhatsApp' }))
      .toHaveAttribute('href', 'https://www.whatsapp.com/');
    expect(screen.getByLabelText('Email contact unavailable')).toBeInTheDocument();

    expect([...document.querySelectorAll('.fcols > *')]).toHaveLength(4);
    expect([...document.querySelectorAll('.footer-group h4')].map(node => node.textContent))
      .toEqual(['Product', 'Proof', 'Workspace']);
  });

  it('copies the displayed curl commands and announces success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal('isSecureContext', true);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy curl example to clipboard' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Curl example copied'
      );
    });

    const curl = container.querySelector('#curl');

    expect(curl).not.toBeNull();
    expect(writeText).toHaveBeenCalledWith(curl!.textContent);

    expect(curl!.textContent).toContain(
      '\n\n# what the user asked for'
    );

    for (const name of ['ChatGPT', 'Claude', 'Perplexity']) {
      const href = screen.getByRole('link', { name })
        .getAttribute('href')!;

      const url = new URL(href);

      expect(url.searchParams.get('q')).toContain(
        window.location.origin
      );

      expect(url.searchParams.get('q')).toContain(
        'POST   /v1/sandbox'
      );
    }
  });

  it.each(['refused', 'throws'])('selects the example when legacy clipboard access %s', async (failure) => {
    vi.stubGlobal('isSecureContext', true);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(
          new Error('Denied')
        )
      }
    });

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        if (failure === 'throws') throw new Error('Copy unsupported');
        return false;
      })
    });

    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy curl example to clipboard' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy curl example to clipboard' })).toHaveTextContent(
        'Press ctrl C'
      );
    });

    expect(window.getSelection()?.toString()).toBe(
      container.querySelector('#curl')!.textContent
    );
    expect(document.querySelector('textarea')).toBeNull();
  });
});
