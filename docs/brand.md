# SPORE — Brand Identity

**Project:** SPORE — Agent Credit Network
**Status:** Identity v1.0 · 2026-10-03
**Scope:** Standalone brand. No affiliation with any other project, token, or identity.

SPORE is on-chain credit infrastructure for autonomous AI agents: credit
passports, credit scores, a credit oracle, revenue profiles, and a credit
marketplace. The identity pairs **organic growth** (mushroom / spore /
mycelium / network) with **serious financial infrastructure** — editorial,
minimalist, restrained. Think credit bureau, not casino.

---

## 1. The mark

A voxel mushroom derived from the project's hero artwork (moss-green cap
with cream spots, cream stem, glowing ember-orange gills, near-black ground).

- **Cap — moss green `#4A7C59`:** growth, the network, the living substrate.
  Deep and muted, never neon.
- **Spots — cream `#ECE7D9`:** spores. The unit of propagation — and a quiet
  nod to credit "points" dispersing across a network.
- **Gill line — ember orange `#E0642F`:** the single accent. Energy under the
  surface: risk, yield, the live wire of credit. Used sparingly, never as a
  fill.
- **Stem — cream `#ECE7D9`:** the ledger column. Plain, structural, honest.

The mark is geometric and flat. It must read as a **protocol identity** at
16 px, not as illustration, emoji, or game art. Two executions exist:

- `spore-mark.png` — the primary rendered mark (1024×1024, transparent),
  generated from the hero artwork's visual language, background keyed out.
- `favicon.svg` — a hand-authored 16×16 voxel reduction of the same mark
  (geometric squares, crisp edges). This grid is the canonical simplified
  mark and is reused in all three SVG lockups for consistency.

## 2. Color tokens

| Token        | Value                    | Role                                              |
|--------------|--------------------------|---------------------------------------------------|
| `--bg`       | `#0A0C0A`                | Page / app background (near-black, warm)          |
| `--surface`  | `#101311`                | Cards, panels                                     |
| `--surface-2`| `#161A17`                | Raised surfaces, hovers                           |
| `--border`   | `rgba(236,231,217,0.10)` | Hairlines, dividers                               |
| `--text`     | `#ECE7D9`                | Primary text (warm cream)                         |
| `--muted`    | `#9AA094`                | Secondary text, captions                          |
| `--green`    | `#4A7C59`                | Primary brand green (moss)                        |
| `--green-bright` | `#7FB069`            | Success / positive deltas only                    |
| `--amber`    | `#D9A441`                | Warnings, pending states                          |
| `--orange`   | `#E0642F`                | The ember accent — sparing use                    |
| `--danger`   | `#C0392B`                | Errors, negative deltas                           |

**Usage discipline:** dark ground first (`#0A0C0A`). Cream text on dark.
Green is the workhorse; orange appears at most once per viewport (the gill
line, one CTA, one live indicator). Muted grays carry structure. Nothing
glows, nothing gradients.

## 3. Typography

- **Display / wordmark:** Fraunces (serif), SemiBold, letterspaced.
  The `SPORE` wordmark is set in Fraunces SemiBold, all caps, wide tracking.
- **UI:** Inter, Regular/Medium.
- **Numbers / data:** JetBrains Mono. Scores, levels, and figures are always
  tabular monospace — credit data is never set in proportional serif.

Tagline (approved): **"Credit infrastructure for autonomous agents."**
Always with the terminal period.

## 4. Lockups — which file to use

| File | Use when |
|------|----------|
| `logo.svg` | Primary lockup. Dark backgrounds. Mark + cream `SPORE` wordmark, transparent bg. |
| `logo-mono.svg` | Single-color reproduction (print, engraving, one-color contexts). All cream. |
| `logo-light.svg` | Light backgrounds only. Dark `#101311` wordmark; mark keeps green cap / cream spots / ember gill, stem rendered dark so it reads on white. |
| `spore-mark.png` | Standalone mark: avatars, social profile images, app surfaces. |
| `favicon.svg` / `favicon-64.png` | Browser chrome. The simplified voxel grid; legible at 16 px. |
| `app-icon.png` | OS / wallet / launcher icon. Mark on `#0A0C0A` rounded square (512). |
| `og-image.png` | Link unfurls (1200×630). |
| `x-banner.png` | X/Twitter header (1500×500). |

## 5. Clearspace & minimum sizes

- **Clearspace:** keep a margin around the lockup equal to the cap height of
  the `S` in `SPORE` on all sides. Nothing enters this zone — no type, no
  rules, no imagery, no viewport edge.
- **Minimum sizes:**
  - Full lockup (`logo*.svg`): 120 px wide minimum (digital), 32 mm (print).
  - Mark alone (`spore-mark.png`): 32 px minimum.
  - Below 32 px, use `favicon.svg` / `favicon-64.png` (drawn for the scale).
- **Don't** stretch, condense, rotate, recolor, outline, or add shadows /
  glows / gradients to any lockup. Don't place the dark lockup on busy or
  low-contrast imagery; use `logo-mono.svg` knocked out, or don't use it.

## 6. What NOT to do

- **No neon purple, no rainbow gradients, no glassmorphism excess.**
  The palette is moss, cream, ember, and near-black. That's the whole sky.
- **No casino / DeFi aesthetics.** No gold coins, rockets, laser eyes, "to
  the moon" language, jackpot metaphors, or APY-screaming visuals.
- **No generic stock mushroom imagery.** Every mushroom depiction derives
  from the reference artwork's voxel language (moss cap, cream stem, ember
  gills). Never a cartoon toadstool, never an emoji 🍄, never a
  photorealistic forest mushroom.
- **No invented credibility.** SPORE smart contracts are **not deployed**.
  Never render contract addresses, chain statistics, TVL, user counts, or
  partner logos anywhere in brand assets or copy. Unlaunched protocol
  surfaces show honest unavailable states.
- **No brand mixing.** SPORE is standalone: never co-brand, co-locate, or
  cross-link with any other project, token, or identity in any asset.

## 7. Voice (for asset copy)

Short, declarative, institutional. "Credit infrastructure for autonomous
agents." — not "the future of money for robots". Numbers over adjectives.
If a number isn't real, it doesn't appear.

---

## File inventory

All files live in `apps/web/public/brand/`:

```
spore-mark.png    1024×1024  RGBA  Primary mark, transparent background
favicon.svg       vector     Simplified 16×16 voxel mark (canonical small-size mark)
favicon-64.png    64×64      RGBA  Raster favicon, pixel-crisp from the same grid
logo.svg          vector     Primary lockup (dark bg): mark + cream SPORE wordmark
logo-mono.svg     vector     Monochrome lockup, all cream #ECE7D9
logo-light.svg    vector     Light-bg lockup: dark #101311 text, dark stem variant
og-image.png      1200×630   RGB   Open Graph unfurl: mark + SPORE + tagline on #0A0C0A
x-banner.png      1500×500   RGB   X header: sparse left-aligned lockup, negative space
app-icon.png      512×512    RGBA  App icon: mark centered on #0A0C0A rounded square
hero-mushroom.png          Reference hero artwork (source of the visual language)
```

Wordmark setting: Fraunces SemiBold, all caps, letterspaced, `#ECE7D9`
(`#101311` in `logo-light.svg`). SVG text uses the stack
`Fraunces, Georgia, 'Times New Roman', serif` with `font-weight: 600` so the
lockup degrades gracefully where Fraunces isn't installed.
