import { createAnthropic } from '@ai-sdk/anthropic'
import {
  convertToModelMessages,
  streamText,
  UIMessage,
  stepCountIs,
  hasToolCall,
} from 'ai'
import { z } from 'zod'
import { SYSTEM_PROMPT } from '@/lib/prompts/system'

export const maxDuration = 300

export async function POST(req: Request) {
  const { messages, apiKey }: { messages: UIMessage[]; apiKey: string } =
    await req.json()

  const anthropic = createAnthropic({ apiKey })

  const result = streamText({
    model: anthropic('claude-sonnet-4-6'),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    stopWhen: [hasToolCall('scaffoldBlueprint'), stepCountIs(10)],
    tools: {
      askQuestions: {
        description:
          'Ask the user clarifying questions about their app requirements. Each call can hold up to 5 questions.',
        inputSchema: z.object({
          header: z
            .string()
            .describe('Short header for this group of questions'),
          questions: z.array(
            z.object({
              question: z.string(),
              options: z.array(
                z.object({
                  label: z.string(),
                  description: z.string().optional(),
                })
              ),
            })
          ),
        }),
        // No execute → client-side tool
      },
      scaffoldBlueprint: {
        description:
          'Scaffold the CommCare app blueprint. Call when you have enough information.',
        inputSchema: z.object({
          appName: z
            .string()
            .describe('Short app name (2-5 words)'),
          appSpecification: z
            .string()
            .describe(
              'Comprehensive specification incorporating all requirements and Q&A answers'
            ),
        }),
        // No execute → client-side tool. stopWhen halts the loop here.
      },
    },
  })

  return result.toUIMessageStreamResponse()
}
