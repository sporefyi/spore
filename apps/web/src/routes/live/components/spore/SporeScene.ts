import * as THREE from 'three';
import { CinematicCamera } from './CinematicCamera';
import type { LiveContext, LiveModule, PhaseName, QualityTier, ZoneInfo } from './types';
import { COLORS, phaseAt } from './types';

export interface SporeSceneOpts {
  onPhase?: (p: PhaseName) => void;
  onFirstDrag?: () => void;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (u: number): number => {
  const c = clamp01(u);
  return c * c * (3 - 2 * c);
};

/**
 * SporeScene — the /live WebGL engine (Lane A: scene core + camera + mushroom host).
 *
 * Owns the renderer, lights, fog, the scripted CinematicCamera and the timeline
 * clock. Other lanes plug in as LiveModules via addModule(); they receive a
 * LiveContext from getContext() (scene, camera, quality, reducedMotion).
 *
 * Timeline time t is seconds since start (never Date.now for visuals).
 *   start()        begins the rAF loop; with prefers-reduced-motion, t starts at 120
 *   replay()       t = 0
 *   skipToEnd()    t = 108 + camera snaps to the final aerial pose
 *
 * NOTE (other lanes): with prefers-reduced-motion the timeline begins at t=120,
 * so every module MUST treat t>=108 as steady-state: no entrances, no
 * grow-ins, no one-shot pulses — only ambient loops (slow rotation, flicker,
 * drifting particles). Modules that can't handle t>=108 will visibly break.
 *
 * The loop pauses when the document is hidden or the canvas leaves the
 * viewport (IntersectionObserver, threshold 0.05); on resume the clock delta is
 * discarded so nothing jumps. dt is clamped to 0.05s.
 *
 * Cursor parallax feeds the camera only on fine-pointer devices; the page
 * passes through pointer {0,0} otherwise (also see CinematicCamera).
 */
export class SporeScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cinematic: CinematicCamera;
  private readonly clock = new THREE.Clock();
  private readonly ctx: LiveContext;
  private readonly modules: LiveModule[] = [];
  private readonly zones: ZoneInfo[] = [];
  private readonly mossLight: THREE.PointLight;
  private readonly pointer = { x: 0, y: 0 };
  private readonly finePointer: boolean;
  private readonly onPhase?: (p: PhaseName) => void;
  private readonly onFirstDrag?: () => void;
  private readonly tmpV = new THREE.Vector3();

  // Drag-to-turn: additive yaw/pitch orbit over the scripted camera.
  private userYaw = 0;
  private userPitch = 0;
  private dragging = false;
  private dragFired = false;
  private lastPX = 0;
  private lastPY = 0;
  private readonly zeroPointer = { x: 0, y: 0 };

  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private raf = 0;
  private started = false;
  private t = 0;
  private phase: PhaseName | null = null;
  private paused = false;
  private hidden = false;
  private intersecting = true;

