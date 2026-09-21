import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { ApiError } from './errors.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerImportRoutes } from './import-routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, base: { service: 'catalog-api' } },
    // Uploads are streamed, never buffered, so no body limit concerns here;
    // the multipart plugin enforces the real one.
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 20,
      fields: 10,
    },
    // We consume files as streams ourselves. Never let the plugin buffer them.
    attachFieldsToBody: false,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'bad_request',
          message: 'Request body failed validation',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    // Fastify's own errors (bad JSON, file too large, ...) carry a statusCode.
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    const status = typeof fastifyErr.statusCode === 'number' ? fastifyErr.statusCode : 500;

    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.status(500).send({
        error: { code: 'internal_error', message: 'Something went wrong' },
      });
    }

    return reply.status(status).send({
      error: {
        code: fastifyErr.code ?? 'request_error',
        message: fastifyErr.message ?? 'Request failed',
      },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'No such route' } });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  });

  await registerAuthRoutes(app);
  await registerImportRoutes(app);

  return app;
}
