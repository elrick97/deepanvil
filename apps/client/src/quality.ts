// Adaptive quality tiers. Phones start lower; any device steps down if frames run long.

export type Tier = 'high' | 'medium' | 'low';

export interface QualitySettings {
  tier: Tier;
  maxDpr: number;
  shadows: boolean;
  motes: number;
  bloomStrength: number;
  /** Kuwahara brushstroke post-filter (expensive: desktop only). */
  brushstrokes: boolean;
}

const TIERS: Record<Tier, QualitySettings> = {
  high: { tier: 'high', maxDpr: 2, shadows: true, motes: 320, bloomStrength: 1.4, brushstrokes: true },
  medium: { tier: 'medium', maxDpr: 1.5, shadows: true, motes: 200, bloomStrength: 1.2, brushstrokes: false },
  low: { tier: 'low', maxDpr: 1, shadows: false, motes: 90, bloomStrength: 1.0, brushstrokes: false },
};

export const isTouchDevice = matchMedia('(pointer: coarse)').matches;

export function initialQuality(): QualitySettings {
  const forced = new URLSearchParams(location.search).get('q') as Tier | null;
  if (forced && forced in TIERS) return TIERS[forced];
  return TIERS[isTouchDevice ? 'medium' : 'high'];
}

/** Watches frame times and lowers the pixel ratio when the device is struggling. */
export class FrameGovernor {
  private samples: number[] = [];
  private cooldown = 0;
  private maxDpr: number;
  private onDprChange: (dpr: number) => void;
  dpr: number;
  fps = 60;

  constructor(maxDpr: number, onDprChange: (dpr: number) => void) {
    this.maxDpr = maxDpr;
    this.onDprChange = onDprChange;
    this.dpr = Math.min(devicePixelRatio, maxDpr);
  }

  tick(dt: number): void {
    this.samples.push(dt);
    if (this.samples.length < 90) return;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples.length = 0;
    this.fps = Math.round(1 / avg);
    if (this.cooldown-- > 0) return;
    if (avg > 1 / 40 && this.dpr > 0.75) {
      this.dpr = Math.max(0.75, this.dpr - 0.25);
      this.onDprChange(this.dpr);
      this.cooldown = 2;
    } else if (avg < 1 / 58 && this.dpr < Math.min(devicePixelRatio, this.maxDpr)) {
      this.dpr = Math.min(this.maxDpr, this.dpr + 0.25);
      this.onDprChange(this.dpr);
      this.cooldown = 4;
    }
  }
}
