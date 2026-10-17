import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/** Catch-all for unknown routes. Must be registered AFTER all real routes. */
export const notFound = (req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

/** Translate any thrown thing into { status, message, details }. */
const normalizeError = (err) => {
  if (err instanceof AppError) {
    return { status: err.statusCode, message: err.message, details: err.details };
  }
  // express.json() failures
  if (err.type === 'entity.parse.failed') {
    return { status: 400, message: 'Request body contains invalid JSON' };
  }
  if (err.type === 'entity.too.large') {
    return { status: 413, message: 'Request body is too large' };
  }
  // jsonwebtoken failures
  if (err.name === 'TokenExpiredError') {
    return { status: 401, message: 'Token has expired' };
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return { status: 401, message: 'Invalid token' };
  }
  // Anything else is a bug: don't leak internals.
  return { status: 500, message: 'Internal server error' };
};

// Express identifies error middleware by its 4 parameters. Keep all four.
export const errorHandler = (err, req, res, next) => {
  const { status, message, details } = normalizeError(err);

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  if (res.headersSent) return next(err);

  res.status(status).json({
    error: {
      message,
      ...(details && { details }),
      // Stack traces only outside production
      ...(status >= 500 && env.nodeEnv !== 'production' && { stack: err.stack }),
    },
  });
};
