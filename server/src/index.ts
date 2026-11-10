import { loadEnv, EnvError } from './config/env.js';
import { logger } from './config/logger.js';
import { buildServer } from './http/server.js';
import { createGateway } from './realtime/gateway.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './redis/client.js';
import { startWorkers, closeJobs } from './jobs/queues.js';
import { startScheduler, closeScheduler } from './jobs/scheduler.js';

async function main(): Promise<void> {
  // Validate configuration first; exit non-zero naming any missing variable (Req 1.5).
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      logger.error(`Configuration error: ${err.message}`);
      // eslint-disable-next-line no-console
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const app = await buildServer();
  const io = createGateway(app.server);
  startWorkers();
  await startScheduler();

  // HTTPS setup for local dev (camera/mic requires secure origin)
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  const protocol = app.server.constructor.name === 'Server' ? 'http' : 'https';
  logger.info({ port: env.PORT, protocol }, 'ChitChat backend listening');

  // Graceful shutdown: stop accepting connections, drain, close deps within 15s (Req 12.7).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const deadline = setTimeout(() => {
      logger.error('Shutdown timed out after 15s; forcing exit');
      process.exit(1);
    }, 15000);
    deadline.unref();

    try {
      io.close();
      await app.close();
      await Promise.all([closeJobs(), closeScheduler()]);
      await Promise.all([closePool(), closeRedis()]);
      clearTimeout(deadline);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
