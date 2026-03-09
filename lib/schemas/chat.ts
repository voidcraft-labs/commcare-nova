import { z } from 'zod'

export const ChatResponseSchema = z.object({
  intent: z.enum(['generate', 'clarify']).describe('Default to generate. Only use clarify when the description is too vague to build anything reasonable.'),
  app_name: z.string().nullable().describe('Short app name (2-5 words). Null when clarifying.'),
  app_description: z.string().nullable().describe('Concise architecture summary shown as a preview card: modules, forms, case types, key features. Null when clarifying.'),
  question: z.string().nullable().describe('Single most important clarifying question. Null when generating.'),
})

export type ChatResponse = z.infer<typeof ChatResponseSchema>
