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
 * A text `prompt` may additionally carry `images` (a docx's embedded figures),
 * riding the same user message as image file parts so the model reads the
 * document's diagrams and mockups alongside its text. Either way the model fills
 * the schema via the provider's controlled generation.
 */

import type { FinishReason, FlexibleSchema, LanguageModelUsage } from "ai";
import {
	type CallWarning,
	generateObject,
	type LanguageModel,
	NoObjectGeneratedError,
	Output,
	streamText,
} from "ai";
import { ZodError } from "zod";
import { log } from "@/lib/logger";

/**
 * Classify the SHAPE of an unparseable structured output without carrying any
 * of its content: the text is the model's rendering of a customer document,
 * and these logs mirror to Sentry, whose retention Nova doesn't control (the
 * event-log stance in `generationContext.ts` — aggregate usage only, never
 * prompt/output content — applies at least as strongly here). The shape plus
 * `finishReason` and `textLength` separate the failure modes that need
 * separate follow-ups: nothing came back at all, a fence the parser can't
 * see past, JSON that parses but misses the schema, or non-JSON prose.
 */
function classifyUnparseableText(
	text: string | undefined,
): "empty" | "fenced" | "json-like" | "prose" {
	const trimmed = text?.trim() ?? "";
	if (trimmed.length === 0) return "empty";
	if (trimmed.startsWith("```")) return "fenced";
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json-like";
	return "prose";
}

/** The failing PATHS from a Zod validation failure, each with its issue
 *  code, and, for `custom` issues, the refinement MESSAGE itself: those are
 *  Nova's own person-to-person prose (the schemas' superRefines), they name
 *  the exact rule that failed, and without them a died run's diagnostics
 *  say only that "something custom" rejected (the $3.49 lesson). Built-in
 *  Zod messages stay as bare codes: they can embed received values, which
 *  are the model's rendering of customer content and must stay out of the
 *  mirrored logs. */
function schemaIssueSummary(
	err: NoObjectGeneratedError,
): readonly string[] | undefined {
	let cause: unknown = err.cause;
	for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
		if (cause instanceof ZodError) {
			return cause.issues.slice(0, 20).map((issue) => {
				const path = issue.path.join(".") || "<root>";
				return issue.code === "custom"
					? `${path}: ${issue.message.slice(0, 300)}`
					: `${path}: ${issue.code}`;
			});
		}
		cause = (cause as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Dev-only escape hatch: when `NOVA_DEBUG_STRUCTURED_OUTPUT_DIR` names a
 * directory, the complete unparseable text is written there so a local
 * smoke can be diagnosed exactly. Deliberately env-gated and best-effort:
 * the PRODUCTION policy stands — model output is a rendering of customer
 * content and never lands in Cloud Logging or Sentry.
 */
function debugDumpUnparseableText(err: NoObjectGeneratedError): void {
	const dir = process.env.NOVA_DEBUG_STRUCTURED_OUTPUT_DIR;
	if (!dir || !err.text) return;
	void import("node:fs/promises")
		.then((fs) =>
			fs.writeFile(
				`${dir}/unparseable-${err.response?.id ?? Date.now()}.json.txt`,
				err.text ?? "",
				"utf8",
			),
		)
		.catch(() => {
			// debugging aid only — never let it alter the failure path
		});
}

/**
 * Record the shape of a structured generation that yielded no parseable
 * object. Every call runs the provider stateless (`store: false`), so there is
 * no dashboard record to consult afterward: the finish reason, token usage,
 * response id, and the shape of what came back are captured here or lost.
 * Truncation (`finishReason: "length"`) is the guillotine doing its
 * documented job on an oversized document — an expected external condition,
 * so it logs as `warn` (Cloud-Logging-only); every other unparseable shape is
 * a model/parser defect and mirrors to Sentry as `error`.
 *
 * The parameter is `NoObjectGeneratedError`, not `unknown`, so a call site
 * that failed to narrow is a compile error instead of a silent no-op — the
 * exact observability gap this function exists to close.
 */
function logUnparseableStructuredOutput(err: NoObjectGeneratedError): void {
	const detail = {
		finishReason: err.finishReason,
		responseId: err.response?.id,
		modelId: err.response?.modelId,
		inputTokens: err.usage?.inputTokens,
		outputTokens: err.usage?.outputTokens,
		textLength: err.text?.length ?? 0,
		textShape: classifyUnparseableText(err.text),
		schemaIssues: schemaIssueSummary(err),
	};
	debugDumpUnparseableText(err);
	if (err.finishReason === "length") {
		log.warn(
			"[subGeneration] structured output truncated at the output ceiling",
			detail,
		);
	} else {
		/* NEVER hand the raw error to the Sentry mirror: its cause chain
		 * (JSONParseError / TypeValidationError) embeds the model's full raw
		 * text in the cause MESSAGE, and Sentry's default linkedErrors
		 * integration walks causes — the customer-document content this
		 * function promises to keep out of logs would land in third-party
		 * retention. A fresh cause-less error carries the grouping key;
		 * `detail` already holds every safe fact. */
		const sanitized = new Error(
			`Structured output was unparseable (finishReason: ${detail.finishReason}, shape: ${detail.textShape})`,
		);
		sanitized.name = err.name;
		log.error(
			"[subGeneration] structured output was unparseable",
			sanitized,
			detail,
		);
	}
}

/** The provider-options shape `generateObject` accepts (e.g. a provider's
 *  reasoning depth). `ai` declares this internally but doesn't export the
 *  name, so we derive it from the call signature — one source of truth the preview
 *  script reuses to type its per-model reasoning options. */
export type SubGenerationProviderOptions = NonNullable<
	Parameters<typeof generateObject>[0]["providerOptions"]
>;

/**
 * One image attached beside a text `prompt` (a docx's embedded figure). Rides
 * the same user message as the prompt, as an image file part the provider turns
 * into its native image block. When `label` is set, a text part carrying it
 * immediately precedes the image part: the correlation between an in-text
 * marker and its image is then stated in the content itself, not left to the
 * model counting attachment order.
 */
export interface SubGenerationImage {
	/** Image IANA media type (e.g. `image/png`). */
	mediaType: string;
	/** The image bytes as a `data:` URL. */
	data: string;
	/** Optional text emitted directly before the image part. */
	label?: string;
}

/**
 * The user-message content for a text prompt with attached images: the decoded
 * document text first, then each image in order, preceded by its label part
 * when one is set. Shared by the blocking and streaming calls so the two can
 * never drift on how figures ride the wire.
 */
function promptWithImagesContent(
	prompt: string,
	images: SubGenerationImage[],
): Array<
	| { type: "text"; text: string }
	| { type: "file"; data: string; mediaType: string }
> {
	return [
		{ type: "text", text: prompt },
		...images.flatMap((image) => [
			...(image.label ? [{ type: "text" as const, text: image.label }] : []),
			{ type: "file" as const, data: image.data, mediaType: image.mediaType },
		]),
	];
}

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
	/** The call's display-safe reasoning SUMMARY text, accumulated from the
	 *  streamed `reasoning-delta` parts (streaming path only; it requires
	 *  `reasoningSummary: 'auto'` in the provider options). Callers that
	 *  persist it write it to the run event log, never a design table. */
	reasoningText?: string;
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
	schema: FlexibleSchema<T>;
	/** Decoded text body (text/docx/xlsx). Mutually exclusive with `file`. */
	prompt?: string;
	/** Native document block (PDF) the model reads directly. */
	file?: { mediaType: string; data: string };
	/** Instruction that accompanies a `file` input. */
	instruction?: string;
	/** Images attached beside a text `prompt` (a docx's embedded figures), in
	 *  order. Only meaningful with `prompt`: a `file` document carries its own
	 *  images natively, so `file` takes precedence and `images` is ignored. */
	images?: SubGenerationImage[];
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
	/** Cancels the provider call; the AI SDK rejects with its abort error,
	 *  which propagates like any other non-object failure. */
	abortSignal?: AbortSignal;
}): Promise<SubGenerationObjectResult<T>> {
	try {
		// A `file` input rides as a native document block in a user message.
		// Everything else is ONE messages-form call: a bare string prompt is
		// wire-identical to a single user message with one text part (the SDK's
		// own conversion), so the no-images case deliberately shares the images
		// branch rather than keeping a third near-identical option block that
		// must be edited in lockstep.
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
					abortSignal: opts.abortSignal,
					providerOptions: opts.providerOptions,
				})
			: await generateObject({
					model: opts.model,
					instructions: opts.system,
					schema: opts.schema,
					messages: [
						{
							role: "user",
							content: promptWithImagesContent(
								opts.prompt ?? "",
								opts.images ?? [],
							),
						},
					],
					maxOutputTokens: opts.maxOutputTokens,
					abortSignal: opts.abortSignal,
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
			logUnparseableStructuredOutput(err);
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
	schema: FlexibleSchema<T>;
	/** Decoded text body (text/docx/xlsx). Mutually exclusive with `file`. */
	prompt?: string;
	/** Native document block (PDF) the model reads directly. */
	file?: { mediaType: string; data: string };
	/** Instruction that accompanies a `file` input. */
	instruction?: string;
	/** Images attached beside a text `prompt` (a docx's embedded figures), in
	 *  order. Only meaningful with `prompt`: a `file` document carries its own
	 *  images natively, so `file` takes precedence and `images` is ignored. */
	images?: SubGenerationImage[];
	maxOutputTokens?: number;
	providerOptions?: SubGenerationProviderOptions;
	/** Called per streamed chunk (reasoning OR output) with its character count —
	 *  real token flow a caller maps to a progress signal (e.g. signal-grid energy). */
	onProgress?: (deltaChars: number) => void;
	/** Cancels the provider call; the AI SDK rejects with its abort error,
	 *  which propagates like any other non-object failure. */
	abortSignal?: AbortSignal;
}): Promise<SubGenerationObjectResult<T>> {
	// A dead signal must not construct the stream machinery at all: streamText
	// tees internal streams whose promises only settle by being consumed, and
	// a call aborted before its first byte strands them all.
	opts.abortSignal?.throwIfAborted();
	// The result promises are consumed on the happy path; tracked here so the catch
	// can observe any it didn't await (a stream-stopping error jumps to the catch
	// before they're awaited — see below). PromiseLike, so wrap to attach a handler.
	let pending: PromiseLike<unknown>[] = [];
	try {
		// Same two-branch shape as `generateObjectWith`: a native `file` block,
		// or ONE messages-form call for text-with-optional-images (a bare string
		// prompt is wire-identical to a single user message with one text part).
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
					abortSignal: opts.abortSignal,
					providerOptions: opts.providerOptions,
				})
			: streamText({
					model: opts.model,
					instructions: opts.system,
					output: Output.object({ schema: opts.schema }),
					messages: [
						{
							role: "user",
							content: promptWithImagesContent(
								opts.prompt ?? "",
								opts.images ?? [],
							),
						},
					],
					maxOutputTokens: opts.maxOutputTokens,
					abortSignal: opts.abortSignal,
					providerOptions: opts.providerOptions,
				});

		pending = [
			result.output,
			result.usage,
			result.warnings,
			result.finishReason,
		];
		// `output` (and its siblings) are GETTERS minting a fresh promise per
		// access, so the instances captured above are never the ones handled
		// below — observe them NOW or an invalid object's rejection surfaces
		// as an unhandled rejection even on the clean-drain path.
		for (const p of pending) void Promise.resolve(p).catch(() => {});

		// Draining `stream` advances generation; the result promises resolve once
		// it's done. Feed progress from BOTH reasoning and output deltas — reasoning
		// is most of the work. `onProgress` is best-effort: a throwing callback (e.g.
		// a write to a disconnected client) must NEVER break extraction — the model
		// run persists regardless of who's listening — so it's swallowed here at the
		// source rather than relied on at each call site. Reasoning deltas also
		// accumulate into the result's `reasoningText`, the display-safe summary
		// a caller may persist to the run event log.
		let reasoningText = "";
		for await (const part of result.stream) {
			if (part.type === "reasoning-delta" || part.type === "text-delta") {
				if (part.type === "reasoning-delta") reasoningText += part.text;
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
		const [usage, warnings, finishReason] = await Promise.all([
			result.usage,
			result.warnings,
			result.finishReason,
		]);
		// Any output failure (truncation / malformed / type-mismatch) → null object:
		// same "no partial salvage" contract as the blocking path; the caller treats
		// null as a failed extraction. Two-arg `then` because `output` is a PromiseLike.
		const object = await result.output.then(
			(o) => o as T,
			(err: unknown) => {
				if (NoObjectGeneratedError.isInstance(err)) {
					logUnparseableStructuredOutput(err);
				} else {
					/* The stream drained cleanly yet the output promise rejected
					 * with something other than a parse failure. The caller only
					 * sees `object: null`, so this line is the ONLY record of what
					 * actually went wrong. Same discipline as
					 * `logUnparseableStructuredOutput`: NEVER hand the raw
					 * rejection to the Sentry mirror — an unwrapped
					 * JSONParseError / TypeValidationError embeds the model's
					 * full raw text (its rendering of a customer document) in
					 * the error MESSAGE itself, so a cause-less name-only error
					 * carries the grouping key instead. */
					const name = err instanceof Error ? err.name : typeof err;
					const sanitized = new Error(
						`Structured output promise rejected after a clean drain (${name}, finishReason: ${finishReason})`,
					);
					if (err instanceof Error) sanitized.name = err.name;
					log.error(
						"[subGeneration] structured output promise rejected after a clean drain",
						sanitized,
						{ finishReason },
					);
				}
				return null;
			},
		);
		return {
			object,
			usage,
			warnings,
			finishReason,
			...(reasoningText.length > 0 && { reasoningText }),
		};
	} catch (err) {
		// A stream-stopping error (transport failure) reaches here before the result
		// promises are awaited and may reject them too. Observe each (wrapped, since
		// they're PromiseLike) WITHOUT awaiting — a failed stream could leave one
		// unsettled — so an unawaited rejection can't escape as an unhandled rejection
		// (which fails the suite). The original error is what the caller classifies.
		for (const p of pending) void Promise.resolve(p).catch(() => {});
		if (NoObjectGeneratedError.isInstance(err)) {
			logUnparseableStructuredOutput(err);
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
