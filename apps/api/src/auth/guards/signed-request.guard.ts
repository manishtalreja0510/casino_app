import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthRepository } from '../auth.repository';
import { RequestSigningService } from '../request-signing.service';
import { DeviceUntrustedError, SignatureInvalidError } from '../auth.errors';
import type { AuthenticatedRequest } from './access-token.guard';

export const REQUIRES_SIGNATURE = 'requiresSignature';

/**
 * Marks a route as financial-class: it must additionally carry a device signature
 * (ADR-013). Applied to money-moving endpoints from P4 onward.
 */
export const SignedRequest = (): MethodDecorator => SetMetadata(REQUIRES_SIGNATURE, true);

@Injectable()
export class SignedRequestGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly signing: RequestSigningService,
    private readonly repository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRES_SIGNATURE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const deviceId = request.auth?.deviceId;
    if (!deviceId) throw new DeviceUntrustedError();

    const device = await this.repository.findDevice(deviceId);
    // The device must still belong to this user: a token naming someone else's device
    // must not be able to borrow its key.
    if (!device || device.userId !== request.auth?.userId) throw new DeviceUntrustedError();

    const signature = request.header('x-signature');
    const timestamp = request.header('x-timestamp');
    const nonce = request.header('x-nonce');
    if (!signature || !timestamp || !nonce) throw new SignatureInvalidError('missing_headers');

    const result = await this.signing.verify({
      method: request.method,
      path: request.originalUrl.split('?')[0] ?? request.path,
      body: request.body === undefined ? '' : JSON.stringify(request.body),
      timestamp,
      nonce,
      signature,
      devicePublicKey: device.publicKey,
    });

    if (!result.ok) throw new SignatureInvalidError(result.reason);
    return true;
  }
}
