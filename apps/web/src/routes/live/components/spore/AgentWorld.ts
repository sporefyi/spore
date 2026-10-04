import * as THREE from 'three';
import { COLORS, PHASE, type LiveContext, type LiveModule, type ParticleSystem } from './types';
import { PLAZA_TOP, TERMINAL_DATA, mulberry32 } from './MarketScene';

/* ------------------------------------------------------------------ */
/* AgentWorld — 10 autonomous agents walking the market, paying at      */
/* terminals. Appears 46–50s (staggered scale-in), walks forever after. */
/* ------------------------------------------------------------------ */

const ACCENTS = [COLORS.moss, COLORS.fungal, COLORS.ivory, 0x7a8a99, COLORS.muted];
const APPEAR_T = PHASE.AGENTS[0] - 2; // 46 — agents fade in just before their phase
const WALK_SPEED = 2.2;
const PAUSE_T = 1.6;

type AgentState = 'walk' | 'pause' | 'pay';

interface Waypoint {
  pos: THREE.Vector3;
  /** Index into TERMINAL_DATA, or -1 for plain circuit points. */
  terminal: number;
}

interface AgentRig {
  group: THREE.Group;
  eyeMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  cubeMat: THREE.MeshStandardMaterial | null;
  cube: THREE.Mesh | null;
  cubeBaseY: number;
  cubePhase: number;
  accent: number;
  waypoints: Waypoint[];
  wpIndex: number;
  state: AgentState;
  stateT: number;
  yaw: number;
  birthT: number;
  bobPhase: number;
}

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function turnToward(cur: number, target: number, maxStep: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}

