import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<
      Request & { user?: { id?: number; email?: string } }
    >();
    const response = ctx.getResponse();

    let status: number;
    let body: { statusCode: number; message: string; error?: string };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null && 'message' in res) {
        const o = res as {
          statusCode?: number;
          message?: string;
          error?: string;
        };
        body = {
          statusCode: o.statusCode ?? status,
          message: o.message ?? 'Error',
          ...(o.error != null && { error: o.error }),
        };
      } else {
        body = { statusCode: status, message: (res as string) || 'Error' };
      }
    } else {
      const prisma = exception as {
        code?: string;
        meta?: { target?: string[] };
      };
      if (prisma?.code === 'P2002') {
        status = HttpStatus.BAD_REQUEST;
        body = {
          statusCode: status,
          message: 'Email is already in use',
          error: 'Bad Request',
        };
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        body = { statusCode: status, message: 'Internal server error' };
      }
    }

    const isHttp = exception instanceof HttpException;

    const method = (request as any)?.method;
    const url = (request as any)?.url;
    const user = (request as any)?.user;

    // Basic console logging for all API errors
    // Includes method, url, status, user, and stack/message.
    // You can later replace console.* with a proper logger.

    console.error(
      '[API_ERROR]',
      JSON.stringify(
        {
          method,
          url,
          status,
          user: user
            ? {
                id: user.id,
                email: user.email,
                role: user.role,
              }
            : null,
          message:
            isHttp && exception.getResponse
              ? exception.getResponse()
              : ((exception as any)?.message ?? 'Unknown error'),
        },
        null,
        2,
      ),
    );

    if (!response || typeof response.status !== 'function') {
      throw exception;
    }

    return response.status(status).json(body);
  }
}
