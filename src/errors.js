// Errors that carry an HTTP status, so a handler can throw and the one error
// middleware decides what the caller sees.

export class PlatformError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message, detail) => new PlatformError(400, 'invalid_request', message, detail);
export const unauthorized = (message = 'Authentication required') => new PlatformError(401, 'unauthorized', message);
export const forbidden = (message, detail) => new PlatformError(403, 'forbidden', message, detail);
export const notFound = (message = 'Not found') => new PlatformError(404, 'not_found', message);
export const conflict = (message, detail) => new PlatformError(409, 'conflict', message, detail);
