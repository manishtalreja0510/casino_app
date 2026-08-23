import { Global, Module } from '@nestjs/common';
import { RateLimiter } from './rate-limit';

@Global()
@Module({
  providers: [RateLimiter],
  exports: [RateLimiter],
})
export class RateLimitModule {}
