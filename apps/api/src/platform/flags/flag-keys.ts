/**
 * The flag registry. Every flag declares the value it takes when the platform cannot
 * determine the real one — this is what "fail closed" means concretely (rule 16):
 * a flag lookup may cost availability, never safety.
 */
export const FlagKey = {
  /** Master compliance gate (rule 11). Safe value: OFF — no real money without a positive answer. */
  REAL_MONEY_ENABLED: 'compliance.real_money_enabled',
  /** Global kill-switch. Safe value: OFF, i.e. NOT in maintenance. */
  MAINTENANCE_MODE: 'platform.maintenance_mode',
  /** Interim direct-credit funding (ADR-022). Safe value: OFF. */
  DEV_DIRECT_CREDIT: 'payments.dev_direct_credit',
} as const;

export type FlagKeyValue = (typeof FlagKey)[keyof typeof FlagKey];

/** Per-game kill-switch key, e.g. `game.poker.enabled`. Safe value: OFF (game unavailable). */
export function gameEnabledKey(gameCode: string): string {
  return `game.${gameCode}.enabled`;
}

/**
 * Safe defaults used when the flag cannot be read.
 *
 * Note the asymmetry: an unknown gate is OFF (deny the capability), while an unknown
 * maintenance switch is also OFF (keep serving). Both choices are "fail safe" — for a
 * capability that means deny, for a kill-switch it means don't self-inflict an outage
 * because the cache blinked. Anything not listed defaults to `false`.
 */
export const SAFE_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  [FlagKey.REAL_MONEY_ENABLED]: false,
  [FlagKey.MAINTENANCE_MODE]: false,
  [FlagKey.DEV_DIRECT_CREDIT]: false,
});

export function safeDefaultFor(key: string): boolean {
  return SAFE_DEFAULTS[key] ?? false;
}
