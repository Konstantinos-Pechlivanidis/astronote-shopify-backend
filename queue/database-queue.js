import prisma from '../services/prisma.js';
import { logger } from '../utils/logger.js';

/**
 * Database-Based Queue System
 *
 * Fallback queue implementation using PostgreSQL when Redis is unavailable.
 * This ensures the system can function without Redis dependency.
 */

class DatabaseQueue {
  constructor(queueName, options = {}) {
    this.queueName = queueName;
    this.options = {
      concurrency: options.concurrency || 5,
      removeOnComplete: options.removeOnComplete || 100,
      removeOnFail: options.removeOnFail || 50,
      attempts: options.attempts || 3,
      backoff: options.backoff || { type: 'exponential', delay: 2000 },
      ...options,
    };
    this.isProcessing = false;
    this.pollInterval = 1000; // Poll every second
    this.pollTimer = null;
  }

  /**
   * Add job to queue
   */
  async add(jobName, data, options = {}) {
    try {
      const job = await prisma.queueJob.create({
        data: {
          queueName: this.queueName,
          jobName,
          data: JSON.stringify(data),
          status: 'pending',
          attempts: 0,
          maxAttempts: options.attempts || this.options.attempts,
          priority: options.priority || 0,
          delay: options.delay ? new Date(Date.now() + options.delay) : null,
        },
      });

      logger.info('Job added to database queue', {
        queueName: this.queueName,
        jobId: job.id,
        jobName,
      });

      // Start processing if not already running
      if (!this.isProcessing) {
        this.startProcessing();
      }

      return { id: job.id, ...job };
    } catch (error) {
      logger.error('Failed to add job to database queue', {
        queueName: this.queueName,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Start processing jobs
   */
  async startProcessing() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    logger.info('Database queue processor started', {
      queueName: this.queueName,
    });

    // Process jobs immediately
    await this.processJobs();

    // Set up polling interval
    this.pollTimer = setInterval(async () => {
      await this.processJobs();
    }, this.pollInterval);
  }

  /**
   * Stop processing jobs
   */
  async stopProcessing() {
    this.isProcessing = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Database queue processor stopped', {
      queueName: this.queueName,
    });
  }

  /**
   * Process pending jobs
   */
  async processJobs() {
    if (!this.isProcessing) {
      return;
    }

    try {
      // Get pending jobs (respecting delay and priority)
      const jobs = await prisma.queueJob.findMany({
        where: {
          queueName: this.queueName,
          status: 'pending',
          OR: [{ delay: null }, { delay: { lte: new Date() } }],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: this.options.concurrency,
      });

      if (jobs.length === 0) {
        return;
      }

      // Process jobs concurrently
      const processingPromises = jobs.map(job => this.processJob(job));
      await Promise.allSettled(processingPromises);
    } catch (error) {
      logger.error('Error processing database queue jobs', {
        queueName: this.queueName,
        error: error.message,
      });
    }
  }

  /**
   * Process a single job
   */
  async processJob(job) {
    try {
      // Update job status to processing
      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: 'processing',
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });

      logger.info('Processing database queue job', {
        queueName: this.queueName,
        jobId: job.id,
        jobName: job.jobName,
        attempt: job.attempts + 1,
      });

      // Execute job handler (this should be set by the queue consumer)
      if (!this.handler) {
        throw new Error('No handler registered for this queue');
      }

      const jobData = JSON.parse(job.data);
      const result = await this.handler({ id: job.id, data: jobData });

      // Mark job as completed
      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          result: JSON.stringify(result),
        },
      });

      logger.info('Database queue job completed', {
        queueName: this.queueName,
        jobId: job.id,
      });

      // Cleanup old completed jobs
      await this.cleanupCompletedJobs();

      return result;
    } catch (error) {
      logger.error('Database queue job failed', {
        queueName: this.queueName,
        jobId: job.id,
        error: error.message,
      });

      // Check if job should be retried
      const shouldRetry = job.attempts < job.maxAttempts;

      if (shouldRetry) {
        // Calculate backoff delay
        const backoffDelay = this.calculateBackoff(job.attempts);

        await prisma.queueJob.update({
          where: { id: job.id },
          data: {
            status: 'pending',
            delay: new Date(Date.now() + backoffDelay),
            error: error.message,
          },
        });

        logger.info('Database queue job scheduled for retry', {
          queueName: this.queueName,
          jobId: job.id,
          attempt: job.attempts + 1,
          delay: backoffDelay,
        });
      } else {
        // Mark job as failed
        await prisma.queueJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            failedAt: new Date(),
            error: error.message,
          },
        });

        logger.error('Database queue job failed permanently', {
          queueName: this.queueName,
          jobId: job.id,
          attempts: job.attempts,
        });

        // Cleanup old failed jobs
        await this.cleanupFailedJobs();
      }

      throw error;
    }
  }

  /**
   * Calculate backoff delay
   */
  calculateBackoff(attempt) {
    const backoff = this.options.backoff;

    if (backoff.type === 'exponential') {
      return Math.min(backoff.delay * Math.pow(2, attempt), 60000); // Max 1 minute
    } else if (backoff.type === 'fixed') {
      return backoff.delay;
    }

    return 2000; // Default 2 seconds
  }

  /**
   * Register job handler
   */
  process(handler) {
    this.handler = handler;
    this.startProcessing();
    return this;
  }

  /**
   * Get job status
   */
  async getJob(jobId) {
    return await prisma.queueJob.findUnique({
      where: { id: jobId },
    });
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    const stats = await prisma.queueJob.groupBy({
      by: ['status'],
      where: { queueName: this.queueName },
      _count: true,
    });

    return {
      pending: stats.find(s => s.status === 'pending')?._count || 0,
      processing: stats.find(s => s.status === 'processing')?._count || 0,
      completed: stats.find(s => s.status === 'completed')?._count || 0,
      failed: stats.find(s => s.status === 'failed')?._count || 0,
    };
  }

  /**
   * Cleanup old completed jobs
   */
  async cleanupCompletedJobs() {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7); // Keep for 7 days

      const result = await prisma.queueJob.deleteMany({
        where: {
          queueName: this.queueName,
          status: 'completed',
          completedAt: { lt: cutoffDate },
        },
      });

      if (result.count > 0) {
        logger.debug('Cleaned up old completed jobs', {
          queueName: this.queueName,
          count: result.count,
        });
      }
    } catch (error) {
      logger.error('Error cleaning up completed jobs', {
        queueName: this.queueName,
        error: error.message,
      });
    }
  }

  /**
   * Cleanup old failed jobs
   */
  async cleanupFailedJobs() {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30); // Keep for 30 days

      const result = await prisma.queueJob.deleteMany({
        where: {
          queueName: this.queueName,
          status: 'failed',
          failedAt: { lt: cutoffDate },
        },
      });

      if (result.count > 0) {
        logger.debug('Cleaned up old failed jobs', {
          queueName: this.queueName,
          count: result.count,
        });
      }
    } catch (error) {
      logger.error('Error cleaning up failed jobs', {
        queueName: this.queueName,
        error: error.message,
      });
    }
  }

  /**
   * Remove job
   */
  async remove(jobId) {
    try {
      await prisma.queueJob.delete({
        where: { id: jobId },
      });
      logger.info('Job removed from database queue', {
        queueName: this.queueName,
        jobId,
      });
    } catch (error) {
      logger.error('Error removing job from database queue', {
        queueName: this.queueName,
        jobId,
        error: error.message,
      });
      throw error;
    }
  }
}

/**
 * Create database queue instance
 */
export function createDatabaseQueue(queueName, options = {}) {
  return new DatabaseQueue(queueName, options);
}

/**
 * Database queue instances (matching BullMQ queue names)
 */
export const databaseSmsQueue = createDatabaseQueue('sms-send', {
  concurrency: 20,
  removeOnComplete: 100,
  removeOnFail: 50,
  attempts: 3,
});

export const databaseCampaignQueue = createDatabaseQueue('campaign-send', {
  concurrency: 5,
  removeOnComplete: 50,
  removeOnFail: 25,
  attempts: 2,
});

export const databaseAutomationQueue = createDatabaseQueue(
  'automation-trigger',
  {
    concurrency: 10,
    removeOnComplete: 200,
    removeOnFail: 100,
    attempts: 2,
  },
);

export default {
  createDatabaseQueue,
  databaseSmsQueue,
  databaseCampaignQueue,
  databaseAutomationQueue,
};
