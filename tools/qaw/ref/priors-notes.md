# Priors design-language reference (for the SPORE family test)

Source: live inspection of https://priors.trade/ (typography audit 2026-10-03) +
user-supplied screenshots in `ref/priors-hero.png` and `ref/priors-how-it-works.png`.
DO NOT copy Priors' source, logo, artwork, or text. Match the design LANGUAGE only.

## Typefaces (exact, verified from their stylesheet + Google Fonts link)
- Display serif: "EB Garamond" — weights 400, 500 + italic 400. Fallbacks: "Iowan Old Style", Georgia, serif.
  - Hero h1: `400 clamp(46px, 6.2vw, 86px)/.98` — note the .98 line-height.
  - Stat figures: EB Garamond with `font-variant-numeric: lining-nums tabular-nums`.
  - Editorial paragraphs (hero lede, section intros): EB Garamond 400 21px/1.5.
- Body sans: "Schibsted Grotesk" — 400, 500, 600. Body: `400 16px/1.55`.
- Technical/mono: "IBM Plex Mono" — 400, 500 (addresses, ids, code, labels).

## Color & surface
- Near-black warm-black background (not pure #000). Cream/off-white text.
- One restrained green accent (used for: eyebrow labels, one italic word in the
  headline, small data highlights, live block indicator). Everything else
  near-monochrome.
- Thin horizontal rules everywhere; rules are part of the visual language.

## Layout rhythm (from screenshots)
- Top nav: logo left, plain text links, right side has a live "block N" mono
  indicator + one outlined button + one filled button. A thin rule sits under
  the nav; a second sub-nav strip carries small mono status text.
- Hero: eyebrow (green, small) → HUGE serif headline left (with ONE italic
  green word) → serif lede paragraph → filled light button + underlined text
  links. The 3D object sits RIGHT of the text, captioned below with a thin
  rule above the caption ("20,344 repayments" in green serif + italic serif
  description + "Drag to turn it.").
- Numbered sections: "No. 1" in italic serif, large serif section title,
  serif intro paragraph, then content. "How a line opens" pairs an annotated
  SVG mechanism diagram (bordered boxes: the backer / the agent / the pool,
  labeled arrows: "vouches a line", "draws", "repays + fee", vertical note
  "if it walks, the stake covers it") with numbered sub-steps i./ii./iii./iv.
  in serif.
- Massive negative space. Text-first storytelling. No cards, no gradients,
  no glow, no rounded containers, no dashboard chrome.

## What "same design family" means for the test
Restraint, spacing, typography, editorial rhythm, nav density, thin rules,
data presentation, minimalism, technical credibility, interaction quality —
with SPORE's own identity (voxel mushroom, not a tree; its own copy).
