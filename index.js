import dotenv from 'dotenv';
dotenv.config();
import app from './app.js';
import { logger } from './utils/logger.js';
import { validateAndLogEnvironment } from './config/env-validation.js';
import { closeRedisConnections } from './config/redis.js';
import './queue/worker.js'; // starts BullMQ worker
import {
  startPeriodicStatusUpdates,
  startScheduledCampaignsProcessor,
  startBirthdayAutomationScheduler,
} from './services/scheduler.js';
import { startEventPoller } from './workers/event-poller.js';

// Validate environment variables on startup
try {
  validateAndLogEnvironment();
} catch (error) {
  logger.error('Environment validation failed', {
    error: error.message,
  });
  process.exit(1);
}

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () => {
  logger.info('Server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
  });

  // Start periodic delivery status updates
  startPeriodicStatusUpdates();

  // Start scheduled campaigns processor
  startScheduledCampaignsProcessor();

  // Start event poller for automation triggers
  startEventPoller();

  // Start birthday automation scheduler (runs daily at midnight UTC)
  startBirthdayAutomationScheduler();
});

// Graceful shutdown handler
const gracefulShutdown = async signal => {
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new requests
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Close Redis connections
      await closeRedisConnections();

      // Close Prisma connection
      const prisma = (await import('./services/prisma.js')).default;
      await prisma.$disconnect();
      logger.info('Database connection closed');

      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown', { error: error.message });
      process.exit(1);
    }
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  gracefulShutdown('unhandledRejection');
});
