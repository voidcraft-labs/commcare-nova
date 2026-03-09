import { type NextRequest } from 'next/server'
import { subscribe, getJob } from '@/lib/generation-manager'
import { createSSEStream, sseResponse } from '@/lib/sse'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const job = getJob(id)

  if (!job) {
    return new Response('Job not found', { status: 404 })
  }

  const { stream, send, close } = createSSEStream()

  // Send initial connected event
  send('connected', { buildId: id })

  const unsubscribe = subscribe(id, (event, data) => {
    send(event, data)
    if (event === 'complete' || (event === 'error' && !data.recoverable)) {
      setTimeout(() => {
        close()
      }, 100)
    }
  })

  // Handle client disconnect
  req.signal.addEventListener('abort', () => {
    unsubscribe()
    close()
  })

  return sseResponse(stream)
}
