import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletRepository } from './wallet.repository';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Wallet module (P4). Exports `WalletService` only — the ledger primitive stays internal,
 * so no other module can post entries without going through a domain operation (rule 10).
 */
@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [WalletService, WalletRepository, LedgerService, ReconciliationService],
  exports: [WalletService, ReconciliationService],
})
export class WalletModule {}
