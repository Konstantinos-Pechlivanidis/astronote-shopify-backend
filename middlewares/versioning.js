// API versioning middleware
export const apiVersioning = (req, res, next) => {
  // Extract version from header or URL
  const version =
    req.headers['api-version'] ||
    req.headers['accept-version'] ||
    req.query.version ||
    'v1';

  // Validate version format
  if (!/^v\d+$/.test(version)) {
    return res.status(400).json({
      error: 'invalid_version',
      message: 'API version must be in format v1, v2, etc.',
      supportedVersions: ['v1'],
    });
  }

  // Check if version is supported
  const supportedVersions = ['v1'];
  if (!supportedVersions.includes(version)) {
    return res.status(400).json({
      error: 'unsupported_version',
      message: `API version ${version} is not supported`,
      supportedVersions,
    });
  }

  // Add version to request object
  req.apiVersion = version;

  // Set version in response headers
  res.setHeader('API-Version', version);

  next();
};

// Version-specific route handler
export const versionedRoute = versions => {
  return (req, res, next) => {
    const version = req.apiVersion || 'v1';
    const handler = versions[version];

    if (!handler) {
      return res.status(400).json({
        error: 'version_not_implemented',
        message: `Handler for version ${version} not implemented`,
      });
    }

    handler(req, res, next);
  };
};

// Backward compatibility middleware
export const backwardCompatibility = (req, res, next) => {
  const version = req.apiVersion || 'v1';

  // Add version-specific transformations
  if (version === 'v1') {
    // Ensure backward compatibility for v1
    if (req.body && typeof req.body === 'object') {
      // Transform old field names to new ones if needed
      if (req.body.phone && !req.body.phoneE164) {
        req.body.phoneE164 = req.body.phone;
        delete req.body.phone;
      }
    }
  }

  next();
};

// Deprecation warning middleware
export const deprecationWarning = (deprecatedVersions = []) => {
  return (req, res, next) => {
    const version = req.apiVersion || 'v1';

    if (deprecatedVersions.includes(version)) {
      res.setHeader('Deprecation', 'true');
      res.setHeader(
        'Sunset',
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      ); // 1 year from now

      // Add warning to response
      const originalJson = res.json;
      res.json = function (data) {
        if (data && typeof data === 'object') {
          data._deprecation = {
            warning: `API version ${version} is deprecated`,
            sunset: new Date(
              Date.now() + 365 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            migrationGuide: 'https://docs.astronote.com/api/migration',
          };
        }
        return originalJson.call(this, data);
      };
    }

    next();
  };
};

// Version-specific response formatting
export const versionedResponse = (req, res, next) => {
  const version = req.apiVersion || 'v1';

  // Store original json method
  const originalJson = res.json;

  res.json = function (data) {
    if (version === 'v1') {
      // Ensure v1 response format
      if (data && typeof data === 'object') {
        // Add version-specific fields
        data.apiVersion = version;
        data.timestamp = new Date().toISOString();
      }
    }

    return originalJson.call(this, data);
  };

  next();
};
