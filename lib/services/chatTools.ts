import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Factory: creates a server instance per session so the tool handler
 * can reference the session's waitForClient function.
 *
 * Only contains generate_app — AskUserQuestion is a built-in tool
 * intercepted via canUseTool in the chat route.
 */
export function createChatToolServer(
  waitForClient: (event: Record<string, unknown>) => Promise<unknown>
) {
  return createSdkMcpServer({
    name: 'commcare',
    version: '1.0.0',
    tools: [
      tool(
        'generate_app',
        'Propose generating the CommCare app. Call when you have enough information about what to build.',
        {
          app_name: z.string().describe('Short app name (2-5 words)'),
          app_description: z.string().describe('Architecture summary: modules, forms, case types, key features'),
        },
        async (input) => {
          const response = await waitForClient({
            type: 'generate',
            data: { appName: input.app_name, appDescription: input.app_description },
          }) as { confirmed?: boolean }

          if (response.confirmed) {
            return { content: [{ type: 'text' as const, text: 'User confirmed. Generation starting.' }] }
          }
          return { content: [{ type: 'text' as const, text: 'User cancelled. Ask what they want to change.' }] }
        }
      ),
    ],
  })
}
