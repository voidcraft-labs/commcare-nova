/**
 * Provider-agnostic structured sub-generation.
 *
 * `GenerationContext` and the standalone Gemini condenser both extract a document
 * into a structured `{ extract, title, summary }` object via a SINGLE
 * `generateObject` call. The only provider-bound part is resolving the model id
 * to a `LanguageModel`; hoisting the call here, parameterized by the resolved
 * model, lets the same path run against ANY provider:
 *
 *   - production hands it the Gemini summarizer (via `GenerationContext`);
 *   - `scripts/preview-attachment-condense.ts` hands it Gemini or Anthropic, to
 *     compare condenser quality + cost on a real document WITHOUT paying for the
 *     Solutions Architect's Opus tool loop.
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
} from "ai";
import type { ZodType } from "zod";

/** The provider-options shape `generateObject` accepts (e.g. a provider's
 *  reasoning/thinking depth). `ai` declares this internally but doesn't export the
 *  name, so we derive it from the call signature — one source of truth the preview
 *  script reuses to type its Gemini thinking options. */
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
					system: opts.system,
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
					system: opts.system,
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
