import { type NextRequest } from 'next/server'
import { getCczBuffer } from '@/lib/generation-manager'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const buffer = getCczBuffer(id)

  if (!buffer) {
    return new Response('CCZ not found or expired', { status: 404 })
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="app.ccz"`,
      'Content-Length': buffer.length.toString(),
    },
  })
}
