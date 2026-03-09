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
import { MODEL_CHAT } from '@/lib/models'

export const maxDuration = 300

const askQuestionsSchema = z.object({
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
})

const scaffoldBlueprintSchema = z.object({
  appName: z
    .string()
    .describe('Short app name (2-5 words)'),
  appSpecification: z
    .string()
    .describe(
      'Comprehensive specification incorporating all requirements and Q&A answers'
    ),
})

const chatTools = {
  askQuestions: {
    description:
      'Ask the user clarifying questions about their app requirements. Each call can hold up to 5 questions.',
    inputSchema: askQuestionsSchema,
    // No execute → client-side tool
  },
  scaffoldBlueprint: {
    description:
      'Scaffold the CommCare app blueprint. Call when you have enough information.',
    inputSchema: scaffoldBlueprintSchema,
    // No execute → client-side tool. stopWhen halts the loop here.
  },
}

// Pre-compute JSON schemas for logging (avoids re-serializing on every request)
const toolSchemas = {
  askQuestions: { description: chatTools.askQuestions.description, schema: z.toJSONSchema(askQuestionsSchema) },
  scaffoldBlueprint: { description: chatTools.scaffoldBlueprint.description, schema: z.toJSONSchema(scaffoldBlueprintSchema) },
}

export async function POST(req: Request) {
  const { messages, apiKey }: { messages: UIMessage[]; apiKey: string } =
    await req.json()

  const anthropic = createAnthropic({ apiKey })
  const convertedMessages = await convertToModelMessages(messages)

  const result = streamText({
    model: anthropic(MODEL_CHAT),
    system: SYSTEM_PROMPT,
    messages: convertedMessages,
    stopWhen: [hasToolCall('scaffoldBlueprint'), stepCountIs(10)],
    tools: chatTools,
  })

  return result.toUIMessageStreamResponse({
    messageMetadata: ({ part }) => {
      if (part.type === 'start') {
        return {
          input: {
            system: SYSTEM_PROMPT,
            messages: convertedMessages,
            tools: toolSchemas,
          },
        }
      }
      if (part.type === 'finish') {
        return {
          usage: {
            model: MODEL_CHAT,
            inputTokens: part.totalUsage.inputTokens,
            outputTokens: part.totalUsage.outputTokens,
            totalTokens: part.totalUsage.totalTokens,
          },
        }
      }
    },
  })
}
