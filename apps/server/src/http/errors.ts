import {
  ERROR_STATUS,
  type ApiErrorBody,
  type ErrorCode,
  type ErrorDetail,
} from '@wikistow/contracts';
import type { Context, ErrorHandler } from 'hono';
import type { Log } from './logger.ts';

type Issue = NonNullable<ApiErrorBody['error']['issues']>[number];

/** Throw from any handler to send a typed error response. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly issues: Issue[] | undefined;
  readonly detail: ErrorDetail;

  constructor(code: ErrorCode, message: string, issues?: Issue[], detail: ErrorDetail = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.issues = issues;
    this.detail = detail;
  }
}

export function errorResponse(c: Context, error: ApiError): Response {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
      ...(Object.keys(error.detail).length > 0 ? { detail: error.detail } : {}),
    },
  };
  return c.json(body, ERROR_STATUS[error.code]);
}

/** Unexpected errors become a bare `internal` response; only the error's name is logged. */
export function onError(log: Log): ErrorHandler {
  return (error, c) => {
    if (error instanceof ApiError) return errorResponse(c, error);
    log({ level: 'error', event: 'unhandled-error', route: c.req.routePath, name: error.name });
    return errorResponse(c, new ApiError('internal', 'Something went wrong'));
  };
}
