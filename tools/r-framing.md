### FILE: apps/web/src/shared/components/VoxelMushroom.tsx

```diff
@@ imports (add alongside the existing react / @react-three/fiber imports) @@
+import { useEffect } from 'react';
+import { useThree } from '@react-three/fiber';
@@ constants @@
-const DEFAULT_DIST = 36;
+// Framing math (world space, model spans y∈[-12,12] after the group offset below, ±0.35 float,
+// ~±12 in x/z, plus spore margin → treat as half-height 13.5, half-width 13):
+//   fov 36° → tan(18°)=0.325. Landscape: 13.5/0.9/0.325 ≈ 46, +~6 for the near edge of the
+//   rotating ground slab (z≈+10) → 52.
+//   Portrait (390x844, aspect 0.462): width is the limiting axis → 13/(0.9·0.325·0.462) ≈ 96.
+const CAMERA_FOV = 36;
+const DEFAULT_DIST = 52;
+const MIN_DIST = 20;
+const MAX_DIST = 110;
+const FIT_HALF_WIDTH = 13;
+const FIT_MARGIN = 0.9;
+
+function fitDistance(aspect: number) {
+  const tanH = Math.tan((CAMERA_FOV * Math.PI) / 360) * aspect;
+  const byWidth = FIT_HALF_WIDTH / (FIT_MARGIN * tanH);
+  return Math.min(MAX_DIST, Math.max(DEFAULT_DIST, byWidth));
+}
+
+// Render inside <Canvas>. Sets the default zoom distance from the canvas aspect
+// (only on mount/resize, so user wheel/pinch zoom still works freely in between).
+function FitDistance({ api }: { api: { targetDist: number } }) {
+  const aspect = useThree((s) => s.size.width / s.size.height);
+  useEffect(() => {
+    api.targetDist = fitDistance(aspect);
+  }, [aspect, api]);
+  return null;
+}
@@ zoom clamp (wherever wheel/pinch clamps targetDist; was 20–48) @@
-  ... Math.min(48, Math.max(20, <newDist>)) ...
+  ... Math.min(MAX_DIST, Math.max(MIN_DIST, <newDist>)) ...
@@ Canvas props @@
-  camera={{ position: [0, 3, DEFAULT_DIST], fov: 32 }}
+  camera={{ position: [0, 3, DEFAULT_DIST], fov: CAMERA_FOV }}
@@ inside <Canvas> children, next to the scene component that owns `api` @@
+  <FitDistance api={api} />
@@ model group float (center the model on the lookAt point: local y∈[-4,20] → world y∈[-12,12]) @@
-    g.position.y = -12 + Math.sin(...)*0.35
+    g.position.y = -8 + Math.sin(...)*0.35
```

(`state.camera.lookAt(0, 0, 0)` stays unchanged, since the model is now centred on the origin. If `api` is a ref, pass `api.current` to `FitDistance`.)
