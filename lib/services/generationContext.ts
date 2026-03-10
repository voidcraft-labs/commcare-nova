/**
 * GenerationContext — shared abstraction for all LLM calls in the pipeline.
 *
 * Wraps an Anthropic client + UI stream writer. Provides structured generation
 * (one-shot and streaming) with automatic usage logging, plus transient data
 * part emission. Used by both the Product Manager and Solutions Architect agents.
 */
import { streamText, generateText, Output } from 'ai'
import type { UIMessageStreamWriter } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { MODEL_GENERATION } from '../models'

export class GenerationContext {
  private anthropic: ReturnType<typeof createAnthropic>
  readonly writer: UIMessageStreamWriter

  constructor(apiKey: string, writer: UIMessageStreamWriter) {
    this.anthropic = createAnthropic({ apiKey })
    this.writer = writer
  }

  /** Get the Anthropic model provider for a given model ID. */
  model(id: string) {
    return this.anthropic(id)
  }

  /** Emit a transient data part to the client stream. */
  emit(type: `data-${string}`, data: unknown) {
    this.writer.write({ type, data, transient: true })
  }

  /** Log usage with full input/output for debugging. */
  emitUsage(
    label: string,
    model: string,
    usage: { inputTokens?: number; outputTokens?: number },
    input: { system: string; message: unknown },
    output: unknown,
  ) {
    this.emit('data-usage', {
      label,
      calls: [{
        model,
        input_tokens: usage.inputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        stop_reason: null,
        input,
        output,
      }],
    })
  }

  /** One-shot structured generation with automatic usage logging. */
  async generate<T>(
    schema: z.ZodType<T>,
    opts: { system: string; prompt: string; label: string; model?: string; maxOutputTokens?: number },
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
      this.emitUsage(opts.label, model, result.usage, { system: opts.system, message: opts.prompt }, result.output)
    }
    return result.output ?? null
  }

  /** Streaming structured generation with partial callbacks and automatic usage logging. */
  async streamGenerate<T>(
    schema: z.ZodType<T>,
    opts: { system: string; prompt: string; label: string; model?: string; maxOutputTokens?: number; onPartial?: (partial: Partial<T>) => void },
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
      this.emitUsage(opts.label, model, usage, { system: opts.system, message: opts.prompt }, last)
    }
    return last
  }
}
