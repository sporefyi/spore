# SPORE 20-Phase Audit — QC Report (2026-10-03)

10 parallel lanes, 114 changes integrated, `npm run build` green (tsc + vite, exit 0).
All code generated via Claude Sonnet 5.5 through `tools/orbio_call.py`; patches applied by exact-match script.

## (1) What was wrong

**Visual / Priors family (L1):** section labels rendered mono uppercase `NO. 01` (Priors: italic serif "No. 1"); redundant double labels (SectionNo + eyebrow saying the same thing) on 5 routes; page ledes in sans (Priors: EB Garamond 21px); passport figures in mono (Priors: serif stat figures); eyebrows gray instead of moss; hero h1 capped at 72px (Priors: clamp to 86px); footer "Experimental protocol" in a bordered box (card residue); last glassmorphism residue on the site (backdrop-blur + translucent CTA button on the 3D canvas); hard-coded hexes bypassing tokens.

**Hero / 3D (L2):** [MAJOR] mobile scroll trap — `touchAction: 'none'` on the hero blocked page scroll on touch devices; wheel listener hijacked all page scroll over the canvas; FitDistance re-snapped zoom on every resize, discarding user zoom; canvas unreachable by keyboard.

**Copy (L3):** hero caption present-tense ("read from the chain") for a future state; cutesy 404 copy; filler/cliché phrases ("programmable infrastructure", "puts capital to work", "actually"); incoherent section numbering (five pages each "No. 01"; passport numbered 02–07); footer wordmark at wrong weight; abstract hero lede (replaced per user request with mechanism statement).

**Data honesty (L4):** market `$100` router figure lacked explicit illustrative disclosure. (ScoreLab math verified exact against docs/scoring.md; all stats honestly "—".)

**Navigation (L5):** no scroll restoration on route change (26 links otherwise all valid, zero dead).

**A11y (L8):** score-lab sliders had NO visible focus indicator [blocker]; `--faint`/`--ember` failed AA contrast; broken `<main>` landmark (Home had none); manual drag dead under reduced-motion; 3D canvas keyboard-unreachable; loading pulse and score count-up not motion-gated; mechanism crossfade exceeded the 500ms budget; no route-change focus management.

**Code / tokens (L9):** dead file (`protocol/schema.ts`), dead shim (`DataState.tsx`), dead component, dead export (`countVoxels`), dead types, 8 unreferenced assets (~350KB PNGs/SVGs), unused `viem` dep, dead `.rule-t`/`.rule-b` CSS, skip-link pointing at nonexistent `surface` token, ~208KB of non-latin font subsets shipped, SVG/font-stack token bypasses.

**Responsive / family test (L6/L10):** both SVG diagrams illegible at 390px (4–6px overlapping labels); stats row monotonous (4× identical "No contracts deployed"); diagram label duplication; second accent undocumented.

## (2) What changed

