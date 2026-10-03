import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { buildModel } from './voxelModel';
import type { Voxel } from './voxelModel';
import VoxelMushroomFallback from './VoxelMushroomFallback';

export interface VoxelMushroomProps {
  onReadOrganism: () => void;
  className?: string;
}

export interface NdcPoint {
  x: number;
  y: number;
}

const MIN_DIST = 20;
const MAX_DIST = 110;
// Framing: model local y∈[-4,20]; group base offset -8 → world y∈[-12,12],
// ±0.35 float, ~±12 in x/z plus spore margin → fit half-height 13.5, half-width 13.
// fov 36° → tan(18°)=0.325. Landscape: 13.5/0.9/0.325 ≈ 46, +~6 for the near edge
// of the rotating ground slab → 52. Portrait: width is the limiting axis, fit by aspect.
const CAMERA_FOV = 36;
const DEFAULT_DIST = 52;
const FIT_HALF_WIDTH = 13;
const FIT_MARGIN = 0.9;

function fitDistance(aspect: number): number {
  const tanH = Math.tan((CAMERA_FOV * Math.PI) / 360) * aspect;
  const byWidth = FIT_HALF_WIDTH / (FIT_MARGIN * tanH);
  return Math.min(MAX_DIST, Math.max(DEFAULT_DIST, byWidth));
}

// Render inside <Canvas>. Sets the default zoom distance from the canvas aspect
// on mount only, so user wheel/pinch zoom is never discarded by a later resize.
function FitDistance({
  api,
  hasFitRef,
}: {
  api: { targetDist: number };
  hasFitRef: MutableRefObject<boolean>;
}) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / s.size.height);
  useEffect(() => {
    // Fit once on mount; later resizes must not discard the user's wheel/pinch zoom.
    if (hasFitRef.current) return;
    hasFitRef.current = true;
    const d = fitDistance(aspect);
    api.targetDist = d;
    camera.position.z = d; // snap too: covers the reduced-motion single static frame
  }, [aspect, api, camera, hasFitRef]);
  return null;
}

// Exposes R3F's invalidate() to the DOM pointer handlers so manual drags
// re-render when the Canvas runs with frameloop="demand" (reduced motion).
function InvalidateHandle({ invalidateRef }: { invalidateRef: MutableRefObject<() => void> }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate, invalidateRef]);
  return null;
}

function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// Module-scope scratch objects (no per-frame allocations)
const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();
const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();
const pointerWorld = new THREE.Vector3();
const pointerLocal = new THREE.Vector3();
const sporePos = new THREE.Vector3();

const TAU = Math.PI * 2;

