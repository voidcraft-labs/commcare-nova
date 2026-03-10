import { NextRequest } from 'next/server'
import { createUIMessageStream, createUIMessageStreamResponse, createAgentUIStream } from 'ai'
import { createSupervisorAgent, BlueprintAccumulator } from '@/lib/services/supervisorAgent'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { messages, apiKey, appName, appSpecification } = await req.json()

  if (!apiKey || !appSpecification) {
    return Response.json({ error: 'apiKey and appSpecification are required' }, { status: 400 })
  }

  const prompt = `Design and generate a CommCare app called "${appName || 'CommCare App'}".\n\nSpecification:\n${appSpecification}`

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'data-phase', data: { phase: 'designing' } })

      const accumulator = new BlueprintAccumulator()
      const agent = createSupervisorAgent(apiKey, accumulator, writer)

      const agentStream = await createAgentUIStream({
        agent,
        uiMessages: messages ?? [{ role: 'user', content: prompt }],
      })

      writer.merge(agentStream)
    },
    onError: (error) => {
      return error instanceof Error ? error.message : String(error)
    },
  })

  return createUIMessageStreamResponse({ stream })
}
