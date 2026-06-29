# TornaDEX brand

Source of truth for the demo's visual language. Read by frontend-design-guidelines.

## Voice / tone

Precise, technical, confident, HONEST. Infrastructure for serious builders, not a hype coin.
Never imply parallel matching; every parallelism claim carries the "book-maintenance, not matching"
caveat. State the in-house-review / audit-pending status plainly. Explain from scratch, numbers over
adjectives.

## Aesthetic

Warm editorial LIGHT theme on cream. High-contrast ink for readability (AA+). Generous whitespace,
hairline warm borders, one violet accent. A characterful display serif (Fraunces) for headings, Geist
sans for UI, Geist Mono for all numbers/addresses/code. Diagrams are crisp SVG/CSS, not raster. Motion
only where it teaches; respect reduced-motion.

## Palette (light; tokens in src/app/globals.css)

| token     | hex      | use                                            |
|-----------|----------|------------------------------------------------|
| bg        | #f7f3ea  | cream page background                           |
| bg-soft   | #fcfaf4  | lighter section band                            |
| panel     | #ffffff  | cards, the order ladder, code panels            |
| panel-hi  | #f1ebdd  | row hover, active nav, elevated                  |
| line      | #e7dece  | borders, dividers                              |
| ink (fg)  | #1c1814  | primary text (~13:1 on cream)                   |
| muted     | #5c5346  | secondary text (~6:1)                           |
| faint     | #8a7e6d  | captions / tertiary (large or secondary only)   |
| brand     | #6d28d9  | accent, interactive, AND "parallel" (violet-700)|
| brand-hi  | #5b21b6  | hover / active                                  |
| onbrand   | #ffffff  | text on brand fills                             |
| bid       | #15803d  | buy side / positive (green-700)                 |
| ask       | #dc2626  | sell side / negative (red-600)                  |
| serial    | #b45309  | serialized / warning / devnet chip (amber-700)  |

Semantic discipline: trading sides use green (bid) / red (ask); the parallelism viz uses violet
(parallel) / amber (serial). Violet doubles as the brand/interactive accent. Colors are 600–700 weight
so they keep contrast on cream — do not use bright pastels on this background.

## Typography

- Display: Fraunces (`.display`) for hero + section headings. UI: Geist. Numbers/addresses/code: Geist
  Mono via `.nums` (tabular-nums).
- Addresses: mono, truncated 4…4, click-to-copy, separate explorer link.

## Usage

Tailwind v4 utilities from the tokens: `bg-bg`, `bg-bg-soft`, `bg-panel`, `border-line`, `text-fg`,
`text-muted`, `text-faint`, `text-brand`, `text-bid`, `text-ask`, `text-serial`, `text-onbrand`. Tag
numeric/address cells with `.nums`; headings with `.display`.
