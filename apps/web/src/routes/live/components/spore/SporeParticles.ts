import * as THREE from 'three';
import { COLORS, PHASE, type LiveContext, type LiveModule, type ParticleSystem } from './types';

const PULSE_MAX = 240;
const PULSE_DUR = 0.9;
const BURST_LIFE = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft radial glow sprite (used for hero spore, pulses, burst). */
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx2d = c.getContext('2d');
  if (ctx2d) {
    const g = ctx2d.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

const AMBIENT_VERT = /* glsl */ `
attribute float aPhase;
attribute float aSize;
attribute vec3 aColor;
attribute float aDrift;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec3 p = position;
  float t = uTime;
  p.x += sin(t * 0.10 + aPhase) * 1.4;
  p.y += sin(t * 0.13 + aPhase * 1.7) * 0.9;
  p.z += cos(t * 0.09 + aPhase * 0.6) * 1.4;
  if (aDrift > 0.001) {
    // a few spores drift toward the camera, wrapping through the volume
    p.z = mod(p.z + t * aDrift + 30.0, 60.0) - 30.0;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uPixelRatio * (140.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const AMBIENT_FRAG = /* glsl */ `
varying vec3 vColor;
uniform float uOpacity;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.08, d);
  gl_FragColor = vec4(vColor, a * uOpacity);
}
`;

function smooth01(x: number): number {
  const k = THREE.MathUtils.clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
}

export class SporeParticles implements LiveModule, ParticleSystem {
  private readonly scene: THREE.Scene;
  private readonly reducedMotion: boolean;

  // ambient field
  private ambientPoints!: THREE.Points;
  private ambientGeo!: THREE.BufferGeometry;
  private ambientMat!: THREE.ShaderMaterial;
  private ambientT = 0;

  // hero spore + landing ring (phase 1)
  private hero!: THREE.Sprite;
  private heroMat!: THREE.SpriteMaterial;
  private heroTex!: THREE.CanvasTexture;
  private ring!: THREE.Mesh;
  private ringGeo!: THREE.RingGeometry;
  private ringMat!: THREE.MeshBasicMaterial;
  private readonly heroX = 2;
  private readonly heroZ = -3;

  // activation wave + burst (phase 7)
  private wave!: THREE.Mesh;
  private waveGeo!: THREE.RingGeometry;
  private waveMat!: THREE.MeshBasicMaterial;
  private burstPoints!: THREE.Points;
  private burstGeo!: THREE.BufferGeometry;
  private burstMat!: THREE.PointsMaterial;
  private burstPos: Float32Array = new Float32Array(0);
  private burstVel: Float32Array = new Float32Array(0);
  private burstCol: Float32Array = new Float32Array(0);
  private burstBase: Float32Array = new Float32Array(0);
  private burstCount = 0;
  private burstAge = 0;
  private burstFired = false;
  private burstActive = false;

  // pooled pulse particles (spawnPulse)
  private pulsePoints!: THREE.Points;
  private pulseGeo!: THREE.BufferGeometry;
  private pulseMat!: THREE.PointsMaterial;
  private pulseTex!: THREE.CanvasTexture;
  private pulsePos = new Float32Array(PULSE_MAX * 3);
  private pulseCol = new Float32Array(PULSE_MAX * 3);
  private pulseFrom = new Float32Array(PULSE_MAX * 3);
  private pulseTo = new Float32Array(PULSE_MAX * 3);
  private pulseBase = new Float32Array(PULSE_MAX * 3);
  private pulseT0 = new Float32Array(PULSE_MAX);
  private pulseAlive = new Array<boolean>(PULSE_MAX).fill(false);
  private pulseCursor = 0;
  private pulseClock = 0;

  constructor(ctx: LiveContext) {
    this.scene = ctx.scene;
    this.reducedMotion = ctx.reducedMotion;
    const pm = ctx.quality.particleMul;
    const pixelRatio = Math.min(ctx.quality.dpr, 2);
    const rng = mulberry32(99);
    const moss = new THREE.Color(COLORS.moss);
    const ivory = new THREE.Color(COLORS.ivory);
    const amber = new THREE.Color(COLORS.fungal);

    // ---------- ambient spore field ----------
    const ambientCount = Math.round(900 * pm);
    const aPos = new Float32Array(ambientCount * 3);
    const aPhase = new Float32Array(ambientCount);
    const aSize = new Float32Array(ambientCount);
    const aCol = new Float32Array(ambientCount * 3);
    const aDrift = new Float32Array(ambientCount);
    for (let i = 0; i < ambientCount; i++) {
      const drifter = rng() < 0.06;
      aPos[i * 3] = (rng() - 0.5) * 90;
      aPos[i * 3 + 1] = 0.5 + rng() * 27.5;
      aPos[i * 3 + 2] = drifter ? (rng() - 0.5) * 56 : (rng() - 0.5) * 90;
      aPhase[i] = rng() * Math.PI * 2;
      aSize[i] = 1.0 + rng() * 1.6;
      const pick = rng();
      const col = pick < 0.45 ? ivory : pick < 0.75 ? moss : amber;
      aCol[i * 3] = col.r;
      aCol[i * 3 + 1] = col.g;
      aCol[i * 3 + 2] = col.b;
      aDrift[i] = drifter ? 1.2 + rng() * 1.8 : 0;
    }
    this.ambientGeo = new THREE.BufferGeometry();
    this.ambientGeo.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
    this.ambientGeo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    this.ambientGeo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    this.ambientGeo.setAttribute('aColor', new THREE.BufferAttribute(aCol, 3));
    this.ambientGeo.setAttribute('aDrift', new THREE.BufferAttribute(aDrift, 1));
    this.ambientMat = new THREE.ShaderMaterial({
      vertexShader: AMBIENT_VERT,
      fragmentShader: AMBIENT_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.55 },
        uPixelRatio: { value: pixelRatio },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ambientPoints = new THREE.Points(this.ambientGeo, this.ambientMat);
    this.ambientPoints.frustumCulled = false;
    this.ambientPoints.renderOrder = 4;
    this.scene.add(this.ambientPoints);

    // ---------- hero spore + landing ring ----------
    this.heroTex = makeGlowTexture();
    this.heroMat = new THREE.SpriteMaterial({
      map: this.heroTex,
      color: COLORS.moss,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.hero = new THREE.Sprite(this.heroMat);
    this.hero.scale.set(3, 3, 1);
    this.hero.position.set(this.heroX, 26, this.heroZ);
    this.hero.visible = false;
    this.hero.renderOrder = 5;
    this.scene.add(this.hero);

    this.ringGeo = new THREE.RingGeometry(0.96, 1.0, 64);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: COLORS.moss,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(this.heroX, 0.18, this.heroZ);
    this.ring.visible = false;
    this.ring.renderOrder = 3;
    this.scene.add(this.ring);

    // ---------- activation wave ring ----------
    this.waveGeo = new THREE.RingGeometry(0.96, 1.0, 96);
    this.waveMat = new THREE.MeshBasicMaterial({
      color: COLORS.ivory,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.wave = new THREE.Mesh(this.waveGeo, this.waveMat);
    this.wave.rotation.x = -Math.PI / 2;
    this.wave.position.set(0, 0.22, 0);
    this.wave.visible = false;
    this.wave.renderOrder = 3;
    this.scene.add(this.wave);

    // ---------- activation burst ----------
    this.burstCount = Math.round(200 * pm);
    this.burstPos = new Float32Array(this.burstCount * 3);
    this.burstVel = new Float32Array(this.burstCount * 3);
    this.burstCol = new Float32Array(this.burstCount * 3);
    this.burstBase = new Float32Array(this.burstCount * 3);
    for (let i = 0; i < this.burstCount; i++) {
      this.burstPos[i * 3 + 1] = -999;
      const pick = rng();
      const col = pick < 0.4 ? ivory : pick < 0.7 ? moss : amber;
      this.burstBase[i * 3] = col.r;
      this.burstBase[i * 3 + 1] = col.g;
      this.burstBase[i * 3 + 2] = col.b;
    }
    this.burstGeo = new THREE.BufferGeometry();
    this.burstGeo.setAttribute('position', new THREE.BufferAttribute(this.burstPos, 3));
    this.burstGeo.setAttribute('color', new THREE.BufferAttribute(this.burstCol, 3));
    this.pulseTex = makeGlowTexture();
    this.burstMat = new THREE.PointsMaterial({
      size: 0.9,
      map: this.pulseTex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.burstPoints = new THREE.Points(this.burstGeo, this.burstMat);
    this.burstPoints.frustumCulled = false;
    this.burstPoints.renderOrder = 4;
    this.burstPoints.visible = false;
    this.scene.add(this.burstPoints);

    // ---------- pulse pool ----------
    for (let i = 0; i < PULSE_MAX; i++) {
      this.pulsePos[i * 3 + 1] = -999; // parked below the world
    }
    this.pulseGeo = new THREE.BufferGeometry();
    this.pulseGeo.setAttribute('position', new THREE.BufferAttribute(this.pulsePos, 3));
    this.pulseGeo.setAttribute('color', new THREE.BufferAttribute(this.pulseCol, 3));
    this.pulseMat = new THREE.PointsMaterial({
      size: 1.3,
      map: this.pulseTex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.pulsePoints = new THREE.Points(this.pulseGeo, this.pulseMat);
    this.pulsePoints.frustumCulled = false;
    this.pulsePoints.renderOrder = 5;
    this.pulsePoints.visible = false;
    this.scene.add(this.pulsePoints);
  }

  /** Pooled pulse: one additive point travelling from -> to over ~0.9s. */
  spawnPulse(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const i = this.pulseCursor;
    this.pulseCursor = (this.pulseCursor + 1) % PULSE_MAX;
    const j = i * 3;
    this.pulseFrom[j] = from.x;
    this.pulseFrom[j + 1] = from.y;
    this.pulseFrom[j + 2] = from.z;
    this.pulseTo[j] = to.x;
    this.pulseTo[j + 1] = to.y;
    this.pulseTo[j + 2] = to.z;
    const c = new THREE.Color(color);
    this.pulseBase[j] = c.r;
    this.pulseBase[j + 1] = c.g;
    this.pulseBase[j + 2] = c.b;
    this.pulseT0[i] = this.pulseClock;
    this.pulseAlive[i] = true;
    this.pulsePoints.visible = true;
  }

  private updateHero(t: number): void {
    if (this.reducedMotion) return;
    const LAND_T = 10;
    const RING_END = 12;
    if (t < LAND_T) {
      const k = THREE.MathUtils.clamp(t / LAND_T, 0, 1);
      const e = k * k; // easeIn descent
      this.hero.position.set(this.heroX, 26 + (1.5 - 26) * e, this.heroZ);
      this.heroMat.opacity = Math.min(1, Math.max(0, t / 1.2));
      this.hero.visible = this.heroMat.opacity > 0.01;
      this.ring.visible = false;
    } else if (t < RING_END) {
      const k = (t - LAND_T) / (RING_END - LAND_T);
      this.heroMat.opacity = 1 - k;
      this.hero.visible = this.heroMat.opacity > 0.01;
      const s = 0.5 + k * 8.5; // 0.5 -> 9
      this.ring.scale.set(s, s, s);
      this.ringMat.opacity = 0.75 * (1 - k);
      this.ring.visible = true;
    } else {
      this.hero.visible = false;
      this.ring.visible = false;
    }
  }

  private fireBurst(): void {
    const rng = mulberry32(2026);
    for (let i = 0; i < this.burstCount; i++) {
      const j = i * 3;
      const ang = rng() * Math.PI * 2;
      const r0 = 0.5 + rng() * 1.5;
      this.burstPos[j] = Math.cos(ang) * r0;
      this.burstPos[j + 1] = 0.5 + rng() * 2.5;
      this.burstPos[j + 2] = Math.sin(ang) * r0;
      const sp = 4 + rng() * 7;
      this.burstVel[j] = Math.cos(ang) * sp;
      this.burstVel[j + 1] = 2 + rng() * 4;
      this.burstVel[j + 2] = Math.sin(ang) * sp;
      this.burstCol[j] = this.burstBase[j];
      this.burstCol[j + 1] = this.burstBase[j + 1];
      this.burstCol[j + 2] = this.burstBase[j + 2];
    }
    this.burstAge = 0;
    this.burstFired = true;
    this.burstActive = true;
    this.burstPoints.visible = true;
    this.burstGeo.attributes.position.needsUpdate = true;
    this.burstGeo.attributes.color.needsUpdate = true;
  }

  private updateActivation(dt: number, t: number): void {
    if (this.reducedMotion) return;
    const a0 = PHASE.ACTIVATION[0];
    const a1 = PHASE.ACTIVATION[1];

    // expanding activation wave: radius 0 -> 55 over 96-108s
    if (t >= a0 && t <= a1) {
      const k = (t - a0) / (a1 - a0);
      const s = Math.max(0.001, k * 55);
      this.wave.scale.set(s, s, s);
      this.waveMat.opacity = 0.85 * Math.pow(1 - k, 1.4);
      this.wave.visible = true;
    } else {
      this.wave.visible = false;
    }

    // spore burst flying outward, life 96-104s
    if (!this.burstFired && t >= a0 && t < a0 + BURST_LIFE) {
      this.fireBurst();
    }
    if (this.burstActive) {
      this.burstAge += dt;
      if (this.burstAge >= BURST_LIFE) {
        this.burstActive = false;
        this.burstPoints.visible = false;
      } else {
        const fade = 1 - this.burstAge / BURST_LIFE;
        const f2 = fade * fade;
        for (let i = 0; i < this.burstCount; i++) {
          const j = i * 3;
          this.burstVel[j + 1] -= 2.5 * dt;
          this.burstPos[j] += this.burstVel[j] * dt;
          this.burstPos[j + 1] += this.burstVel[j + 1] * dt;
          this.burstPos[j + 2] += this.burstVel[j + 2] * dt;
          this.burstCol[j] = this.burstBase[j] * f2;
          this.burstCol[j + 1] = this.burstBase[j + 1] * f2;
          this.burstCol[j + 2] = this.burstBase[j + 2] * f2;
        }
        this.burstGeo.attributes.position.needsUpdate = true;
        this.burstGeo.attributes.color.needsUpdate = true;
      }
    }
  }

  private updatePulses(dt: number): void {
    this.pulseClock += dt;
    let anyAlive = false;
    for (let i = 0; i < PULSE_MAX; i++) {
      if (!this.pulseAlive[i]) continue;
      anyAlive = true;
      const k = (this.pulseClock - this.pulseT0[i]) / PULSE_DUR;
      const j = i * 3;
      if (k >= 1) {
        this.pulseAlive[i] = false;
        this.pulsePos[j + 1] = -999;
        this.pulseCol[j] = 0;
        this.pulseCol[j + 1] = 0;
        this.pulseCol[j + 2] = 0;
        continue;
      }
      // easeInOutCubic
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.pulsePos[j] = this.pulseFrom[j] + (this.pulseTo[j] - this.pulseFrom[j]) * e;
      this.pulsePos[j + 1] = this.pulseFrom[j + 1] + (this.pulseTo[j + 1] - this.pulseFrom[j + 1]) * e;
      this.pulsePos[j + 2] = this.pulseFrom[j + 2] + (this.pulseTo[j + 2] - this.pulseFrom[j + 2]) * e;
      // fade via color darkening (additive blending: black == invisible)
      const fade = smooth01(k / 0.12) * (1 - smooth01((k - 0.55) / 0.45));
      this.pulseCol[j] = this.pulseBase[j] * fade;
      this.pulseCol[j + 1] = this.pulseBase[j + 1] * fade;
      this.pulseCol[j + 2] = this.pulseBase[j + 2] * fade;
    }
    this.pulseGeo.attributes.position.needsUpdate = true;
    this.pulseGeo.attributes.color.needsUpdate = true;
    this.pulsePoints.visible = anyAlive;
  }

  update(dt: number, t: number): void {
    // ambient drift clock: near-static under reduced motion
    this.ambientT += dt * (this.reducedMotion ? 0.05 : 1);
    this.ambientMat.uniforms.uTime.value = this.ambientT;

    this.updateHero(t);
    this.updateActivation(dt, t);
    this.updatePulses(dt);
  }

  dispose(): void {
    this.scene.remove(this.ambientPoints);
    this.ambientGeo.dispose();
    this.ambientMat.dispose();
    this.scene.remove(this.hero);
    this.heroMat.dispose();
    this.heroTex.dispose();
    this.scene.remove(this.ring);
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.scene.remove(this.wave);
    this.waveGeo.dispose();
    this.waveMat.dispose();
    this.scene.remove(this.burstPoints);
    this.burstGeo.dispose();
    this.burstMat.dispose();
    this.scene.remove(this.pulsePoints);
    this.pulseGeo.dispose();
    this.pulseMat.dispose();
    this.pulseTex.dispose();
  }
}