function VoxelInstances({ voxels }: { voxels: Voxel[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      dummy.position.set(v.pos[0], v.pos[1], v.pos[2]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(v.size ?? 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const k = 0.93 + hash01(i * 7 + 1) * 0.14;
      tmpColor.set(v.color).multiplyScalar(k);
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [voxels]);

  if (voxels.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={
        [undefined, undefined, voxels.length] as unknown as [
          THREE.BufferGeometry | undefined,
          THREE.Material | undefined,
          number,
        ]
      }
      frustumCulled={false}
      raycast={() => null}
    >
      <boxGeometry args={[0.96, 0.96, 0.96]} />
      <meshStandardMaterial flatShading roughness={0.85} metalness={0} />
    </instancedMesh>
  );
}

function SporeField({
  voxels,
  hoveredRef,
  pointerRef,
}: {
  voxels: Voxel[];
  hoveredRef: MutableRefObject<boolean>;
  pointerRef: MutableRefObject<NdcPoint>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const data = useMemo(() => {
    const n = voxels.length;
    const base = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const scale = new Float32Array(n);
    const pull = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = voxels[i];
      base[i * 3] = v.pos[0];
      base[i * 3 + 1] = v.pos[1];
      base[i * 3 + 2] = v.pos[2];
      phase[i] = hash01(i * 13 + 3) * TAU;
      scale[i] = v.size ?? 1;
      pull[i] = 0;
    }
    const prev = new Float32Array(base);
    return { base, phase, scale, pull, prev };
  }, [voxels]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < voxels.length; i++) {
      dummy.position.set(data.base[i * 3], data.base[i * 3 + 1], data.base[i * 3 + 2]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(data.scale[i]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const k = 0.93 + hash01(i * 7 + 1) * 0.14;
      tmpColor.set(voxels[i].color).multiplyScalar(k);
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [voxels, data]);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const n = voxels.length;
    const t = state.clock.elapsedTime;
    const hovered = hoveredRef.current;
    const target = hovered ? 0.12 : 0;
    const damp = 1 - Math.exp(-4 * Math.min(delta, 0.1));
    const amp = 0.35;

    let hasPointer = false;
    if (hovered) {
      const cam = state.camera;
      const p = pointerRef.current;
      rayOrigin.set(p.x, p.y, 0.5).unproject(cam);
      rayDir.copy(rayOrigin).sub(cam.position).normalize();
      if (Math.abs(rayDir.z) > 1e-5) {
        const dist = -cam.position.z / rayDir.z;
        if (dist > 0) {
          pointerWorld.copy(cam.position).addScaledVector(rayDir, dist);
          pointerLocal.copy(pointerWorld);
          mesh.worldToLocal(pointerLocal);
          hasPointer = true;
        }
      }
    }

    const { base, phase, scale, pull, prev } = data;
    // Sub-pixel epsilon: skip matrix writes for instances that barely moved
    // since their last write. When idle (unhovered, pull converged) the drift
    // is sub-pixel per frame, so most frames skip the instanceMatrix upload.
    const EPS2 = 0.004 * 0.004;
    let anyMoved = false;
    for (let i = 0; i < n; i++) {
      const ph = phase[i];
      sporePos.set(
        base[i * 3] + Math.sin(t * 0.4 + ph) * amp,
        base[i * 3 + 1] + Math.sin(t * 0.55 + ph * 1.3) * amp,
        base[i * 3 + 2] + Math.cos(t * 0.35 + ph * 0.7) * amp
      );

      pull[i] += (target - pull[i]) * damp;

      if (hasPointer || pull[i] > 0.0005) {
        if (hasPointer) {
          const pl = pull[i];
          sporePos.x += (pointerLocal.x - sporePos.x) * pl;
          sporePos.y += (pointerLocal.y - sporePos.y) * pl;
          sporePos.z += (pointerLocal.z - sporePos.z) * pl;
        }
      }

      const j = i * 3;
      const dx = sporePos.x - prev[j];
      const dy = sporePos.y - prev[j + 1];
      const dz = sporePos.z - prev[j + 2];
      if (dx * dx + dy * dy + dz * dz < EPS2) continue;
      prev[j] = sporePos.x;
      prev[j + 1] = sporePos.y;
      prev[j + 2] = sporePos.z;

      dummy.position.copy(sporePos);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(scale[i]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      anyMoved = true;
    }
    if (anyMoved) mesh.instanceMatrix.needsUpdate = true;
  });

  if (voxels.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={
        [undefined, undefined, voxels.length] as unknown as [
          THREE.BufferGeometry | undefined,
          THREE.Material | undefined,
          number,
        ]
      }
      frustumCulled={false}
      raycast={() => null}
    >
      <boxGeometry args={[0.96, 0.96, 0.96]} />
      <meshStandardMaterial flatShading roughness={0.85} metalness={0} />
    </instancedMesh>
  );
}

export interface RigApi {
  targetRotY: number;
  targetRotX: number;
  targetDist: number;
  dragging: boolean;
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

type VoxelModelT = ReturnType<typeof buildModel>;

function Rig(props: {
  model: VoxelModelT;
  hovered: boolean;
  hoveredRef: MutableRefObject<boolean>;
  pointerRef: MutableRefObject<NdcPoint>;
  reducedMotion: boolean;
  apiRef: MutableRefObject<RigApi>;
  onHoverChange: (h: boolean) => void;
}) {
  const { model, hovered, hoveredRef, pointerRef, reducedMotion, apiRef, onHoverChange } = props;
  const groupRef = useRef<THREE.Group>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);

  const layers = useMemo(() => {
    const out: Voxel[][] = [];
    const rec = model as unknown as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (k === 'spores') continue;
      const val = rec[k];
      if (Array.isArray(val)) out.push(val as Voxel[]);
    }
    return out;
  }, [model]);

  const spores = (model as unknown as { spores: Voxel[] }).spores;

  useFrame((state, dt) => {
    const api = apiRef.current;
    const g = groupRef.current;
    if (!g) return;
    // Idle drift only when motion is allowed; manual drag targets always apply
    // (in reduced-motion mode they render via invalidate() on user input).
    if (!reducedMotion && !api.dragging) api.targetRotY += dt * 0.12;
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, api.targetRotY, 4, dt);
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, api.targetRotX, 4, dt);
    if (!reducedMotion) {
      g.position.y = -8 + Math.sin(state.clock.elapsedTime * 0.6) * 0.35;
      state.camera.position.z = THREE.MathUtils.damp(
        state.camera.position.z,
        api.targetDist,
        4,
        dt
      );
    } else {
      // Reduced motion: honor manual zoom immediately on invalidate-driven frames.
      state.camera.position.z = api.targetDist;
    }
    state.camera.lookAt(0, 0, 0);
    const s = THREE.MathUtils.damp(g.scale.x, hovered ? 1.03 : 1, 5, dt);
    g.scale.setScalar(s);
    if (keyRef.current) {
      keyRef.current.intensity = THREE.MathUtils.damp(
        keyRef.current.intensity,
        hovered ? 2.0 : 1.55,
        5,
        dt
      );
    }
  });

  return (
    <>
      <ambientLight intensity={0.35} color="#fff2e0" />
      <directionalLight ref={keyRef} position={[9, 18, 11]} intensity={1.55} color="#fff4e2" />
      <directionalLight position={[-11, 6, 7]} intensity={0.32} color="#dfe8f0" />
      <directionalLight position={[0, 9, -13]} intensity={0.55} color="#ffe9c9" />
      <group
        ref={groupRef}
        position={[0, -12, 0]}
        rotation={reducedMotion ? [0, 0.6, 0] : [0, 0.6, 0.08]}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHoverChange(true);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onHoverChange(false);
        }}
      >
        {/* Invisible low-poly hover proxy. All voxel meshes use
            raycast={() => null}, so pointermove tests only this sphere. */}
        <mesh position={[0, 8, 0]}>
          <sphereGeometry args={[15, 12, 8]} />
          <meshBasicMaterial visible={false} />
        </mesh>
        {layers.map((vs, i) => (
          <VoxelInstances key={i} voxels={vs} />
        ))}
        {reducedMotion ? (
          <VoxelInstances voxels={spores} />
        ) : (
          <SporeField voxels={spores} hoveredRef={hoveredRef} pointerRef={pointerRef} />
        )}
      </group>
    </>
  );
}

