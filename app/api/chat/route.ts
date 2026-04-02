import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  createAgentUIStream,
  type UIMessage,
} from 'ai'
import { GenerationContext } from '@/lib/services/generationContext'
import { EventLogger } from '@/lib/services/eventLogger'
import { createSolutionsArchitect } from '@/lib/services/solutionsArchitect'
import { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { chatRequestSchema } from '@/lib/schemas/apiSchemas'
import { classifyError, MESSAGES } from '@/lib/services/errorClassifier'
import { resolveApiKey } from '@/lib/auth-utils'
import { createProject, failProject } from '@/lib/db/projects'
import { touchUser } from '@/lib/db/users'
import { getMonthlyUsage, MONTHLY_SPEND_CAP_USD } from '@/lib/db/usage'

export const maxDuration = 300

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
  const body = await req.json()

  // Messages come from the AI SDK's useChat — typed but not schema-validated
  const messages: UIMessage[] = body.messages
  if (!Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'Missing messages array' }), { status: 400 })
  }

  // Validate our fields (apiKey, blueprint, etc.)
  const parsed = chatRequestSchema.safeParse(body)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 })
  }

  // Resolve the API key: authenticated session → server key, otherwise → BYOK
  const keyResult = await resolveApiKey(req, parsed.data.apiKey)
  if (!keyResult.ok) {
    return new Response(JSON.stringify({ error: keyResult.error }), { status: keyResult.status })
  }

  // Update activity timestamp and sync profile changes from Google.
  // Fire-and-forget — the user doc is created at sign-in time (Better Auth
  // after hook); this just keeps last_active_at current without blocking
  // the latency-sensitive chat path.
  if (keyResult.session) {
    touchUser(
      keyResult.session.user.email,
      keyResult.session.user.name,
      keyResult.session.user.image ?? null,
    )
  }

  // Spend cap check — only for authenticated users on the shared server key.
  // BYOK users are on their own key and uncapped. Fails open on Firestore errors.
  if (keyResult.session) {
    try {
      const usage = await getMonthlyUsage(keyResult.session.user.email)
      if ((usage?.cost_estimate ?? 0) >= MONTHLY_SPEND_CAP_USD) {
        return Response.json({
          error: MESSAGES.spend_cap_exceeded,
          type: 'spend_cap_exceeded',
        }, { status: 429 })
      }
    } catch (err) {
      console.error('[chat] spend cap check failed:', err)
    }
  }

  const { blueprint, runId } = parsed.data

  const logger = new EventLogger(runId)

  /*
   * Resolve projectId for authenticated users. Existing projects already have
   * an ID from the client. New builds create a real project document in Firestore
   * (status: 'generating') so log events have a project to live under from the start.
   */
  let projectId = parsed.data.projectId
  if (keyResult.session && !projectId) {
    try {
      projectId = await createProject(keyResult.session.user.email, logger.runId)
    } catch (err) {
      console.error('[chat] project creation failed:', err)
    }
  }

  if (keyResult.session && projectId) {
    logger.enableFirestore(keyResult.session.user.email, projectId)
  }

  // Flush usage on client disconnect — finalize() is idempotent so this
  // is safe even if onFinish also fires.
  req.signal.addEventListener('abort', () => logger.finalize())

  logger.logConversation(messages)

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Send runId to client so it can send it back on subsequent requests
      writer.write({ type: 'data-run-id', data: { runId: logger.runId }, transient: true })

      // Emit projectId immediately so the client can update the URL
      if (keyResult.session && projectId) {
        writer.write({ type: 'data-project-saved', data: { projectId }, transient: true })
      }

      const ctx = new GenerationContext({
        apiKey: keyResult.apiKey, writer, logger,
        session: keyResult.session, projectId,
      })

      /** Classify, emit, and persist a generation error. */
      const handleRouteError = (error: unknown, source: string) => {
        const classified = classifyError(error)
        ctx.emitError(classified, source)
        if (keyResult.session && projectId) {
          failProject(keyResult.session.user.email, projectId, classified.type)
        }
      }

      // Create MutableBlueprint — either from existing blueprint (edit/continuation) or empty (new build)
      const mutableBp = new MutableBlueprint(
        blueprint ?? { app_name: '', modules: [], case_types: null }
      )

      try {
        const sa = createSolutionsArchitect(ctx, mutableBp)
        const agentStream = await createAgentUIStream({
          agent: sa,
          uiMessages: messages,
        })

        // Manual consumption instead of writer.merge() — lets us catch stream
        // errors and emit data-error before the stream closes.
        const reader = agentStream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            writer.write(value)
          }
        } catch (streamError) {
          handleRouteError(streamError, 'route:stream')
        }
      } catch (error) {
        handleRouteError(error, 'route:init')
      }
    },
    onFinish() {
      logger.finalize()
    },
    onError: (error) => {
      // Safety net — most errors are now caught above and emitted as data-error.
      console.error('[chat] stream error:', error)
      return error instanceof Error ? error.message : String(error)
    },
  })

  return createUIMessageStreamResponse({ stream })
}
