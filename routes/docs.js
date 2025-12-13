import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import fs from 'fs';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const r = Router();

// Try to load OpenAPI spec, but don't fail if it doesn't exist
const openApiPath = join(__dirname, '..', 'openapi', 'openapi.yaml');

try {
  if (fs.existsSync(openApiPath)) {
    const file = fs.readFileSync(openApiPath, 'utf8');
    const spec = yaml.parse(file);
    r.use('/docs/api', swaggerUi.serve, swaggerUi.setup(spec));
    logger.info('OpenAPI documentation loaded', { path: openApiPath });
  } else {
    // If OpenAPI spec doesn't exist, provide a minimal placeholder
    logger.warn('OpenAPI spec not found, docs endpoint disabled', {
      path: openApiPath,
    });
    r.get('/docs/api', (req, res) => {
      res.json({
        message: 'API documentation not available',
        note: 'OpenAPI spec file not found',
        path: openApiPath,
      });
    });
  }
} catch (error) {
  // If there's an error loading the spec, provide a fallback
  logger.error('Error loading OpenAPI spec', {
    error: error.message,
    path: openApiPath,
  });
  r.get('/docs/api', (req, res) => {
    res.status(500).json({
      error: 'Failed to load API documentation',
      message: error.message,
    });
  });
}

export default r;
