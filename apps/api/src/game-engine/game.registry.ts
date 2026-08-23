import { Injectable, Logger } from '@nestjs/common';
import type { GameDefinition } from '@casino/contracts';

/**
 * Registry of installed games.
 *
 * A game is looked up by code and version: a match that started on version 3 continues to
 * be reduced by version 3 even after version 4 deploys, because changing the rules under a
 * match in flight would change outcomes players already acted on — and would break replay.
 */
@Injectable()
export class GameRegistry {
  private readonly logger = new Logger(GameRegistry.name);
  private readonly games = new Map<string, GameDefinition<never>>();

  register(definition: GameDefinition<never>): void {
    const key = GameRegistry.key(definition.meta.code, definition.meta.version);
    if (this.games.has(key)) throw new Error(`game ${key} is already registered`);
    this.games.set(key, definition);
    this.logger.log(`registered game ${definition.meta.code} v${definition.meta.version}`);
  }

  get(code: string, version: number): GameDefinition<never> {
    const definition = this.games.get(GameRegistry.key(code, version));
    if (!definition) {
      throw new Error(
        `game ${code} v${version} is not registered — an in-flight match cannot be reduced ` +
          'by a different version of its rules',
      );
    }
    return definition;
  }

  /** Latest registered version of a game, for creating new matches. */
  latest(code: string): GameDefinition<never> {
    const versions = [...this.games.values()]
      .filter((game) => game.meta.code === code)
      .sort((a, b) => b.meta.version - a.meta.version);
    const newest = versions[0];
    if (!newest) throw new Error(`game ${code} is not registered`);
    return newest;
  }

  list(): GameDefinition<never>[] {
    return [...this.games.values()];
  }

  private static key(code: string, version: number): string {
    return `${code}@${version}`;
  }
}
