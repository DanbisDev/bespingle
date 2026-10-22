import type { LoadLevel } from './deviceLoad';

// Heavy load must last this long before each further step down.
export const downHold = 5_000;
// Normal load must last this long before each step back up. It is long because
// stepping down eases the encoder, which would otherwise invite a step up.
export const upHold = 20_000;
// A step down this soon after a step up means the step up brought the load
// back. The next step up then waits twice as long, up to the longest hold.
export const probeWindow = 30_000;
export const longestUpHold = 160_000;

// Turns the load level over time into the quality policy's load steps: how
// many rungs below the count-driven starting point to go. It moves one rung
// per hold and only on a level that held for the whole hold, so a flapping
// signal changes nothing. Elevated load holds quality where it is.
export class LoadStepper {
  steps = 0;
  private heavySince: number | null = null;
  private normalSince: number | null = null;
  private hold = upHold;
  private lastUp: number | null = null;

  // `headroom` is how many rungs the policy can still go below its starting
  // point. Zero, as in a manual setting, ends any step-down at once.
  update(level: LoadLevel, now: number, headroom: number): number {
    this.steps = Math.min(this.steps, Math.max(0, headroom));
    if (level !== 'heavy') this.heavySince = null;
    if (level !== 'normal') this.normalSince = null;
    // A step up that stood through the probe window was right; back off no more.
    if (this.lastUp !== null && now - this.lastUp >= probeWindow) { this.lastUp = null; this.hold = upHold; }
    if (level === 'heavy') {
      this.heavySince ??= now;
      if (now - this.heavySince >= downHold && this.steps < headroom) {
        this.steps += 1;
        this.heavySince = now;
        if (this.lastUp !== null) { this.hold = Math.min(longestUpHold, this.hold * 2); this.lastUp = null; }
      }
    } else if (level === 'normal') {
      this.normalSince ??= now;
      if (now - this.normalSince >= this.hold && this.steps > 0) {
        this.steps -= 1;
        this.normalSince = now;
        this.lastUp = now;
      }
    }
    return this.steps;
  }
}
