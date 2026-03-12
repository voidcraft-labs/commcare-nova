/**
 * GenerationContext — shared abstraction for all LLM calls in the pipeline.
 *
 * Wraps an Anthropic client + UI stream writer + RunLogger. Provides structured
 * generation (one-shot and streaming) with automatic run logging, plus transient
 * data part emission. Used by both the Product Manager and Solutions Architect agents.
 */
import { streamText, generateText, Output } from 'ai'
import type { UIMessageStreamWriter } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { MODEL_GENERATION } from '../models'
import { RunLogger } from './runLogger'

export class GenerationContext {
  private anthropic: ReturnType<typeof createAnthropic>
  readonly writer: UIMessageStreamWriter
  readonly logger: RunLogger

  constructor(apiKey: string, writer: UIMessageStreamWriter, logger: RunLogger) {
    this.anthropic = createAnthropic({ apiKey })
    this.writer = writer
    this.logger = logger
  }

  /** Get the Anthropic model provider for a given model ID. */
  model(id: string) {
    return this.anthropic(id)
  }

  /** Emit a transient data part to the client stream. */
  emit(type: `data-${string}`, data: unknown) {
    this.writer.write({ type, data, transient: true })
  }

  /** One-shot structured generation with automatic run logging. */
  async generate<T>(
    schema: z.ZodType<T>,
    opts: { system: string; prompt: string; label: string; model?: string; maxOutputTokens?: number; knowledge?: string[] },
  ): Promise<T | null> {
    const model = opts.model ?? MODEL_GENERATION
    const result = await generateText({
      model: this.anthropic(model),
      output: Output.object({ schema }),
      system: opts.system,
      prompt: opts.prompt,
      maxOutputTokens: opts.maxOutputTokens,
    })
    if (result.usage) {
      this.logger.logSubResult(opts.label, {
        model,
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
        input: { system: opts.system, message: opts.prompt },
        output: result.output,
        ...(opts.knowledge && { knowledge: opts.knowledge }),
      })
    }
    return result.output ?? null
  }

  /** Streaming structured generation with partial callbacks and automatic run logging. */
  async streamGenerate<T>(
    schema: z.ZodType<T>,
    opts: { system: string; prompt: string; label: string; model?: string; maxOutputTokens?: number; knowledge?: string[]; onPartial?: (partial: Partial<T>) => void },
  ): Promise<T | null> {
    const model = opts.model ?? MODEL_GENERATION
    const result = streamText({
      model: this.anthropic(model),
      output: Output.object({ schema }),
      system: opts.system,
      prompt: opts.prompt,
      maxOutputTokens: opts.maxOutputTokens,
    })

    let last: T | null = null
    for await (const partial of result.partialOutputStream) {
      opts.onPartial?.(partial as Partial<T>)
      last = partial as T
    }

    const usage = await result.usage
    if (usage) {
      this.logger.logSubResult(opts.label, {
        model,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        input: { system: opts.system, message: opts.prompt },
        output: last,
        ...(opts.knowledge && { knowledge: opts.knowledge }),
      })
    }
    return last
  }
}
