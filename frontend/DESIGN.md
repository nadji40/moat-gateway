---
version: alpha
name: Moat frontend
description: The approved Moat payment-authorization landing page, preserved in React.
colors:
  background: '#000000'
  surface: '#0A0A0A'
  text: '#F4F4F6'
  secondary: '#9C9CA6'
  muted: '#5E5E68'
  brand: '#FF5F00'
  danger: '#FF4D5E'
  warning: '#FFB84D'
  success: '#2ED17A'
typography:
  sans:
    fontFamily: 'Ubuntu, Helvetica Neue, Helvetica, Arial, sans-serif'
  mono:
    fontFamily: 'Ubuntu Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
rounded:
  card: 16px
  band: 22px
spacing:
  page-max: 1240px
  page-gutter: 'clamp(20px,5vw,64px)'
  section: 'clamp(72px,10vw,120px)'
components:
  footer-link:
    mobile-min-height: 44px
---

# Moat frontend design context

## Overview

The approved HTML snapshot is the visual and content authority. This is an
English marketing page for developers integrating agent payment authorization.
The card-and-orbit mark, black background, orange actions and animated payment
flow are its existing identity. This migration introduces no visual direction.

Runtime token ownership stays in the immutable `src/styles/shared.css` snapshot;
this document describes it, not a second generated theme. Homepage-specific rules
live in `src/styles/home.css`; reusable footer rules live in
`src/styles/footer.css`.

## Colors

Preserve all shared CSS variables, semantic verdict colors and translucent glass
surfaces. Orange identifies primary actions and visible keyboard focus.

## Typography

Preserve Ubuntu for interface/prose and Ubuntu Mono for commands, with the
existing system fallbacks. Preserve headings, case, copy and CTA labels verbatim.

## Layout

Preserve the nine homepage components and their order. Footer desktop columns use
one wider brand column and three equal navigation columns. At 1024px and below,
the four items become a strict two-column grid; the brand remains the first grid
item rather than spanning a row. Narrow links are at least 44px high, groups
align left, and long text can wrap without page overflow.

## Elevation & Depth

Keep the approved hairline borders, translucent cards and shared shadows. The
cursor trail remains behind content. The sticky navbar owns its existing layer.

## Shapes

Retain existing rounded cards and pill actions. Footer focus outlines follow the
orange token, with a small radius and 3px offset; no new decorative surfaces.

## Components

React routes use the shared Navbar; legacy pages retain their classic navigation.
Dashboard authentication remains backend-owned. The Home page composes
presentation components and the shared Footer component; the sandbox owns
clipboard state and generated links.
Do not introduce parallel auth logic or generic UI abstractions without reuse.

Footer groups have accessible names, preserved link order and keyboard focus.
Clipboard success/failure uses the existing live region and manual-copy fallback.
SVG animations, cursor trail and existing reduced-motion rules are retained.

## Do's and Don'ts

- Do compare all content and destinations with the immutable fixture.
- Do verify narrow footer geometry in a real browser.
- Do keep desktop composition, original colors and animations.
- Do not redesign other sections or copy backend business logic into React.
