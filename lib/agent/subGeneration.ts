/**
 * Provider-agnostic structured sub-generation.
 *
 * `GenerationContext` and the standalone extraction condenser both extract a
 * document into a structured `{ extract, title, summary }` object via a SINGLE
 * `generateObject` call. The only provider-bound part is resolving the model id
 * to a `LanguageModel`; hoisting the call here, parameterized by the resolved
 * model, lets the same path run against ANY provider:
 *
 *   - production hands it the summarizer (GPT-5.6 Luna, via `GenerationContext`);
 *   - `scripts/preview-attachment-condense.ts` hands it Luna or Gemini, to
 *     compare condenser quality + cost on a real document WITHOUT paying for the
 *     Solutions Architect's tool loop.
 *
 * A document reaches the model one of two provider-agnostic ways: decoded text as
 * a `prompt` (text/docx/xlsx), or a native `{ type: "file" }` block the provider
 * turns into its own document block (a PDF the model reads directly — no
 * client-side text extraction, preserving layout/structure a flat decode loses).
 * Either way the model fills the schema via the provider's controlled generation.
 */

import type { FinishReason, LanguageModelUsage } from "ai";
import {
	type CallWarning,
	generateObject,
	type LanguageModel,
	NoObjectGeneratedError,
	Output,
	streamText,
} from "ai";
import type { ZodType } from "zod";

/** The provider-options shape `generateObject` accepts (e.g. a provider's
 *  reasoning depth). `ai` declares this internally but doesn't export the
 *  name, so we derive it from the call signature — one source of truth the preview
 *  script reuses to type its per-model reasoning options. */
export type SubGenerationProviderOptions = NonNullable<
	Parameters<typeof generateObject>[0]["providerOptions"]
>;

/** What a structured sub-generation returns: the parsed object, or `null` when
 *  the model couldn't produce a valid one (truncation past `maxOutputTokens`, or a
 *  malformed response — the AI SDK throws `NoObjectGeneratedError`, which we
 *  catch). `usage` / `finishReason` are surfaced even on that failure (the error
 *  carries them) so the caller still meters the tokens it spent AND can tell
 *  truncation (`finishReason === "length"`) from a malformed response. */
export interface SubGenerationObjectResult<T> {
	object: T | null;
	usage: LanguageModelUsage | undefined;
	warnings: CallWarning[] | undefined;
	finishReason: FinishReason | undefined;
	/** Provider metadata from the call — carries the gateway's metered actual
	 *  cost (`gateway.cost`). Absent on the NoObjectGeneratedError path (the
	 *  error doesn't carry it), so a failed call meters tokens but no actual. */
	providerMetadata?: unknown;
}

/**
 * STRUCTURED single generation: the model fills `schema` via the provider's
 * controlled generation (guaranteed-valid JSON, modulo truncation). The document
 * arrives either as decoded text (`prompt`) or as a native file block (`file` +
 * `instruction`). The `{ type: "file", data, mediaType }` content shape is itself
 * provider-agnostic: every active provider detects the media type and emits its
 * own native document block, so a PDF reaches each model intact through identical
 * SDK input.
 *
 * Returns `object: null` (rather than throwing) when the model can't yield a valid
 * object — surfacing usage + `finishReason` so the caller can meter the spent
 * tokens and distinguish truncation from a malformed response. A non-object error
 * (network / auth / server failure) still propagates for the condenser layer to
 * classify + emit.
 */
export async function generateObjectWith<T>(opts: {
	model: LanguageModel;
	system: string;
	schema: ZodType<T>;
	/** Decoded text body (text/docx/xlsx). Mutually exclusive with `file`. */
	prompt?: string;
	/** Native document block (PDF) the model reads directly. */
	file?: { mediaType: string; data: string };
	/** Instruction that accompanies a `file` input. */
	instruction?: string;
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
}): Promise<SubGenerationObjectResult<T>> {
	try {
		// A `file` input rides as a native document block in a user message; a text
		// `prompt` goes through directly. Branch the call (rather than spreading a
		// union) so each `generateObject` overload type-checks cleanly.
		const result = opts.file
			? await generateObject({
					model: opts.model,
					instructions: opts.system,
					schema: opts.schema,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: opts.instruction ?? "" },
								{
									type: "file",
									data: opts.file.data,
									mediaType: opts.file.mediaType,
								},
							],
						},
					],
					maxOutputTokens: opts.maxOutputTokens,
					providerOptions: opts.providerOptions,
				})
			: await generateObject({
					model: opts.model,
					instructions: opts.system,
					schema: opts.schema,
					prompt: opts.prompt ?? "",
					maxOutputTokens: opts.maxOutputTokens,
					providerOptions: opts.providerOptions,
				});
		return {
			object: result.object,
			usage: result.usage,
			warnings: result.warnings,
			finishReason: result.finishReason,
			providerMetadata: result.providerMetadata,
		};
	} catch (err) {
		// `generateObject` throws `NoObjectGeneratedError` when it can't produce a
		// valid object — truncation past `maxOutputTokens`, or a malformed response.
		// Treat that as "no object" (null), surfacing usage + finishReason so the
		// caller can meter spent tokens and detect truncation. Any other error (a
		// real network/auth/server failure) propagates.
		if (NoObjectGeneratedError.isInstance(err)) {
			return {
				object: null,
				usage: err.usage,
				warnings: undefined,
				finishReason: err.finishReason,
			};
		}
		throw err;
	}
}