export class AgentWorld implements LiveModule {
  private ctx: LiveContext;
  private particles: ParticleSystem;
  private root = new THREE.Group();
  private agents: AgentRig[] = [];
  private flashes: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; t: number; active: boolean }[] = [];
  private reduced: boolean;

  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private cylGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.9, 6);
  private bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2723, roughness: 0.7 });
  private tipMat = new THREE.MeshStandardMaterial({
    color: 0x201a12,
    emissive: 0xffd9a0,
    emissiveIntensity: 1.6,
  });

  constructor(ctx: LiveContext, particles: ParticleSystem) {
    this.ctx = ctx;
    this.particles = particles;
    this.reduced = ctx.reducedMotion;

    const count = ctx.quality.tier === 'mobile' ? 5 : 10;
    for (let i = 0; i < count; i++) this.agents.push(this.buildAgent(i));

    // Pooled additive flash sprites for payment moments at terminals.
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.SpriteMaterial({
        color: COLORS.fungal,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.root.add(sprite);
      this.flashes.push({ sprite, mat, t: 0, active: false });
    }

    if (this.reduced) this.placeStatic();
    ctx.scene.add(this.root);
  }

  private buildAgent(i: number): AgentRig {
    const rng = mulberry32(9000 + i * 131);
    const accent = ACCENTS[i % ACCENTS.length];
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.65 });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x201a12,
      emissive: 0xffd9a0,
      emissiveIntensity: 1.3,
    });
    const tall = rng() < 0.5;
    const hasAntenna = rng() < 0.55;
    const hasPods = !tall || rng() < 0.4;
    const hasCube = i === 0 || i === 4 || i === 7;
    const shadows = this.ctx.quality.shadows;

    const group = new THREE.Group();
    const add = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(this.boxGeo, mat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.castShadow = shadows;
      group.add(m);
      return m;
    };

    let cube: THREE.Mesh | null = null;
    let cubeMat: THREE.MeshStandardMaterial | null = null;
    let cubeBaseY = 0;

    if (tall) {
      add(0.22, 0.6, 0.22, -0.28, 0.3, 0, this.bodyMat);
      add(0.22, 0.6, 0.22, 0.28, 0.3, 0, this.bodyMat);
      add(1.0, 2.0, 1.0, 0, 1.6, 0, this.bodyMat); // 0.6–2.6
      add(1.04, 0.4, 1.04, 0, 1.5, 0, accentMat); // chest band
      add(0.7, 0.7, 0.7, 0, 2.95, 0, this.bodyMat); // head
      add(0.5, 0.14, 0.08, 0, 3.0, 0.36, eyeMat); // eye
      if (hasAntenna) {
        const ant = new THREE.Mesh(this.cylGeo, this.bodyMat);
        ant.position.set(0.22, 3.75, 0);
        ant.castShadow = shadows;
        group.add(ant);
        add(0.14, 0.14, 0.14, 0.22, 4.28, 0, this.tipMat);
      }
      if (hasPods) {
        add(0.42, 0.9, 0.42, -0.71, 1.7, 0, accentMat);
        add(0.42, 0.9, 0.42, 0.71, 1.7, 0, accentMat);
      }
      cubeBaseY = 4.1;
    } else {
      add(0.3, 0.5, 0.3, -0.5, 0.25, 0, this.bodyMat);
      add(0.3, 0.5, 0.3, 0.5, 0.25, 0, this.bodyMat);
      add(1.9, 1.3, 1.4, 0, 1.15, 0, this.bodyMat); // 0.5–1.8
      add(1.94, 0.35, 1.44, 0, 1.0, 0, accentMat); // waist band
      add(0.8, 0.55, 0.8, 0, 2.08, 0, this.bodyMat); // head
      add(0.55, 0.14, 0.08, 0, 2.12, 0.41, eyeMat); // eye
      if (hasAntenna) {
        const ant = new THREE.Mesh(this.cylGeo, this.bodyMat);
        ant.position.set(-0.25, 2.8, 0);
        ant.castShadow = shadows;
        group.add(ant);
        add(0.14, 0.14, 0.14, -0.25, 3.33, 0, this.tipMat);
      }
      if (hasPods) {
        add(0.45, 0.8, 0.45, -1.16, 1.1, 0, accentMat);
        add(0.45, 0.8, 0.45, 1.16, 1.1, 0, accentMat);
      }
      cubeBaseY = 3.2;
    }

    if (hasCube) {
      cubeMat = new THREE.MeshStandardMaterial({
        color: 0x2a2419,
        emissive: i % 2 === 0 ? 0xe8dcc0 : COLORS.moss,
        emissiveIntensity: 1.4,
        roughness: 0.5,
      });
      cube = add(0.5, 0.5, 0.5, 0, cubeBaseY, 0, cubeMat);
      cube.castShadow = false;
    }

    // Waypoint loop: terminal stops interleaved with plaza circuit points.
    const waypoints: Waypoint[] = [];
    const ringN = 12;
    for (let k = 0; k < ringN; k++) {
      if (k % 2 === 0) {
        const ti = (i + k / 2) % TERMINAL_DATA.length;
        const term = TERMINAL_DATA[ti];
        const dx = -term.x;
        const dz = -term.z;
        const dl = Math.hypot(dx, dz);
        waypoints.push({
          pos: new THREE.Vector3(term.x + (dx / dl) * 1.9, PLAZA_TOP, term.z + (dz / dl) * 1.9),
          terminal: ti,
        });
      } else {
        const a = (k / ringN) * Math.PI * 2 + i * 0.7;
        waypoints.push({
          pos: new THREE.Vector3(Math.cos(a) * 13, PLAZA_TOP, Math.sin(a) * 13),
          terminal: -1,
        });
      }
    }

    group.position.copy(waypoints[0].pos);
    const firstTarget = waypoints[1].pos;
    const yaw = Math.atan2(firstTarget.x - group.position.x, firstTarget.z - group.position.z);
    group.rotation.y = yaw;
    group.visible = false;
    this.root.add(group);

    return {
      group,
      eyeMat,
      accentMat,
      cubeMat,
      cube,
      cubeBaseY,
      cubePhase: rng() * Math.PI * 2,
      accent,
      waypoints,
      wpIndex: 1,
      state: 'walk',
      stateT: 0,
      yaw,
      birthT: APPEAR_T + i * 0.45, // staggered 46–50s
      bobPhase: rng() * Math.PI * 2,
    };
  }

  /** Reduced motion: agents stand still at terminal approach points. */
  private placeStatic(): void {
    this.agents.forEach((a, i) => {
      const term = TERMINAL_DATA[i % TERMINAL_DATA.length];
      const dx = -term.x;
      const dz = -term.z;
      const dl = Math.hypot(dx, dz);
      a.group.position.set(term.x + (dx / dl) * 1.9, PLAZA_TOP, term.z + (dz / dl) * 1.9);
      a.yaw = Math.atan2(dx, dz);
      a.group.rotation.y = a.yaw;
      a.group.scale.setScalar(1);
    });
  }

  private doPay(a: AgentRig): void {
    const wp = a.waypoints[a.wpIndex];
    if (wp.terminal < 0) return;
    const term = TERMINAL_DATA[wp.terminal];
    const from = a.group.position.clone().add(new THREE.Vector3(0, 2.6, 0));
    const to = new THREE.Vector3(term.x, term.topY, term.z);
    this.particles.spawnPulse(from, to, a.accent);
    // Amber flash sprite pop at the terminal top.
    const f = this.flashes.find((fl) => !fl.active) ?? this.flashes[0];
    f.active = true;
    f.t = 0;
    f.sprite.position.copy(to);
    f.sprite.visible = true;
  }

  private updateFlashes(dt: number): void {
    for (const f of this.flashes) {
      if (!f.active) continue;
      f.t += dt;
      const k = f.t / 0.45;
      if (k >= 1) {
        f.active = false;
        f.sprite.visible = false;
        continue;
      }
      const s = 0.4 + k * 2.2;
      f.sprite.scale.set(s, s, 1);
      f.mat.opacity = 0.9 * (1 - k);
    }
  }

  private updateAgent(a: AgentRig, dt: number, t: number): void {
    const g = a.group;
    if (a.state === 'walk') {
      const wp = a.waypoints[a.wpIndex];
      const dx = wp.pos.x - g.position.x;
      const dz = wp.pos.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.35) {
        if (wp.terminal >= 0) {
          a.state = 'pause';
          a.stateT = 0;
        } else {
          a.wpIndex = (a.wpIndex + 1) % a.waypoints.length;
        }
      } else {
        a.yaw = turnToward(a.yaw, Math.atan2(dx, dz), 6 * dt);
        g.rotation.y = a.yaw;
        const sp = WALK_SPEED * dt;
        g.position.x += Math.sin(a.yaw) * sp;
        g.position.z += Math.cos(a.yaw) * sp;
        g.position.y = PLAZA_TOP + Math.abs(Math.sin(t * 9 + a.bobPhase)) * 0.09;
        a.eyeMat.emissiveIntensity += (1.3 - a.eyeMat.emissiveIntensity) * Math.min(1, dt * 4);
      }
    } else if (a.state === 'pause') {
      a.stateT += dt;
      const term = TERMINAL_DATA[a.waypoints[a.wpIndex].terminal];
      a.yaw = turnToward(a.yaw, Math.atan2(term.x - g.position.x, term.z - g.position.z), 8 * dt);
      g.rotation.y = a.yaw;
      g.position.y += (PLAZA_TOP - g.position.y) * Math.min(1, dt * 6);
      a.eyeMat.emissiveIntensity += (2.8 - a.eyeMat.emissiveIntensity) * Math.min(1, dt * 5);
      if (a.stateT >= PAUSE_T) {
        a.state = 'pay';
        a.stateT = 0;
        this.doPay(a);
      }
    } else {
      // 'pay' — brief beat after the pulse + flash, then continue the loop.
      a.stateT += dt;
      if (a.stateT >= 0.6) {
        a.state = 'walk';
        a.wpIndex = (a.wpIndex + 1) % a.waypoints.length;
      }
    }
  }

  update(dt: number, t: number): void {
    if (t < APPEAR_T) return;
    this.updateFlashes(dt);
    for (const a of this.agents) {
      if (t < a.birthT) continue;
      a.group.visible = true;
      if (this.reduced) continue;
      // Staggered scale-in.
      const sk = Math.min(1, (t - a.birthT) / 0.9);
      if (sk < 1) {
        a.group.scale.setScalar(Math.max(0.001, easeOutBack(sk)));
      } else if (a.group.scale.x !== 1) {
        a.group.scale.setScalar(1);
      }
      this.updateAgent(a, dt, t);
      if (a.cube) {
        a.cube.position.y = a.cubeBaseY + Math.sin(t * 2.1 + a.cubePhase) * 0.12;
        a.cube.rotation.y += dt * 0.9;
      }
    }
  }

  dispose(): void {
    this.ctx.scene.remove(this.root);
    this.boxGeo.dispose();
    this.cylGeo.dispose();
    this.bodyMat.dispose();
    this.tipMat.dispose();
    for (const a of this.agents) {
      a.eyeMat.dispose();
      a.accentMat.dispose();
      if (a.cubeMat) a.cubeMat.dispose();
    }
    for (const f of this.flashes) f.mat.dispose();
  }
}
