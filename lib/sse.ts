/**
 * SSE (Server-Sent Events) encoding helpers for Next.js route handlers.
 */

export function encodeSSE(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function createSSEStream(): {
  stream: ReadableStream
  send: (event: string, data: any) => void
  close: () => void
} {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array>

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  return {
    stream,
    send(event: string, data: any) {
      try {
        controller.enqueue(encoder.encode(encodeSSE(event, data)))
      } catch {
        // Stream may be closed
      }
    },
    close() {
      try {
        controller.close()
      } catch {
        // Already closed
      }
    },
  }
}

export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    },
  })
}
