/**
 * Provider-agnostic single-shot sub-generations.
 *
 * `GenerationContext` exposes `generatePlainText` / `extractFromContent` as
 * usage-tracked, error-emitting methods bound to the Anthropic provider. But the
 * model call underneath is plain `generateText` with no Anthropic specifics — the
 * only provider-bound part is resolving the model id to a `LanguageModel`.
 * Hoisting that call here, parameterized by the resolved model, lets the exact
 * same code path run against ANY provider:
 *
 *   - production hands it `anthropic(id)` (via GenerationContext);
 *   - `scripts/preview-attachment-condense.ts` hands it either Anthropic Haiku
 *     or Google Gemini, to compare condenser quality + cost on a real document
 *     WITHOUT paying for the Solutions Architect's Opus tool loop.
 *
 * The `{ type: "file", data, mediaType }` content shape in `extractFromContentWith`
 * is itself provider-agnostic: every active provider (Anthropic, Google) detects
 * the media type and emits its own native document/image block, so a PDF or image
 * reaches each model intact through identical SDK input.
 */

import type { FinishReason, LanguageModelUsage } from "ai";
import { type CallWarning, generateText, type LanguageModel } from "ai";

/** The provider-options shape `generateText` accepts (e.g. a provider's
 *  reasoning/thinking depth). `ai` declares this type internally but doesn't
 *  export the name, so we derive it from the call signature — one source of
 *  truth the preview script reuses to type its Gemini thinking options. */
export type SubGenerationProviderOptions = NonNullable<
	Parameters<typeof generateText>[0]["providerOptions"]
>;

/** What a sub-generation returns: the model's text, the usage + warnings the
 *  caller folds into its own tracking (GenerationContext) or prints (the script),
 *  and the `finishReason` — `"length"` means the model hit `maxOutputTokens` and
 *  the text was truncated mid-stream, which the attachment pipeline must surface
 *  rather than silently pass off as a complete extract. */
export interface SubGenerationResult {
	text: string;
	usage: LanguageModelUsage | undefined;
	warnings: CallWarning[] | undefined;
	finishReason: FinishReason;
}

/** Text-in, text-out single generation against the given model.
 *
 * `providerOptions` is a generic pass-through to `generateText` — e.g. a
 * provider's reasoning/thinking depth. Production (Anthropic Haiku) leaves it
 * unset; the preview script uses it to run Gemini at a higher thinking level.
 * Keeping it provider-neutral here means no Gemini specifics leak into this
 * shared, production code path. */
export async function generatePlainTextWith(opts: {
	model: LanguageModel;
	system: string;
	prompt: string;
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
}): Promise<SubGenerationResult> {
	const result = await generateText({
		model: opts.model,
		system: opts.system,
		prompt: opts.prompt,
		maxOutputTokens: opts.maxOutputTokens,
		providerOptions: opts.providerOptions,
	});
	return {
		text: result.text,
		usage: result.usage,
		warnings: result.warnings,
		finishReason: result.finishReason,
	};
}

/**
 * A text instruction plus one native file block (PDF / image / …) in, text out.
 * The model reads the original document directly — no client-side text
 * extraction — which preserves layout and embedded structure a flat decode would
 * lose. Same content shape works across providers (see module note).
 */
export async function extractFromContentWith(opts: {
	model: LanguageModel;
	system: string;
	instruction: string;
	file: { mediaType: string; data: string };
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
}): Promise<SubGenerationResult> {
	const result = await generateText({
		model: opts.model,
		system: opts.system,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: opts.instruction },
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
	});
	return {
		text: result.text,
		usage: result.usage,
		warnings: result.warnings,
		finishReason: result.finishReason,
	};
}
