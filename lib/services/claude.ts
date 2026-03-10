import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { PDFDocument } from 'pdf-lib'
import mammoth from 'mammoth'
import type { FileAttachment } from '../types'
import { MODEL_GENERATION } from '../models'
import type { ClaudeUsage } from '../usage'
import type { z } from 'zod'

export type { ClaudeUsage }

/**
 * Stateless Claude service — accepts API key per-call.
 * No conversation history management (the web app handles its own state).
 */

function getClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}

export async function sendOneShotStructured<S extends z.ZodType>(
  apiKey: string,
  systemPrompt: string,
  message: string,
  schema: S,
  onChunk?: (chunk: string) => void,
  options?: { model?: string; maxTokens?: number }
): Promise<{ data: z.infer<S>; usage: ClaudeUsage }> {
  const client = getClient(apiKey)
  const model = options?.model || MODEL_GENERATION
  const outputFormat = zodOutputFormat(schema)
  const stream = client.messages.stream({
    model,
    max_tokens: options?.maxTokens || 16384,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
    output_config: {
      format: outputFormat,
    },
  })

  stream.on('text', (text: string) => {
    if (onChunk) onChunk(text)
  })

  const finalMessage = await stream.finalMessage()

  if (!finalMessage.parsed_output) {
    throw new Error('Claude did not return parsed structured output')
  }

  return {
    data: finalMessage.parsed_output,
    usage: {
      model: finalMessage.model,
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      stop_reason: finalMessage.stop_reason,
      input: { system: systemPrompt, message, tools: outputFormat },
      output: finalMessage.parsed_output,
    },
  }
}

export async function sendOneShot(
  apiKey: string,
  systemPrompt: string,
  message: string,
  onChunk?: (chunk: string) => void,
  options?: { model?: string; maxTokens?: number }
): Promise<string> {
  const client = getClient(apiKey)
  const stream = client.messages.stream({
    model: options?.model || MODEL_GENERATION,
    max_tokens: options?.maxTokens || 16384,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  })

  let fullText = ''

  stream.on('text', (text) => {
    fullText += text
    if (onChunk) onChunk(text)
  })

  await stream.finalMessage()

  return fullText
}

export async function sendStructured<S extends z.ZodType>(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: any }>,
  schema: S,
  options?: { model?: string; maxTokens?: number }
): Promise<z.infer<S>> {
  const client = getClient(apiKey)
  const stream = client.messages.stream({
    model: options?.model || MODEL_GENERATION,
    max_tokens: options?.maxTokens || 8192,
    system: systemPrompt,
    messages,
    output_config: {
      format: zodOutputFormat(schema),
    },
  })

  const finalMessage = await stream.finalMessage()

  if (!finalMessage.parsed_output) {
    throw new Error('Claude did not return parsed structured output')
  }

  return finalMessage.parsed_output
}

export async function streamMessage(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: any }>,
  onChunk?: (chunk: string) => void
): Promise<string> {
  const client = getClient(apiKey)
  const stream = client.messages.stream({
    model: MODEL_GENERATION,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
  })

  let fullText = ''
  stream.on('text', (text) => {
    fullText += text
    if (onChunk) onChunk(text)
  })

  await stream.finalMessage()
  return fullText
}

export async function buildUserContent(message: string, attachments?: FileAttachment[]): Promise<any> {
  if (!attachments || attachments.length === 0) {
    return message
  }

  const content: any[] = []

  for (const attachment of attachments) {
    if (attachment.type.startsWith('image/')) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.type,
          data: attachment.data
        }
      })
    } else if (attachment.type === 'application/pdf') {
      // Split large PDFs into <=100 page chunks (API limit)
      const pdfChunks = await splitPdfIfNeeded(attachment.data)
      for (let i = 0; i < pdfChunks.length; i++) {
        if (pdfChunks.length > 1) {
          content.push({
            type: 'text',
            text: `[${attachment.name} — part ${i + 1} of ${pdfChunks.length}]`
          })
        }
        content.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfChunks[i]
          }
        })
      }
    } else if (attachment.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || attachment.name.endsWith('.docx')) {
      try {
        const buffer = Buffer.from(attachment.data, 'base64')
        const result = await mammoth.extractRawText({ buffer })
        content.push({
          type: 'text',
          text: `[Attached document: ${attachment.name}]\n${result.value}`
        })
      } catch {
        content.push({
          type: 'text',
          text: `[Attached file: ${attachment.name}]\n(Failed to parse DOCX content)`
        })
      }
    } else {
      // For other text-based files, include as text
      content.push({
        type: 'text',
        text: `[Attached file: ${attachment.name}]\n${attachment.data}`
      })
    }
  }

  if (message && message.trim()) {
    content.push({
      type: 'text',
      text: message
    })
  }

  // Ensure at least one text block exists (API requires non-empty content)
  if (content.length === 0) {
    content.push({
      type: 'text',
      text: 'See attached file.'
    })
  }

  return content
}

/** Split a PDF into <=100 page chunks. Returns array of base64 strings. */
async function splitPdfIfNeeded(base64Data: string): Promise<string[]> {
  const MAX_PAGES = 100
  try {
    const pdfBytes = Buffer.from(base64Data, 'base64')
    const pdf = await PDFDocument.load(pdfBytes)
    const totalPages = pdf.getPageCount()

    if (totalPages <= MAX_PAGES) {
      return [base64Data]
    }

    console.log(`PDF has ${totalPages} pages, splitting into ${Math.ceil(totalPages / MAX_PAGES)} chunks of <=${MAX_PAGES} pages`)

    const chunks: string[] = []
    for (let start = 0; start < totalPages; start += MAX_PAGES) {
      const end = Math.min(start + MAX_PAGES, totalPages)
      const chunkPdf = await PDFDocument.create()
      const pages = await chunkPdf.copyPages(pdf, Array.from({ length: end - start }, (_, i) => start + i))
      for (const page of pages) {
        chunkPdf.addPage(page)
      }
      const chunkBytes = await chunkPdf.save()
      chunks.push(Buffer.from(chunkBytes).toString('base64'))
    }

    return chunks
  } catch (err) {
    console.warn('Failed to split PDF, sending as-is:', err)
    return [base64Data]
  }
}
