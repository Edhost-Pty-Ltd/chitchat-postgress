import type { FastifyInstance } from 'fastify';
import { pingPostgres } from '../../db/pool.js';
import { pingRedis } from '../../redis/client.js';

/**
 * GET /health — 200 when Postgres and Redis both respond; 503 naming the
 * failing dependency otherwise (Req 1.8, 1.9).
 */
export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([pingPostgres(), pingRedis()]);
    const dependencies = { postgres, redis };

    if (postgres && redis) {
      return reply.code(200).send({ status: 'ok', dependencies });
    }

    const failing = Object.entries(dependencies)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    return reply.code(503).send({
      status: 'unavailable',
      failing,
      dependencies,
    });
  });
}
