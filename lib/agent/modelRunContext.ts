/**
 * StructuredModelRunContext — the app-independent structured-generation
 * seam (plan §7.5).
 *
 * The design method's structured calls (the independent reviewer; the
 * retired pipeline's one-shots before it) need exactly this much of a
 * generation context: who is running (user/Project/run),
 * WHAT scope it bills against (the closed `GenerationTarget` union), a
 * model resolver, one cancellation-aware structured call, and usage
 * metering. They must not need an app row, an SSE writer, or a commit host.
 *
 * There is ONE adapter over the provider (`runStructuredWith`, composing
 * `subGeneration.ts`'s `streamObjectWith`): both
 * implementations — `GenerationContext` for an app-bound run and
 * `DesignGenerationContext` (`lib/agent/design/designGenerationContext.ts`)
 * for a pre-app design session — delegate here, so provider privacy
 * (`store: false`), sanitized structured-output logging, and abort handling
 * are written once and cannot drift between targets.
 */

import type { LanguageModel, LanguageModelUsage } from "ai";
import type { z } from "zod";
import type { GenerationTarget } from "@/lib/db/generationTargets";
import { strictStructuredSchema } from "./strictStructuredOutput";
import {
	type SubGenerationImage,
	type SubGenerationObjectResult,
	type SubGenerationProviderOptions,
	streamObjectWith,
} from "./subGeneration";

export interface StructuredModelRunArgs<T> {
	schema: z.ZodType<T>;
	modelId: string;
	system: string;
	prompt?: string;
	file?: { mediaType: string; data: string };
	images?: SubGenerationImage[];
	maxOutputTokens: number;
	providerOptions?: SubGenerationProviderOptions;
	signal: AbortSignal;
	onProgress?: (deltaChars: number) => void;
}

/** The minimal usage sink a run context meters into. `UsageAccumulator`
 *  satisfies it structurally (a bare `track(usage)` call is a sub-generation:
 *  tokens accrue, the step counter does not move). */
export interface SubGenerationUsageMeter {
	track(usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	}): void;
}

export interface StructuredModelRunContext {
	readonly userId: string;
	readonly projectId: string;
	readonly runId: string;
	readonly target: GenerationTarget;

	/** Resolve a model id to a `LanguageModel` (the Responses API). */
	model(id: string): LanguageModel;

	/** One cancellation-aware structured generation: parsed object or null
	 *  (truncation / malformed output), usage surfaced either way and
	 *  metered. A transport/abort error propagates for the caller to
	 *  classify. */
	runStructured<T>(
		args: StructuredModelRunArgs<T>,
	): Promise<SubGenerationObjectResult<T>>;

	/** Meter a sub-generation's tokens without stepping the run counter. */
	trackSubGeneration(usage: LanguageModelUsage): void;
}

/**
 * The one adapter both implementations delegate to. Every call STREAMS
 * (a blocking Responses call sends no response headers until the whole
 * generation finishes, so any call whose reasoning outruns undici's 300s
 * `headersTimeout` dies on the transport — observed live killing the
 * design author call on all three SDK attempts), and every call ships a
 * STRICT wire schema through `strictStructuredSchema`: the provider
 * grammar-enforces the structure during generation, and the original Zod
 * schema (refinements included) remains the SDK-side gate. Usage is
 * metered through `track` even when the model produced no parseable
 * object — spent tokens are spent.
 */
export async function runStructuredWith<T>(
	model: LanguageModel,
	args: StructuredModelRunArgs<T>,
	track: (usage: LanguageModelUsage) => void,
): Promise<SubGenerationObjectResult<T>> {
	const result = await streamObjectWith<T>({
		model,
		system: args.system,
		schema: strictStructuredSchema(args.schema),
		prompt: args.prompt,
		file: args.file,
		images: args.images,
		maxOutputTokens: args.maxOutputTokens,
		providerOptions: args.providerOptions,
		abortSignal: args.signal,
		onProgress: args.onProgress,
	});
	if (result.usage) track(result.usage);
	return result;
}

/** Translate an AI SDK usage report into the meter's shape — shared by both
 *  implementations so cache token details never silently drop. */
export function meterSubGenerationUsage(
	meter: SubGenerationUsageMeter,
	usage: LanguageModelUsage,
): void {
	meter.track({
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
		cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
	});
}
