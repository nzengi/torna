# TornaDEX brand

Source of truth for the demo's visual language. Read by frontend-design-guidelines.

## Voice / tone

Precise, technical, confident, HONEST. Infrastructure for serious builders, not a hype coin.
Never imply parallel matching; every parallelism claim carries the "book-maintenance, not matching"
caveat. State the in-house-review / audit-pending status plainly. Explain from scratch, numbers over
adjectives.

## Aesthetic

Ritual-inspired dark + neon: black ground, neon green/pink/blue accents, ClashGrotesk type, glass cards, gradient text, soft glow. White text stays high-contrast and readable. High-contrast ink for readability (AA+). Generous whitespace,
hairline warm borders, one vivid neon green accent. A characterful display serif (Fraunces) for headings, Geist
sans for UI, Geist Mono for all numbers/addresses/code. Diagrams are crisp SVG/CSS, not raster. Motion
only where it teaches; respect reduced-motion.

## Palette (light; tokens in src/app/globals.css)

| token     | hex      | use                                            |
|-----------|----------|------------------------------------------------|
| bg        | #000000  | page ground (black)                           |
| bg-soft   | #07070b  | section band                            |
| panel     | #ffffff  | cards, the order book, code panels            |
| panel-hi  | #12121a  | row hover, active nav, elevated                  |
| line      | #1d1d27  | borders, dividers                              |
| ink (fg)  | #ffffff  | primary text (white, high contrast)                   |
| muted     | #a2a2af  | secondary text (~6:1)                           |
| faint     | #6a6a78  | captions / tertiary (large or secondary only)   |
| brand     | #00ff88  | accent, interactive, AND "parallel" (neon green)|
| brand-hi  | #00cc6a  | hover / active                                  |
| onbrand   | #ffffff  | text on brand fills                             |
| bid       | #00ff88  | buy side / positive (green-700)                 |
| ask       | #ff2d8e  | sell side / negative (red-600)                  |
| serial    | #b45309  | serialized / warning / devnet chip (amber-700)  |

Semantic discipline: trading sides use green (bid) / red (ask); the parallelism viz uses neon green
(parallel) / amber (serial). Neon green doubles as the brand/interactive accent. Text colors are deep for high contrast on the light page;
the accent is vivid for energy.

## Typography

- Display: ClashGrotesk (`.display`) for hero + section headings. UI: Geist. Numbers/addresses/code: Geist
  Mono via `.nums` (tabular-nums).
- Addresses: mono, truncated 4…4, click-to-copy, separate explorer link.

## Usage

Tailwind v4 utilities from the tokens: `bg-bg`, `bg-bg-soft`, `bg-panel`, `border-line`, `text-fg`,
`text-muted`, `text-faint`, `text-brand`, `text-bid`, `text-ask`, `text-serial`, `text-onbrand`. Tag
numeric/address cells with `.nums`; headings with `.display`.
