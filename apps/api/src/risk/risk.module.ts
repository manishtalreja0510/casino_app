import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { RiskController } from './risk.controller';
import { RiskRepository } from './risk.repository';
import { RiskService } from './risk.service';

/**
 * Risk (P10).
 *
 * Depends on `auth` for the account-state write a freeze makes, and on nothing else.
 * Everything it knows about gameplay, money and devices arrives as **signals pushed in** by
 * the modules that observed them — it reads no other module's tables (rule 20), which is
 * also what stops the risk engine becoming a place that quietly knows everything.
 */
@Module({
  imports: [AuthModule],
  controllers: [RiskController],
  providers: [RiskService, RiskRepository],
  exports: [RiskService, RiskRepository],
})
export class RiskModule implements OnApplicationBootstrap {
  constructor(
    private readonly auth: AuthService,
    private readonly risk: RiskService,
  ) {}

  /**
   * Starts listening for sessions.
   *
   * The identity graph is built from logins, and this is where that subscription is made
   * rather than in `auth` — so the direction of dependency matches the direction of
   * interest, and a login never waits on scoring.
   */
  onApplicationBootstrap(): void {
    this.auth.onSessionStarted((event) => {
      void this.risk.observeSession({
        userId: event.userId,
        ...(event.deviceId ? { deviceId: event.deviceId } : {}),
        ...(event.ip ? { ip: event.ip } : {}),
      });
    });
  }
}