/**
 * STREAMING structured generation — same contract and result shape as
 * `generateObjectWith`, but streamed so a caller can surface live progress.
 * `onProgress` fires per streamed chunk with its character count.
 *
 * Built on `streamText` + `Output.object`, NOT `streamObject`, on purpose: the
 * summarizer runs at high reasoning effort, where MOST of the wall-clock is silent
 * reasoning before any output token — `streamObject` exposes only the output text,
 * so progress wouldn't start until the very end. `streamText`'s `stream`
 * carries `reasoning-delta` parts too (with OpenAI `reasoningSummary`), so progress
 * tracks the reasoning phase as well — which is where the time actually goes.
 *
 * Correctness is identical to the blocking path: only the FINAL validated `object`
 * (`result.output`) is returned — the partial stream drives progress + generation,
 * never salvaged (a structured extract has no usable partial). Any output failure
 * (truncation past `maxOutputTokens`, malformed/invalid object) resolves to a
 * `null` object with usage + `finishReason` so the caller meters tokens and detects
 * truncation, exactly as `generateObjectWith` does.
 */
export async function streamObjectWith<T>(opts: {
	model: LanguageModel;
	system: string;
	schema: ZodType<T>;
	/** Decoded text body (text/docx/xlsx). Mutually exclusive with `file`. */
	prompt?: string;
	/** Native document block (PDF) the model reads directly. */
	file?: { mediaType: string; data: string };
	/** Instruction that accompanies a `file` input. */
	instruction?: string;
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
	/** Called per streamed chunk (reasoning OR output) with its character count —
	 *  real token flow a caller maps to a progress signal (e.g. signal-grid energy). */
	onProgress?: (deltaChars: number) => void;
}): Promise<SubGenerationObjectResult<T>> {
	// The result promises are consumed on the happy path; tracked here so the catch
	// can observe any it didn't await (a stream-stopping error jumps to the catch
	// before they're awaited — see below). PromiseLike, so wrap to attach a handler.
	let pending: PromiseLike<unknown>[] = [];
	try {
		// Branch the call by input shape (same as `generateObjectWith`) so each
		// `streamText` overload type-checks cleanly.
		const result = opts.file
			? streamText({
					model: opts.model,
					instructions: opts.system,
					output: Output.object({ schema: opts.schema }),
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: opts.instruction ?? "" },
								{
									type: "file",
									data: opts.file.data,
									mediaType: opts.file.mediaType,
								},
							],
						},
					],
					maxOutputTokens: opts.maxOutputTokens,
					providerOptions: opts.providerOptions,
				})
			: streamText({
					model: opts.model,
					instructions: opts.system,
					output: Output.object({ schema: opts.schema }),
					prompt: opts.prompt ?? "",
					maxOutputTokens: opts.maxOutputTokens,
					providerOptions: opts.providerOptions,
				});

		pending = [
			result.output,
			result.usage,
			result.warnings,
			result.finishReason,
			result.providerMetadata,
		];

		// Draining `stream` advances generation; the result promises resolve once
		// it's done. Feed progress from BOTH reasoning and output deltas — reasoning
		// is most of the work. `onProgress` is best-effort: a throwing callback (e.g.
		// a write to a disconnected client) must NEVER break extraction — the model
		// run persists regardless of who's listening — so it's swallowed here at the
		// source rather than relied on at each call site.
		for await (const part of result.stream) {
			if (part.type === "reasoning-delta" || part.type === "text-delta") {
				if (part.text.length > 0) {
					try {
						opts.onProgress?.(part.text.length);
					} catch {
						// best-effort progress — never let it abort the drain
					}
				}
			}
		}

		// Stream drained → the result promises have settled.
		const [usage, warnings, finishReason, providerMetadata] = await Promise.all(
			[
				result.usage,
				result.warnings,
				result.finishReason,
				result.providerMetadata,
			],
		);
		// Any output failure (truncation / malformed / type-mismatch) → null object:
		// same "no partial salvage" contract as the blocking path; the caller treats
		// null as a failed extraction. Two-arg `then` because `output` is a PromiseLike.
		const object = await result.output.then(
			(o) => o as T,
			() => null,
		);
		return { object, usage, warnings, finishReason, providerMetadata };
	} catch (err) {
		// A stream-stopping error (transport failure) reaches here before the result
		// promises are awaited and may reject them too. Observe each (wrapped, since
		// they're PromiseLike) WITHOUT awaiting — a failed stream could leave one
		// unsettled — so an unawaited rejection can't escape as an unhandled rejection
		// (which fails the suite). The original error is what the caller classifies.
		for (const p of pending) void Promise.resolve(p).catch(() => {});
		if (NoObjectGeneratedError.isInstance(err)) {
			return {
				object: null,
				usage: err.usage,
				warnings: undefined,
				finishReason: err.finishReason,
			};
		}
		throw err;
	}
}