const ctaButtonStyle: CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  font: '11px/1 "IBM Plex Mono", monospace',
  letterSpacing: '.18em',
  textTransform: 'uppercase',
  padding: '10px 18px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function VoxelMushroom({ onReadOrganism, className }: VoxelMushroomProps) {
  const [webglOk] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  });

  const isMobile = useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }, []);

  const reducedMotion = useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const model = useMemo(() => buildModel(isMobile ? 'low' : 'high'), [isMobile]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [hidden, setHidden] = useState<boolean>(
    typeof document !== 'undefined' ? document.hidden : false
  );
  const [hovered, setHovered] = useState(false);
  const [showCta, setShowCta] = useState(false);
  const [dragCursor, setDragCursor] = useState(false);

  const hoveredRef = useRef(false);
  const pointerRef = useRef<NdcPoint>({ x: 0, y: 0 });
  const apiRef = useRef<RigApi>({
    targetRotY: 0.6,
    targetRotX: 0.08,
    targetDist: DEFAULT_DIST,
    dragging: false,
  });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const downInfo = useRef({ x: 0, y: 0, time: 0, moved: false });
  const hasFitRef = useRef(false);
  const invalidateRef = useRef<() => void>(() => {});
  const pinchRef = useRef<number | null>(null);

  useEffect(() => {
    hoveredRef.current = hovered;
  }, [hovered]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) setVisible(en.isIntersecting);
      },
      { threshold: 0.05 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [webglOk]);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Only hijack pinch-zoom gestures (ctrl/meta + wheel); plain wheel scrolls the page.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      apiRef.current.targetDist = clamp(
        apiRef.current.targetDist + e.deltaY * 0.02,
        MIN_DIST,
        MAX_DIST
      );
      invalidateRef.current(); // re-render for frameloop="demand" (reduced motion)
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [webglOk]);

  if (!webglOk) return <VoxelMushroomFallback className={className} />;

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest && target.closest('button')) return;
    const wrapper = e.currentTarget;
    try {
      wrapper.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const pointers = pointersRef.current;
    const api = apiRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchRef.current = null;
    if (pointers.size === 1) {
      api.dragging = true;
      downInfo.current = {
        x: e.clientX,
        y: e.clientY,
        time: performance.now(),
        moved: false,
      };
      setDragCursor(true);
    } else {
      downInfo.current.moved = true;
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      pointerRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    }
    const pointers = pointersRef.current;
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const api = apiRef.current;

    if (pointers.size === 1 && api.dragging) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      api.targetRotY += dx * 0.0055;
      api.targetRotX = clamp(api.targetRotX + dy * 0.003, -0.35, 0.55);
      const d = Math.hypot(e.clientX - downInfo.current.x, e.clientY - downInfo.current.y);
      if (d > 6) downInfo.current.moved = true;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      invalidateRef.current(); // re-render for frameloop="demand" (reduced motion)
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = Array.from(pointers.values());
      const cur = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchRef.current !== null && cur > 0) {
        api.targetDist = clamp(
          api.targetDist * (pinchRef.current / cur),
          MIN_DIST,
          MAX_DIST
        );
      }
      pinchRef.current = cur;
      downInfo.current.moved = true;
      invalidateRef.current(); // re-render for frameloop="demand" (reduced motion)
    } else {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };

  const handlePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinchRef.current = null;
    if (pointers.size === 0) {
      const wasClick =
        e.type === 'pointerup' &&
        !downInfo.current.moved &&
        performance.now() - downInfo.current.time < 400;
      apiRef.current.dragging = false;
      setDragCursor(false);
      if (wasClick) setShowCta(true);
    }
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const api = apiRef.current;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        api.targetRotY -= 0.15;
        break;
      case 'ArrowRight':
        e.preventDefault();
        api.targetRotY += 0.15;
        break;
      case 'ArrowUp':
        e.preventDefault();
        api.targetRotX = clamp(api.targetRotX - 0.08, -0.35, 0.55);
        break;
      case 'ArrowDown':
        e.preventDefault();
        api.targetRotX = clamp(api.targetRotX + 0.08, -0.35, 0.55);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        setShowCta(true);
        break;
      default:
        return;
    }
    invalidateRef.current();
  };

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        cursor: dragCursor ? 'grabbing' : 'grab',
        // pan-y: vertical swipes scroll the page instead of being trapped by the canvas;
        // the pointer handlers still receive horizontal drags and pinch gestures.
        touchAction: 'pan-y',
        overflow: 'hidden',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={handleKeyDown}
      role="group"
      tabIndex={0}
      aria-label="Voxel mushroom, interactive 3D model. Drag or use arrow keys to rotate; press Enter for the organism readout."
    >
      <Canvas
        dpr={isMobile ? 1 : ([1, 1.5] as [number, number])}
        gl={{ antialias: true, alpha: true }}
        camera={{ position: [0, 3, DEFAULT_DIST], fov: CAMERA_FOV }}
        frameloop={
          visible && !hidden ? (reducedMotion ? 'demand' : 'always') : 'never'
        }
        className="vm-enter"
        style={{ background: 'transparent' }}
      >
        <FitDistance api={apiRef.current} hasFitRef={hasFitRef} />
        <InvalidateHandle invalidateRef={invalidateRef} />
        <Rig
          model={model}
          hovered={hovered}
          hoveredRef={hoveredRef}
          pointerRef={pointerRef}
          reducedMotion={reducedMotion}
          apiRef={apiRef}
          onHoverChange={setHovered}
        />
      </Canvas>
      {showCta && (
        <div
          className="vm-cta"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '18px',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: '8px',
            zIndex: 5,
          }}
        >
          <button type="button" style={ctaButtonStyle} onClick={onReadOrganism}>
            Read the organism →
          </button>
          <button
            type="button"
            aria-label="Dismiss organism prompt"
            style={{ ...ctaButtonStyle, padding: '10px 12px' }}
            onClick={() => setShowCta(false)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
