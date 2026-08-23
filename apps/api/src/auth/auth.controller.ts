import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { Public, type AuthenticatedRequest } from './guards/access-token.guard';
import {
  loginSchema,
  refreshSchema,
  registerDeviceSchema,
  registerSchema,
  revokeSessionSchema,
} from './dto/auth.dto';
import { validate } from './dto/validate';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() body: unknown, @Req() request: Request) {
    const input = validate(registerSchema, body);
    await this.rateLimit.check(request, input.email);
    return this.auth.register(input, AuthController.contextOf(request));
  }

  @Public()
  @Post('login')
  async login(@Body() body: unknown, @Req() request: Request) {
    const input = validate(loginSchema, body);
    // Limited per IP *and* per email: per-IP alone lets a botnet spread an attack on one
    // account across many addresses; per-email alone lets one address try many accounts.
    await this.rateLimit.check(request, input.email);
    return this.auth.login(input, AuthController.contextOf(request));
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() body: unknown, @Req() request: Request) {
    const input = validate(refreshSchema, body);
    await this.rateLimit.check(request);
    return this.auth.refresh(input.refreshToken);
  }

  @Post('logout')
  async logout(@Req() request: AuthenticatedRequest) {
    await this.auth.logout(request.auth!.sessionId, request.auth!.userId);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() request: AuthenticatedRequest) {
    return this.auth.me(request.auth!.userId);
  }

  @Get('sessions')
  async sessions(@Req() request: AuthenticatedRequest) {
    const sessions = await this.auth.listSessions(request.auth!.userId);
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        current: session.id === request.auth!.sessionId,
        country: session.country,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
      })),
    };
  }

  @Post('sessions/revoke')
  async revokeSessions(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(revokeSessionSchema, body);
    if (input.all) {
      const revoked = await this.auth.logoutEverywhere(request.auth!.userId);
      return { revoked };
    }
    await this.auth.logout(input.sessionId ?? request.auth!.sessionId, request.auth!.userId);
    return { revoked: 1 };
  }

  @Post('devices')
  async registerDevice(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = validate(registerDeviceSchema, body);
    return this.auth.registerDevice(request.auth!.userId, input);
  }

  private static contextOf(request: Request) {
    return {
      ip: request.ip ?? null,
      // Geo scaffold: populated by the edge (Cloudflare-class header) where present.
      // Recorded now, enforced once licensing defines the rules (rule 13).
      country: (request.header('cf-ipcountry') ?? request.header('x-country') ?? null),
      userAgent: request.header('user-agent') ?? null,
    };
  }
}
