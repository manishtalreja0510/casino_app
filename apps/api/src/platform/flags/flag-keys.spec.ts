import { FlagKey, gameEnabledKey, safeDefaultFor } from './flag-keys';

describe('flag safe defaults (rule 16: fail closed)', () => {
  it('defaults the compliance gate to OFF', () => {
    expect(safeDefaultFor(FlagKey.REAL_MONEY_ENABLED)).toBe(false);
  });

  it('defaults the interim direct-credit path to OFF (ADR-022)', () => {
    expect(safeDefaultFor(FlagKey.DEV_DIRECT_CREDIT)).toBe(false);
  });

  it('defaults maintenance mode to OFF so a flag outage is not a self-inflicted outage', () => {
    expect(safeDefaultFor(FlagKey.MAINTENANCE_MODE)).toBe(false);
  });

  it('defaults an unknown flag — including any per-game kill-switch — to OFF', () => {
    expect(safeDefaultFor('something.nobody.declared')).toBe(false);
    expect(safeDefaultFor(gameEnabledKey('poker'))).toBe(false);
  });

  it('builds per-game kill-switch keys', () => {
    expect(gameEnabledKey('poker')).toBe('game.poker.enabled');
  });
});