- **106 wave-1 patches** (lanes 1–5, 7–9) + **4 wave-2 patches** (lane 6: mobile diagram layouts) + **3 micro-fixes** + **1 parent-directed hero lede** (mechanism statement).
- SectionNo → italic serif moss "No. 1"; removed from non-home routes (kept for protocol steps); eyebrows moss; ledes serif; stat figures serif; hero h1 `clamp(46px,6.2vw,86px)`; nav gained honest mono status strip (Robinhood Chain · chain 4663 / contracts not deployed / explorer —); footer de-boxed.
- Mobile scroll trap fixed (`pan-y`); wheel only hijacks pinch-zoom; FitDistance mount-only; keyboard-operable 3D (arrows/Enter, proper ARIA); reduced-motion demand-render with manual interaction preserved.
- Contrast fixed (`--faint` #8a8069 4.82:1, `--ember` #c4644f 4.73:1); single `<main>` landmark per route; RouteFocus (scroll + focus reset, hash-guard); slider focus outlines.
- **Deletions executed:** `schema.ts`, `DataState.tsx`, `DataState` component, `countVoxels`, 3 dead types (5 more kept — they're in used types' dependency graphs), 8 unused assets, `viem` from dependencies, dead CSS.
- Latin-only font subsets; token bypasses converted to `var(--*)`; `::selection` via color-mix.
- Parent's hero lede: "AI agents borrow here. Before an agent can borrow, a backer puts stake behind its line — and that stake is lost first if the agent doesn't repay. Every repayment is recorded on Robinhood Chain, where anyone can check it."

## (3) WebGL implementation notes

Real WebGL (R3F + three.js, instanced voxel boxes — NOT a fallback): green cap/cream stem/orange gills/moss/ground/floating spores, procedural from the artwork. Drag / scroll / hover / click "Read the organism" / touch all functional. Perf guards verified: lazy 898KB chunk behind Suspense (SVG fallback while loading), DPR caps (1 mobile / 1.5 desktop), tab-hidden + offscreen pause (`frameloop='never'`), R3F auto-disposal + `InstancedMesh.dispose()`, mobile geometry tiering (~6k → ~3.5k instances), zero per-frame allocations. Wave-1 perf fixes: pointermove now raycasts ONE invisible proxy sphere instead of ~6k instances; SporeField skips sub-pixel matrix writes (no GPU upload when idle). Reduced-motion verified by pixel-drift test (0.00 drift over 5s vs 20.44 without); manual drag/keys/pinch still work via demand-render invalidate. Graceful no-WebGL SVG fallback. Limitation: no runtime context-loss recovery after mount (edge case, unpatched).

## (4) Performance changes

- Removed ~208KB non-latin font subsets from dist; ~350KB+ unused PNGs/SVGs deleted from the bundle; `viem` dropped from the install graph.
- Pointermove jank source eliminated (54k instance raycast tests → 1 sphere test per event).
- SporeField: per-frame 90-instance matrix rewrite + GPU upload → epsilon-skip (no upload when idle).
- Font loading: latin-only `@fontsource/*/latin-*.css` imports.
- Chunking unchanged and sound: 898KB lazy VoxelMushroom chunk, 180KB main, per-route splits.

## (5) Mobile fixes

- **Scroll trap fixed** (`touchAction: 'pan-y'`) — the single major mobile defect; page scrolls over the hero, horizontal drag still rotates, pinch-zoom preserved.
- Mechanism diagram: horizontally scrollable at 600px min-width on small screens (labels legible, interactivity preserved).
- No. 3 oracle diagram: mobile gets a vertical editorial stack (hairline rule, moss dots, mono labels); desktop SVG hidden below `md`.
- f5/f4 flow-label collision fixed in the mechanism diagram.
- Verified: zero horizontal overflow at 1440/1280/1024/768/430/390/375; mobile nav wraps cleanly with the new status strip; hero stacks intentionally at 390px.

## (6) Remaining limitations

- **Family test 9/10:** Q8 ("protocol feels real, not conceptual") is NO — inherent to zero deployed contracts, not a design defect. Any honest live signal (contracts deploying) resolves it.
- One harness entry logged 3 console errors (`1024×768 /passport/demo-agent`); not reproducible in 3 follow-up runs — transient SwiftShader flake, not a site bug.
- WebGL verified under SwiftShader (software); real-GPU-only errors can't be ruled out from this VM.
- `framer-motion` kept (sole use: score count-up); rAF swap not worth the risk.
- Mobile tier keeps antialiasing (disabling AA is a visible tradeoff; tier already caps DPR at 1).
- Lane 9's type-deletion list was narrowed on verification (kept 5 types referenced by used types).

## (7) dist/ readiness — CONFIRMED

- `npm run build` green: `tsc --noEmit` + `vite build`, exit 0, dist/ at `~/workspace/spore/apps/web/dist/`.
- Final sweep: **9/9 routes (incl. `#score-lab`, `/#ledger`) — 0 console errors, 0 pageerrors, 0 failed requests, 0 4xx/5xx, 0 horizontal overflow.**
- Brand firewall clean: zero Leo/$LEO/MNS/museid, zero 0x addresses, zero Base references; chain = Robinhood Chain (4663) throughout.
- Honesty intact: null CHAIN_CONFIG, "—" stats, honest empty ledger, illustrative disclosures, Priors lineage + footer link preserved per user request.
- **DO NOT DEPLOY from here — deploy is the parent's step (Netlify).**
