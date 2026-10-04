import * as THREE from 'three';

interface Keyframe {
  t: number;
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (u: number): number => {
  const c = clamp01(u);
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

function orbitPos(r: number, h: number, theta: number, out: THREE.Vector3): void {
  out.set(r * Math.sin(theta), h, r * Math.cos(theta));
}

/**
 * CinematicCamera — fully scripted, cut-free camera for the /live experience.
 *
 * An analytic pose function (one continuous, eased segment per timeline phase)
 * is sampled into a dense keyframe array at construction; update() interpolates
 * between keyframes with smoothstep easing so every move starts and ends gently.
 * Segment boundaries are pose-continuous by construction (cumulative theta,
 * matching radius/height/look at each join), so there are no jumps.
 *
 * Timeline (world units; market ground radius ~40, mushroom ~65 wide at center):
 *   0–12    close low push-in near center (0,6,26)->(0,4,22), look (0,4,0)
 *   12–28   low slow orbit around mycelium field (r~24, h~5)
 *   28–48   pull back + rise (r 24->55, h 5->26) revealing the market
 *   48–64   mid orbit through the market (r~45, h~16)
 *   64–84   wide panoramic orbit (r~60, h~24)
 *   84–96   glide toward center (r 60->38, h 24->18), look rises to the mushroom
 *   96–108  gentle orbit (r~44, h~22)
 *   108–116 eased pull-up to the final aerial pose (r 44->70, h 22->48)
 *   116+    high aerial (r~70, h~48, look (0,6,0)), ultra-slow drift orbit forever
 *
 * No shake, no cuts, no fast moves. Pointer parallax nudges the look target by
 * up to 1.5 world units (caller passes {0,0} on coarse-pointer devices).
 */
export class CinematicCamera {
  private readonly keys: Keyframe[] = [];
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpLook = new THREE.Vector3();
  private readonly sph = new THREE.Spherical();
  private userYaw = 0;
  private userPitch = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    for (let t = 0; t <= 120; t += 1) {
      const pos = new THREE.Vector3();
      const look = new THREE.Vector3();
      this.poseAt(t, pos, look);
      this.keys.push({ t, pos, look });
    }
  }

  update(t: number, _dt: number, pointer: { x: number; y: number }): void {
    this.sample(t, this.tmpPos, this.tmpLook);
    // Subtle cursor parallax: offset the look target by pointer * 1.5 units max.
    this.tmpLook.x += pointer.x * 1.5;
    this.tmpLook.y += pointer.y * 1.5;
    // User drag orbit: rotate the scripted pose around the look target.
    if (this.userYaw !== 0 || this.userPitch !== 0) {
      this.tmpPos.sub(this.tmpLook);
      this.sph.setFromVector3(this.tmpPos);
      this.sph.theta += this.userYaw;
      this.sph.phi = THREE.MathUtils.clamp(this.sph.phi + this.userPitch, 0.12, Math.PI - 0.12);
      this.tmpPos.setFromSpherical(this.sph).add(this.tmpLook);
    }
    this.camera.position.copy(this.tmpPos);
    this.camera.lookAt(this.tmpLook);
  }

  /** Additive drag orbit (radians). Persists until replay/skip reset it. */
  setUserOrbit(yaw: number, pitch: number): void {
    this.userYaw = yaw;
    this.userPitch = THREE.MathUtils.clamp(pitch, -0.35, 0.5);
  }

  /** Jump straight to the settled aerial pose (reduced-motion / skip). */
  snapToEnd(): void {
    // The 108–116s pull-up eases into the final aerial pose; snap past it.
    this.poseAt(116, this.tmpPos, this.tmpLook);
    this.camera.position.copy(this.tmpPos);
    this.camera.lookAt(this.tmpLook);
  }

  private sample(t: number, pos: THREE.Vector3, look: THREE.Vector3): void {
    const n = this.keys.length;
    if (t <= this.keys[0].t) {
      pos.copy(this.keys[0].pos);
      look.copy(this.keys[0].look);
      return;
    }
    const last = this.keys[n - 1];
    if (t >= last.t) {
      // Beyond the sampled range: the analytic pose drifts the aerial orbit forever.
      this.poseAt(t, pos, look);
      return;
    }
    for (let i = 0; i < n - 1; i++) {
      const a = this.keys[i];
      const b = this.keys[i + 1];
      if (t >= a.t && t <= b.t) {
        const u = smooth((t - a.t) / (b.t - a.t));
        pos.lerpVectors(a.pos, b.pos, u);
        look.lerpVectors(a.look, b.look, u);
        return;
      }
    }
  }

  /**
   * Analytic pose for any timeline time t. All segment boundaries are
   * C0-continuous (matching r/h/theta/look at each join); intra-segment
   * parameter ramps use smoothstep so motion eases in and out.
   */
  private poseAt(t: number, pos: THREE.Vector3, look: THREE.Vector3): void {
    if (t < 12) {
      // 0–12: close low shot, very slow push-in.
      const e = smooth(t / 12);
      pos.set(0, lerp(6, 4, e), lerp(26, 22, e));
      look.set(0, 4, 0);
    } else if (t < 28) {
      // 12–28: low slow orbit around the mycelium field.
      const u = (t - 12) / 16;
      const e = smooth(u);
      orbitPos(lerp(22, 24, e), lerp(4, 5, e), u * 1.0, pos);
      look.set(0, 4, 0);
    } else if (t < 48) {
      // 28–48: pull back + rise, revealing the market.
      const u = (t - 28) / 20;
      const e = smooth(u);
      orbitPos(lerp(24, 55, e), lerp(5, 26, e), 1.0 + u * 0.7, pos);
      look.set(0, lerp(4, 2, e), 0);
    } else if (t < 64) {
      // 48–64: mid orbit through the market, slow.
      const u = (t - 48) / 16;
      const e = smooth(u);
      orbitPos(lerp(55, 45, e), lerp(26, 16, e), 1.7 + u * 0.9, pos);
      look.set(0, lerp(2, 3, e), 0);
    } else if (t < 84) {
      // 64–84: wide panoramic orbit.
      const u = (t - 64) / 20;
      const e = smooth(u);
      orbitPos(lerp(45, 60, e), lerp(16, 24, e), 2.6 + u * 1.2, pos);
      look.set(0, lerp(3, 4, e), 0);
    } else if (t < 96) {
      // 84–96: glide toward the center, slightly lower, look at the mushroom.
      const u = (t - 84) / 12;
      const e = smooth(u);
      orbitPos(lerp(60, 38, e), lerp(24, 18, e), 3.8 + u * 0.5, pos);
      look.set(0, lerp(4, 8, e), 0);
    } else if (t < 108) {
      // 96–108: gentle orbit.
      const u = (t - 96) / 12;
      const e = smooth(u);
      orbitPos(lerp(38, 44, e), lerp(18, 22, e), 4.3 + u * 0.6, pos);
      look.set(0, lerp(8, 10, e), 0);
    } else if (t < 116) {
      // 108–116: eased pull-up into the final aerial pose (avoids a cut at 108).
      const u = (t - 108) / 8;
      const e = smooth(u);
      orbitPos(lerp(44, 70, e), lerp(22, 48, e), 4.9 + u * 0.12, pos);
      look.set(0, lerp(10, 6, e), 0);
    } else {
      // 116+: high aerial, ultra-slow drift orbit forever.
      orbitPos(70, 48, 5.02 + (t - 116) * 0.02, pos);
      look.set(0, 6, 0);
    }
  }
}
