# TornaDEX brand

Source of truth for the demo's visual language. Read by frontend-design-guidelines.

## Voice / tone

Precise, technical, confident, HONEST. This is infrastructure for serious builders, not a
hype coin. Never imply parallel matching; every parallelism claim carries the
"book-maintenance, not matching" caveat. State the in-house-review / audit-pending status
plainly. Numbers over adjectives.

## Aesthetic

Dark financial/terminal. Dense, aligned, monospace numerics (tabular-nums). Restraint:
generous dark space, hairline borders, one accent. Motion only where it teaches (a tx
landing in a slot, a leaf highlighting). No gradients-for-decoration, no emoji.

## Palette (dark-only; tokens in src/app/globals.css)

| token        | hex      | use                                            |
|--------------|----------|------------------------------------------------|
| bg           | #09090b  | page background                                |
| panel        | #121317  | cards, the order ladder, code panels           |
| panel-hi     | #1a1b21  | row hover, elevated surfaces                    |
| line         | #26272e  | borders, dividers                              |
| fg           | #ececef  | primary text                                   |
| muted        | #9a9aa3  | secondary text / labels                        |
| faint        | #6a6a73  | captions / provenance notes                    |
| brand        | #a78bfa  | accent, interactive, AND "parallel" (violet)   |
| brand-hi     | #8b5cf6  | hover / active                                 |
| bid          | #34d399  | buy side / positive (emerald)                  |
| ask          | #fb7185  | sell side / negative (rose)                    |
| serial       | #fbbf24  | serialized / warning (amber)                   |

Semantic discipline (avoids the green-collision): trading sides use emerald (bid) / rose
(ask); the parallelism viz uses violet (parallel) / amber (serial). Violet doubles as the
brand/interactive accent. Never use bid-green to mean "parallel".

## Typography

- Sans: Geist (UI, prose). Mono: Geist Mono (all numbers, addresses, code) via `.nums` or
  `font-mono` + `tabular-nums`.
- Addresses/keys: mono, truncated middle, full on hover/copy.

## Usage

Tailwind v4 utilities from the tokens: `bg-panel`, `border-line`, `text-muted`, `text-bid`,
`text-ask`, `text-brand`, `text-serial`, etc. Tag numeric/address cells with `.nums`.
