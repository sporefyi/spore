import * as THREE from 'three';

export interface QualityTier { tier: 'high' | 'mobile'; particleMul: number; dpr: number; shadows: boolean; }
export interface LiveContext { scene: THREE.Scene; camera: THREE.PerspectiveCamera; quality: QualityTier; reducedMotion: boolean; }
export interface LiveModule { update(dt: number, t: number): void; dispose(): void; }
export interface ParticleSystem { spawnPulse(from: THREE.Vector3, to: THREE.Vector3, color: number): void; }
export interface ZoneInfo { id: string; label: string; anchor: THREE.Vector3; }
export interface ZoneEvents { onZoneActive?: (id: string) => void; }

export const PHASE = { DARKNESS: [0,12], MYCELIUM: [12,28], MARKET: [28,48], AGENTS: [48,64], ZONES: [64,84], MUSHROOM: [84,96], ACTIVATION: [96,108], LIVE: [108, Infinity] } as const;
export const PHASE_ORDER = ['DARKNESS','MYCELIUM','MARKET','AGENTS','ZONES','MUSHROOM','ACTIVATION','LIVE'] as const;
export type PhaseName = typeof PHASE_ORDER[number];

export function phaseAt(t: number): PhaseName { for (const p of PHASE_ORDER) { const [a,b] = PHASE[p]; if (t >= a && t < b) return p; } return 'LIVE'; }

export const COLORS = { bg: 0x14110d, ink: 0xf0e9da, muted: 0xa89f8d, moss: 0x8fae5a, fungal: 0xd9772b, ember: 0xc4644f, stone: 0x3a3733, stoneTop: 0x4e4a44, ivory: 0xece2c8 } as const;
