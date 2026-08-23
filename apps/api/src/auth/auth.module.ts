import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RequestSigningService } from './request-signing.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AccessTokenGuard } from './guards/access-token.guard';
import { SignedRequestGuard } from './guards/signed-request.guard';

/**
 * Auth module (P3).
 *
 * Guards are registered globally so authentication is **deny-by-default**: a new
 * controller is protected the moment it exists, and making a route public requires the
 * explicit `@Public()` decorator. The opposite default — opt-in protection — is how
 * unauthenticated endpoints ship by accident.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordService,
    TokenService,
    RequestSigningService,
    AuthRateLimitService,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: SignedRequestGuard },
  ],
  exports: [AuthService, AuthRepository, TokenService, RequestSigningService],
})
export class AuthModule {}
