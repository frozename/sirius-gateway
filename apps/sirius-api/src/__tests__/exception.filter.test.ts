import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { GatewayExceptionFilter } from '../exception.filter.js';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';

describe('GatewayExceptionFilter', () => {
  let filter: GatewayExceptionFilter;
  let mockReply: any;
  let mockRequest: any;
  let mockHost: any;

  beforeEach(() => {
    filter = new GatewayExceptionFilter();

    mockReply = {
      status: mock().mockReturnThis(),
      send: mock(),
    };

    mockRequest = {
      method: 'GET',
      url: '/test-url',
    };

    mockHost = {
      switchToHttp: mock().mockReturnValue({
        getResponse: () => mockReply,
        getRequest: () => mockRequest,
      }),
    };
  });

  describe('catch', () => {
    it('returns 500 for non-HttpException', () => {
      const error = new Error('Some random error');
      filter.catch(error, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Internal server error',
          type: 'server_error',
          param: null,
          code: null,
        },
      });
    });

    it('returns correct status for HttpException', () => {
      const error = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);
      filter.catch(error, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    });

    it('formats in OpenAI error format {error:{message,type,param,code}}', () => {
      const error = new HttpException('Forbidden access', HttpStatus.FORBIDDEN);
      filter.catch(error, mockHost);

      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Forbidden access',
          type: 'permission_error',
          param: null,
          code: null,
        },
      });
    });

    it('maps 400 status code to invalid_request_error', () => {
      const error = new HttpException('Bad', HttpStatus.BAD_REQUEST);
      filter.catch(error, mockHost);
      expect(mockReply.send.mock.calls[0][0].error.type).toBe('invalid_request_error');
    });

    it('maps 401 status code to authentication_error', () => {
      const error = new HttpException('Auth', HttpStatus.UNAUTHORIZED);
      filter.catch(error, mockHost);
      expect(mockReply.send.mock.calls[0][0].error.type).toBe('authentication_error');
    });

    it('maps 403 status code to permission_error', () => {
      const error = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
      filter.catch(error, mockHost);
      expect(mockReply.send.mock.calls[0][0].error.type).toBe('permission_error');
    });

    it('maps 404 status code to not_found_error', () => {
      const error = new HttpException('Not Found', HttpStatus.NOT_FOUND);
      filter.catch(error, mockHost);
      expect(mockReply.send.mock.calls[0][0].error.type).toBe('not_found_error');
    });

    it('maps 429 status code to rate_limit_error', () => {
      const error = new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
      filter.catch(error, mockHost);
      expect(mockReply.send.mock.calls[0][0].error.type).toBe('rate_limit_error');
    });

    it('uses api_error for unmapped codes', () => {
      const error = new HttpException('Payment Required', HttpStatus.PAYMENT_REQUIRED);
      filter.catch(error, mockHost);
      expect(mockReply.send.mock.calls[0][0].error.type).toBe('api_error');
    });

    it('passes through HttpException with existing OpenAI error format', () => {
      const openAIError = {
        error: {
          message: 'Upstream error',
          type: 'upstream_error',
          param: 'test',
          code: '123'
        }
      };
      const error = new HttpException(openAIError, HttpStatus.BAD_GATEWAY);
      filter.catch(error, mockHost);

      expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
      expect(mockReply.send).toHaveBeenCalledWith(openAIError);
    });

    it('logs stack for 500+ status codes', () => {
      const loggerErrorSpy = spyOn(Logger.prototype, 'error');
      
      const error = new HttpException('Server failed', HttpStatus.INTERNAL_SERVER_ERROR);
      error.stack = 'Error stack trace';
      
      filter.catch(error, mockHost);
      
      expect(loggerErrorSpy).toHaveBeenCalled();
      expect(loggerErrorSpy.mock.calls[0][0]).toContain('GET /test-url → 500');
      expect(loggerErrorSpy.mock.calls[0][1]).toBe('Error stack trace');
      
      loggerErrorSpy.mockRestore();
    });

    it('uses Internal server error for non-HttpException', () => {
      const error = new Error('Secret DB connection error');
      filter.catch(error, mockHost);

      expect(mockReply.send.mock.calls[0][0].error.message).toBe('Internal server error');
    });
  });
});
