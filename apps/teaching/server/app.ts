import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { errorDefinitions } from '../contracts/common/http.ts';
import { ApiError, errorResponse } from './app/errors.ts';

export interface AppOptions {
  logDestination?: { write(message: string): void };
}

export function createApp(options: AppOptions = {}) {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    logger: options.logDestination ? {
      stream: options.logDestination,
      serializers: {
        err: () => ({ type: 'Error', message: 'Internal failure.', stack: '' }),
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
    } : false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((error, request, reply) => {
    const frameworkCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const code = error instanceof ApiError ? error.code
      : frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'CONTENT_LIMIT'
      : frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || frameworkCode === 'FST_ERR_CTP_EMPTY_JSON_BODY'
        || frameworkCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || frameworkCode === 'FST_ERR_VALIDATION'
        ? 'INVALID_REQUEST' : 'DEPENDENCY_UNAVAILABLE';
    if (!(error instanceof ApiError) && code === 'DEPENDENCY_UNAVAILABLE') {
      request.log.error({ requestId: request.id, errorCode: code }, 'Request failed.');
    }
    reply.code(errorDefinitions[code].status).send(errorResponse(request.id, code));
  });

  app.setNotFoundHandler(async () => {
    throw new ApiError('INVALID_REQUEST');
  });

  app.get('/health/ready', async () => {
    throw new ApiError('DEPENDENCY_UNAVAILABLE');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.get('/health/live', async (request) => ({
    requestId: request.id,
    data: { status: 'alive' },
  }));

  return app;
}
