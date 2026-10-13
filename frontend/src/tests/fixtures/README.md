# Immutable upstream snapshots

`approved-home.html` was copied byte-for-byte from `demo/public/index.html`
on 2026-10-12. It is the team lead's approved page, not the former React entry.
`provenance.json` records its SHA-256 and the origin/hash of each vendored shared
asset. Normal tests and builds read only frontend-local copies.

Do not edit the fixture or update its hash to hide a regression. Refreshing it
requires a separately reviewed change to the approved baseline. Responsive footer
layout and accessibility changes must preserve its text and link destinations.
