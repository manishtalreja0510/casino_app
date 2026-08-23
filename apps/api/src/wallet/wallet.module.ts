import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletRepository } from './wallet.repository';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';
import { AuthModule } from '../auth/auth.module';
import { RgModule } from '../responsible-gaming/rg.module';
import { RiskModule } from '../risk/risk.module';

/**
 * Wallet module (P4). Exports `WalletService` only — the ledger primitive stays internal,
 * so no other module can post entries without going through a domain operation (rule 10).
 *
 * From P10 it imports responsible gaming, because that is where enforcement lives
 * (ADR-026): every path that moves a player's money asks first, so no game has to
 * remember to.
 */
@Module({
  imports: [AuthModule, RgModule, RiskModule],
  controllers: [WalletController],
  providers: [WalletService, WalletRepository, LedgerService, ReconciliationService],
  exports: [WalletService, ReconciliationService],
})
export class WalletModule {}
