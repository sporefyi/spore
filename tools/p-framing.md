# Fix: voxel mushroom cropped at the bottom of the hero canvas

## Symptom (from headless-Chromium screenshots, 1440x900 and 390x844)
In the homepage hero, the 3D voxel mushroom's cap renders beautifully, but the
bottom of the organism — stem base, ground slab, mini mushrooms, moss — is cut
off at the bottom edge of the canvas. The whole organism must be visible with
~8-10% breathing room on all sides, on desktop and mobile.

## Current framing (src/shared/components/VoxelMushroom.tsx)
- Camera: `camera={{ position: [0, 3, DEFAULT_DIST], fov: 32 }}` with
  `const DEFAULT_DIST = 36;`, and per-frame `state.camera.lookAt(0, 0, 0)`.
- Model group: `g.position.y = -12 + Math.sin(...)*0.35` (gentle float).
- Zoom: wheel/pinch adjusts `api.targetDist`, clamped 20–48.

## Model vertical extents (src/shared/components/voxelModel.ts, deterministic)
- Ground slab: y in [-4, -1]
- Stem: y in [1, 11]
- Cap dome top: ~19.5
- So model spans y ∈ [-4, 20]; with the group at y=-12, world y ∈ [-16, 8].
- Camera at z=36, fov 32 → vertical half-angle 16° → visible half-height at the
  lookAt plane ≈ 36·tan(16°) ≈ 10.3, i.e. roughly y ∈ [-7.3, 13.3] around the
  lookAt point (0,0,0) viewed from y=3. The model's bottom (-16) is far below
  the visible floor (-7.3): that is the crop.

## Required fix
Reframe so the ENTIRE organism (y ∈ [-16, 8] in world space, plus spore drift
margin) fits comfortably in the canvas at 1440x900 and 390x844, with ~8-10%
margin. You may: raise the group base offset, retarget lookAt, increase the
default distance, or widen fov slightly — pick the combination that keeps the
museum-object feel (mushroom large in frame, not tiny). Constraints:
- Keep the gentle float (±0.35) and ultra-slow auto-rotation untouched.
- Keep drag-to-rotate, hover, click, and zoom working; the new default distance
  must sit inside the existing 20–48 zoom clamp (adjust the clamp only if you
  can justify it).
- Mobile uses the same component: verify your numbers at a narrow aspect
  (horizontal half-angle shrinks — the limiting axis on mobile is width; the
  model is ~24 wide in x, keep it fitting too).
- Do NOT change the voxel model itself, lighting, materials, or interactions.

## Output contract
Answer directly, minimal deliberation. Return the fix as:
### FILE: apps/web/src/shared/components/VoxelMushroom.tsx
followed by a fenced code block containing ONLY the hunks to change, each as a
unified diff against the current file. If a full-file rewrite is cleaner, say
so and return the complete file instead. No explanations outside the diff.
