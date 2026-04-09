import { mock } from 'bun:test';

/**
 * Mocks the global fetch function with a custom handler.
 * @param handler The function to handle the intercepted request.
 * @returns A restore function to revert to the original fetch.
 */
export function mockFetch(handler: (req: Request | string, init?: RequestInit) => Promise<Response> | Response) {
  const originalFetch = globalThis.fetch;
  
  // Create a wrapper to normalize inputs into a Request object if desired, 
  // but for simplicity we'll just mock it as taking a Request or matching the handler.
  const mockedFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    let req: Request;
    if (input instanceof Request) {
      req = input;
    } else {
      req = new Request(input.toString(), init);
    }
    return handler(req);
  });

  globalThis.fetch = mockedFetch as unknown as typeof fetch;
  
  return function restore() {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Creates a Response object with a ReadableStream body from a string.
 */
export function createMockResponse(body: string, status = 200, headers?: Record<string, string>) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });

  return new Response(stream, {
    status,
    headers,
  });
}

/**
 * Shorthand to create a JSON Response.
 */
export function createJsonResponse(data: unknown, status = 200) {
  return createMockResponse(JSON.stringify(data), status, {
    'Content-Type': 'application/json',
  });
}

/**
 * Returns a non-ok Response with JSON error body matching provider error shapes.
 */
export function createErrorResponse(status: number, message: string) {
  return createJsonResponse({ error: { message } }, status);
}

/**
 * Drains an async iterable into an array.
 */
export async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}
