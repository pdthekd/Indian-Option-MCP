/**
 * @module risk/kill-switch
 * Latching kill switch. Once engaged it stays engaged until a human resets it
 * with an explicit confirmation phrase; nothing else can clear it.
 */

import type { Journal } from '../broker/journal.js';

export const KILL_SWITCH_RESET_PHRASE = 'I have reviewed the incident and re-enable trading';

export class KillSwitch {
  private engaged = false;
  private reason: string | null = null;

  constructor(private readonly journal?: Journal) {}

  engage(reason: string): void {
    if (this.engaged) return;
    this.engaged = true;
    this.reason = reason;
    this.journal?.append('KILL_SWITCH_ENGAGED', { reason });
  }

  isEngaged(): boolean {
    return this.engaged;
  }

  getReason(): string | null {
    return this.reason;
  }

  /** Human-only reset. */
  reset(confirmation: string, operator: string): void {
    if (confirmation !== KILL_SWITCH_RESET_PHRASE) throw new Error('Kill switch reset requires the exact confirmation phrase');
    if (!operator.trim()) throw new Error('Operator identity required');
    this.journal?.append('KILL_SWITCH_RESET', { operator, previousReason: this.reason });
    this.engaged = false;
    this.reason = null;
  }
}
