import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export const TRACE_ID_HEADER = 'x-trace-id';

/**
 * Assigns each request a trace id, echoed in the response header and included in both
 * the error envelope and every log line for the request. It is the only correlation
 * handle a client gets — deliberately opaque, so support can find the server-side
 * detail without anything sensitive crossing the wire.
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request & { traceId?: string }, res: Response, next: NextFunction): void {
    // An inbound trace id is accepted only from our own edge; treat client-supplied
    // values as untrusted and generate our own (rule 1).
    const traceId = randomUUID();
    req.traceId = traceId;
    res.setHeader(TRACE_ID_HEADER, traceId);
    next();
  }
}