  constructor(canvas: HTMLCanvasElement, opts: SporeSceneOpts = {}) {
    this.canvas = canvas;
    this.onPhase = opts.onPhase;
    this.onFirstDrag = opts.onFirstDrag;

    // --- quality detection ---
    const mobile = window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
    const quality: QualityTier = mobile
      ? { tier: 'mobile', particleMul: 0.4, dpr: 1.5, shadows: false }
      : { tier: 'high', particleMul: 1, dpr: 2, shadows: true };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.finePointer = window.matchMedia('(pointer: fine)').matches;

    // --- renderer ---
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(COLORS.bg);
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.dpr));

    // --- scene ---
    this.scene.fog = new THREE.FogExp2(COLORS.bg, 0.0072);

    // --- lights ---
    this.scene.add(new THREE.AmbientLight(0xfff2e0, 0.32));
    const key = new THREE.DirectionalLight(0xfff1dd, 1.35);
    key.position.set(30, 48, 22);
    key.castShadow = quality.shadows;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -55;
    key.shadow.camera.right = 55;
    key.shadow.camera.top = 55;
    key.shadow.camera.bottom = -55;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 160;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfe8f0, 0.3);
    rim.position.set(-35, 18, -20);
    this.scene.add(rim);
    this.mossLight = new THREE.PointLight(COLORS.moss, 0, 60);
    this.mossLight.position.set(0, 14, 0);
    this.scene.add(this.mossLight);
    const amber = new THREE.PointLight(COLORS.fungal, 12, 90);
    amber.position.set(28, 10, -18);
    this.scene.add(amber);

    // --- camera ---
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.5, 600);
    this.cinematic = new CinematicCamera(this.camera);

    this.ctx = { scene: this.scene, camera: this.camera, quality, reducedMotion, repayments: [] };

    // --- sizing / visibility / pointer ---
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.cursor = 'grab';
    document.addEventListener('visibilitychange', this.handleVisibility);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    canvas.addEventListener('pointerdown', this.handleDragStart);
    canvas.addEventListener('pointermove', this.handleDragMove);
    canvas.addEventListener('pointerup', this.handleDragEnd);
    canvas.addEventListener('pointercancel', this.handleDragEnd);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        this.intersecting = entries[0]?.isIntersecting ?? true;
        this.updatePaused();
      },
      { threshold: 0.05 },
    );
    this.intersectionObserver.observe(canvas);

    this.resize();
  }

  /** LiveContext handed to modules (Lane B/C/D construct theirs with this). */
  getContext(): LiveContext {
    return this.ctx;
  }

  addModule(m: LiveModule): void {
    this.modules.push(m);
  }

  setZones(z: ZoneInfo[]): void {
    this.zones.length = 0;
    this.zones.push(...z);
  }

  getZones(): ZoneInfo[] {
    return [...this.zones];
  }

  /** Project a world position to CSS px relative to the canvas. */
  project(v: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this.tmpV.copy(v).project(this.camera);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return {
      x: (this.tmpV.x * 0.5 + 0.5) * w,
      y: (-this.tmpV.y * 0.5 + 0.5) * h,
      visible: this.tmpV.z < 1 && this.tmpV.z > -1,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Reduced motion: begin at the final aerial state. Modules treat t>=108
    // as steady-state (see the NOTE on this class).
    this.t = this.ctx.reducedMotion ? 120 : 0;
    this.clock.getDelta();
    this.raf = requestAnimationFrame(this.tick);
  }

  replay(): void {
    this.t = 0;
    this.phase = null; // re-fire onPhase for DARKNESS on the next tick
    this.userYaw = 0;
    this.userPitch = 0;
  }

  skipToEnd(): void {
    this.t = 108;
    this.phase = null;
    this.userYaw = 0;
    this.userPitch = 0;
    this.cinematic.snapToEnd();
  }

  dispose(): void {
    this.started = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('pointerdown', this.handleDragStart);
    this.canvas.removeEventListener('pointermove', this.handleDragMove);
    this.canvas.removeEventListener('pointerup', this.handleDragEnd);
    this.canvas.removeEventListener('pointercancel', this.handleDragEnd);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    for (const m of this.modules) m.dispose();
    this.modules.length = 0;
    this.zones.length = 0;
    this.renderer.dispose();
  }

  private readonly tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.paused) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.t += dt;

    this.cinematic.setUserOrbit(this.userYaw, this.userPitch);
    // Freeze cursor parallax while dragging so the look target stays put.
    this.cinematic.update(this.t, dt, this.dragging ? this.zeroPointer : this.pointer);
    for (const m of this.modules) m.update(dt, this.t);
    this.renderer.render(this.scene, this.camera);

    // Moss light: subtle flicker, ramped in as the mycelium phase begins.
    const ramp = smoothstep((this.t - 10) / 6);
    const flick = 1 + 0.12 * Math.sin(this.t * 3.3) + 0.08 * Math.sin(this.t * 7.9);
    this.mossLight.intensity = ramp * 7 * flick;

    const phase = phaseAt(this.t);
    if (phase !== this.phase) {
      this.phase = phase;
      this.onPhase?.(phase);
    }
  };

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, parent.clientWidth || window.innerWidth);
    const h = Math.max(1, parent.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private updatePaused(): void {
    const paused = this.hidden || !this.intersecting;
    if (paused === this.paused) return;
    this.paused = paused;
    // Discard the gap so the timeline doesn't jump on resume.
    if (!paused) this.clock.getDelta();
  }

  private readonly handleVisibility = (): void => {
    this.hidden = document.hidden;
    this.updatePaused();
  };

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (!this.finePointer) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.pointer.x = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
    this.pointer.y = Math.max(-1, Math.min(1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)));
  };

  private readonly handlePointerLeave = (): void => {
    this.pointer.x = 0;
    this.pointer.y = 0;
  };

  private readonly handleDragStart = (e: PointerEvent): void => {
    if (!e.isPrimary) return;
    this.dragging = true;
    this.lastPX = e.clientX;
    this.lastPY = e.clientY;
    this.canvas.style.cursor = 'grabbing';
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  private readonly handleDragMove = (e: PointerEvent): void => {
    if (!this.dragging || !e.isPrimary) return;
    const dx = e.clientX - this.lastPX;
    const dy = e.clientY - this.lastPY;
    this.lastPX = e.clientX;
    this.lastPY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    this.userYaw -= dx * 0.0045;
    this.userPitch = Math.max(-0.35, Math.min(0.5, this.userPitch - dy * 0.0025));
    if (!this.dragFired) {
      this.dragFired = true;
      this.onFirstDrag?.();
    }
  };

  private readonly handleDragEnd = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.style.cursor = 'grab';
  };
}
