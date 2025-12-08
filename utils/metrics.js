import { logger } from './logger.js';

class MetricsCollector {
  constructor() {
    this.metrics = new Map();
    this.counters = new Map();
    this.timers = new Map();
    this.gauges = new Map();
  }

  // Counter metrics
  incrementCounter(name, value = 1, labels = {}) {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);

    logger.debug(`Counter ${name} incremented`, {
      name,
      value,
      labels,
      total: current + value,
    });
  }

  getCounter(name, labels = {}) {
    const key = this.getMetricKey(name, labels);
    return this.counters.get(key) || 0;
  }

  // Timer metrics
  startTimer(name, labels = {}) {
    const key = this.getMetricKey(name, labels);
    this.timers.set(key, Date.now());
  }

  endTimer(name, labels = {}) {
    const key = this.getMetricKey(name, labels);
    const startTime = this.timers.get(key);

    if (startTime) {
      const duration = Date.now() - startTime;
      this.timers.delete(key);

      // Store in metrics for aggregation
      const metricKey = `${name}_duration`;
      const current = this.metrics.get(metricKey) || [];
      current.push(duration);
      this.metrics.set(metricKey, current);

      logger.debug(`Timer ${name} completed`, { name, duration, labels });
      return duration;
    }

    return null;
  }

  // Gauge metrics
  setGauge(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);

    logger.debug(`Gauge ${name} set`, { name, value, labels });
  }

  getGauge(name, labels = {}) {
    const key = this.getMetricKey(name, labels);
    return this.gauges.get(key) || 0;
  }

  // Business metrics
  recordSmsSent(shopId, campaignId, success = true) {
    this.incrementCounter('sms_sent_total', 1, {
      shop_id: shopId,
      campaign_id: campaignId,
      success,
    });

    if (success) {
      this.incrementCounter('sms_success_total', 1, { shop_id: shopId });
    } else {
      this.incrementCounter('sms_failed_total', 1, { shop_id: shopId });
    }
  }

  recordCampaignCreated(shopId, audience) {
    this.incrementCounter('campaigns_created_total', 1, {
      shop_id: shopId,
      audience,
    });
  }

  recordContactAdded(shopId, source = 'manual') {
    this.incrementCounter('contacts_added_total', 1, {
      shop_id: shopId,
      source,
    });
  }

  recordWalletTransaction(shopId, type, amount) {
    this.incrementCounter('wallet_transactions_total', 1, {
      shop_id: shopId,
      type,
    });
    this.incrementCounter('wallet_credits_total', amount, {
      shop_id: shopId,
      type,
    });
  }

  recordApiRequest(method, endpoint, statusCode, duration) {
    this.incrementCounter('api_requests_total', 1, {
      method,
      endpoint,
      status_code: statusCode.toString(),
      status_class: this.getStatusClass(statusCode),
    });

    this.incrementCounter('api_request_duration_total', duration, {
      method,
      endpoint,
    });
  }

  recordError(error, context = {}) {
    this.incrementCounter('errors_total', 1, {
      error_type: error.constructor.name,
      error_code: error.code || 'unknown',
      ...context,
    });
  }

  // Performance metrics
  recordDatabaseQuery(table, operation, duration, success = true) {
    this.incrementCounter('database_queries_total', 1, {
      table,
      operation,
      success: success.toString(),
    });

    this.incrementCounter('database_query_duration_total', duration, {
      table,
      operation,
    });
  }

  recordCacheHit(key, cacheType = 'memory') {
    this.incrementCounter('cache_hits_total', 1, { cache_type: cacheType });
  }

  recordCacheMiss(key, cacheType = 'memory') {
    this.incrementCounter('cache_misses_total', 1, { cache_type: cacheType });
  }

  recordQueueJob(queueName, jobType, success = true) {
    this.incrementCounter('queue_jobs_total', 1, {
      queue_name: queueName,
      job_type: jobType,
      success: success.toString(),
    });
  }

  // System metrics
  recordMemoryUsage() {
    const usage = process.memoryUsage();
    this.setGauge('memory_heap_used', usage.heapUsed);
    this.setGauge('memory_heap_total', usage.heapTotal);
    this.setGauge('memory_external', usage.external);
    this.setGauge('memory_rss', usage.rss);
  }

  recordCpuUsage() {
    const usage = process.cpuUsage();
    this.setGauge('cpu_user_time', usage.user);
    this.setGauge('cpu_system_time', usage.system);
  }

  // Utility methods
  getMetricKey(name, labels = {}) {
    const labelString = Object.keys(labels)
      .sort()
      .map(key => `${key}=${labels[key]}`)
      .join(',');

    return labelString ? `${name}{${labelString}}` : name;
  }

  getStatusClass(statusCode) {
    if (statusCode >= 200 && statusCode < 300) return '2xx';
    if (statusCode >= 300 && statusCode < 400) return '3xx';
    if (statusCode >= 400 && statusCode < 500) return '4xx';
    if (statusCode >= 500) return '5xx';
    return 'unknown';
  }

  // Get all metrics
  getAllMetrics() {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      metrics: Object.fromEntries(this.metrics),
      timestamp: new Date().toISOString(),
    };
  }

  // Reset metrics
  reset() {
    this.metrics.clear();
    this.counters.clear();
    this.timers.clear();
    this.gauges.clear();
  }

  // Export metrics in Prometheus format
  exportPrometheus() {
    let output = '';

    // Counters
    for (const [key, value] of this.counters) {
      output += `# TYPE ${key} counter\n`;
      output += `${key} ${value}\n`;
    }

    // Gauges
    for (const [key, value] of this.gauges) {
      output += `# TYPE ${key} gauge\n`;
      output += `${key} ${value}\n`;
    }

    return output;
  }
}

// Create singleton instance
export const metrics = new MetricsCollector();

// Auto-collect system metrics every 30 seconds
setInterval(() => {
  metrics.recordMemoryUsage();
  metrics.recordCpuUsage();
}, 30000);

// Metrics middleware
export const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const endpoint = req.route?.path || req.path;

    metrics.recordApiRequest(req.method, endpoint, res.statusCode, duration);
  });

  next();
};

// Database query metrics wrapper
export const withDatabaseMetrics = (operation, table) => {
  return async (...args) => {
    const startTime = Date.now();
    let success = true;

    try {
      const result = await operation(...args);
      return result;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      metrics.recordDatabaseQuery(table, operation.name, duration, success);
    }
  };
};
