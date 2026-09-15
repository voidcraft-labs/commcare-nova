/** Provider access and usage attribution for session-owned model calls.
 * Structured responses share the same adapter as ordinary editing. */

import type { OpenAIProvider } from "@ai-sdk/openai";
import type { LanguageModel, LanguageModelUsage } from "ai";
import {
	meterDurableSubGenerationUsage,
	meterSubGenerationUsage,
	runStructuredWith,
	type StructuredModelRunArgs,
	type StructuredModelRunContext,
	type SubGenerationUsageMeter,
} from "@/lib/agent/modelRunContext";
import { createNovaOpenAI } from "@/lib/agent/openaiProvider";
import type { SubGenerationObjectResult } from "@/lib/agent/subGeneration";
import type { GenerationTarget } from "@/lib/db/generationTargets";
import type {
	DesignBuildCostPhase,
	DurableUsageIdentity,
} from "@/lib/db/usage";

export interface AgentRunContextOptions {
	/** Server-shared OpenAI API key — the one credential behind every model
	 *  this context resolves. */
	apiKey: string;
	/** Optional HTTP transport for scoped callers; provider/schema adapters stay unchanged. */
	transport?: typeof globalThis.fetch;
	userId: string;
	projectId: string;
	runId: string;
	designSessionId: string;
	/** Usage sink (a `UsageAccumulator` in production; absent in fixtures). */
	meter?: SubGenerationUsageMeter;
	/** Structured calls made through this context belong to one known phase. */
	usagePhase?: DesignBuildCostPhase;
}

export class AgentRunContext implements StructuredModelRunContext {
	private readonly openai: OpenAIProvider;
	readonly userId: string;
	readonly projectId: string;
	readonly runId: string;
	readonly designSessionId: string;
	private readonly meter: SubGenerationUsageMeter | undefined;
	private readonly usagePhase: DesignBuildCostPhase | undefined;

	constructor(opts: AgentRunContextOptions) {
		this.openai = createNovaOpenAI(opts.apiKey, opts.transport);
		this.userId = opts.userId;
		this.projectId = opts.projectId;
		this.runId = opts.runId;
		this.designSessionId = opts.designSessionId;
		this.meter = opts.meter;
		this.usagePhase = opts.usagePhase;
	}

	get target(): GenerationTarget {
		return { kind: "design-session", designSessionId: this.designSessionId };
	}

	model(id: string): LanguageModel {
		return this.openai(id);
	}

	trackSubGeneration(usage: LanguageModelUsage, model: string): void {
		if (this.meter) {
			meterSubGenerationUsage(this.meter, usage, {
				model,
				...(this.usagePhase !== undefined && { phase: this.usagePhase }),
			});
		}
	}

	/** Register a response recovered from the durable model-step ledger without
	 * replaying its live conversation-event fan-out. The usage accumulator's
	 * `(context, step)` account makes repeated recovery exact-once. */
	trackDurableSubGeneration(
		usage: LanguageModelUsage,
		identity: DurableUsageIdentity,
		model: string,
		opts: {
			readonly step?: boolean;
			readonly phase?: DesignBuildCostPhase;
		} = {},
	): void {
		if (!this.meter) return;
		meterDurableSubGenerationUsage(this.meter, identity, usage, {
			model,
			...(opts.step !== undefined && { step: opts.step }),
			...((opts.phase ?? this.usagePhase) !== undefined && {
				phase: opts.phase ?? this.usagePhase,
			}),
		});
	}

	async runStructured<T>(
		args: StructuredModelRunArgs<T>,
	): Promise<SubGenerationObjectResult<T>> {
		return runStructuredWith(this.model(args.modelId), args, (usage) =>
			this.trackSubGeneration(usage, args.modelId),
		);
	}
}
