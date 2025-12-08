/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

// Enhanced logger with structured logging
class Logger {
  constructor() {
    this.logDir = process.env.LOG_DIR || './logs';
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  formatLog(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...meta,
    };

    return JSON.stringify(logEntry);
  }

  writeToFile(filename, logEntry) {
    const filePath = path.join(this.logDir, filename);
    fs.appendFileSync(filePath, `${logEntry}\n`);
  }

  info(message, meta = {}) {
    const logEntry = this.formatLog('INFO', message, meta);
    console.log(`[INFO] ${message}`, meta);
    this.writeToFile('app.log', logEntry);
  }

  warn(message, meta = {}) {
    const logEntry = this.formatLog('WARN', message, meta);
    console.warn(`[WARN] ${message}`, meta);
    this.writeToFile('app.log', logEntry);
  }

  error(message, meta = {}) {
    const logEntry = this.formatLog('ERROR', message, meta);
    console.error(`[ERROR] ${message}`, meta);
    this.writeToFile('error.log', logEntry);
  }

  debug(message, meta = {}) {
    if (process.env.NODE_ENV === 'development') {
      const logEntry = this.formatLog('DEBUG', message, meta);
      console.debug(`[DEBUG] ${message}`, meta);
      this.writeToFile('debug.log', logEntry);
    }
  }

  // Request logging
  logRequest(req, res, responseTime) {
    const meta = {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      requestId: req.id,
    };

    if (res.statusCode >= 400) {
      this.error(`HTTP ${res.statusCode}`, meta);
    } else {
      this.info(`HTTP ${res.statusCode}`, meta);
    }
  }

  // Security logging
  logSecurity(event, req, details = {}) {
    const meta = {
      event,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl,
      method: req.method,
      ...details,
    };

    this.warn(`Security event: ${event}`, meta);
    this.writeToFile(
      'security.log',
      this.formatLog('WARN', `Security: ${event}`, meta),
    );
  }

  // Performance logging
  logPerformance(operation, duration, meta = {}) {
    const logEntry = this.formatLog('PERF', `Operation: ${operation}`, {
      duration: `${duration}ms`,
      ...meta,
    });

    console.log(`[PERF] ${operation}: ${duration}ms`);
    this.writeToFile('performance.log', logEntry);
  }

  // Business logic logging
  logBusiness(event, shopId, details = {}) {
    const meta = {
      event,
      shopId,
      timestamp: new Date().toISOString(),
      ...details,
    };

    this.info(`Business event: ${event}`, meta);
    this.writeToFile(
      'business.log',
      this.formatLog('INFO', `Business: ${event}`, meta),
    );
  }
}

// Create singleton instance
export const logger = new Logger();

// Request ID middleware
export const requestId = (req, res, next) => {
  req.id =
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  res.setHeader('X-Request-ID', req.id);
  next();
};

// Performance monitoring middleware
export const performanceMonitor = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.logRequest(req, res, duration);

    // Log slow requests
    if (duration > 1000) {
      logger.warn('Slow request detected', {
        method: req.method,
        url: req.originalUrl,
        duration: `${duration}ms`,
        requestId: req.id,
      });
    }
  });

  next();
};

// Security monitoring middleware
export const securityMonitor = (req, res, next) => {
  // Check for suspicious patterns
  const suspiciousPatterns = [
    /\.\./, // Directory traversal
    /<script/i, // XSS attempts
    /union.*select/i, // SQL injection
    /javascript:/i, // JavaScript injection
    /eval\(/i, // Code injection
    /exec\(/i, // Command injection
  ];

  const url = req.originalUrl;
  const body = JSON.stringify(req.body || {});
  const query = JSON.stringify(req.query || {});

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(url) || pattern.test(body) || pattern.test(query)) {
      logger.logSecurity('Suspicious request pattern detected', req, {
        pattern: pattern.toString(),
        url,
        body: body.substring(0, 200), // Limit body size in logs
        query,
      });

      return res.status(400).json({
        error: 'suspicious_request',
        message: 'Request contains potentially malicious content',
      });
    }
  }

  next();
};
