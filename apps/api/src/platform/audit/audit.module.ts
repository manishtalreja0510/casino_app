import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditChainService } from './audit-chain.service';

/**
 * Exported to every module: any sensitive action anywhere must be able to write here
 * (rule 15). The audit log is write-only by design — there is no update or delete API,
 * and the database rejects both.
 */
@Global()
@Module({
  providers: [AuditService, AuditChainService],
  exports: [AuditService, AuditChainService],
})
export class AuditModule {}
