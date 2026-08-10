/**
 * DesignGenerationContext — the pre-app implementation of
 * `StructuredModelRunContext` (plan §7.5).
 *
 * A design session's structured calls (the independent reviewer) and the
 * design agent's model resolution run here: no app row, no SSE writer, no
 * commit host — just the provider, the run identity, the design-session
 * target, and usage metering. Provider privacy and the
 * sanitized structured-output logging ride the shared adapter
 * (`lib/agent/modelRunContext.ts` over `subGeneration.ts`); this class
 * deliberately duplicates none of it.
 */

import type { OpenAIProvider } from "@ai-sdk/openai";
import type { LanguageModel, LanguageModelUsage } from "ai";
import {
	meterSubGenerationUsage,
	runStructuredWith,
	type StructuredModelRunArgs,
	type StructuredModelRunContext,
	type SubGenerationUsageMeter,
} from "@/lib/agent/modelRunContext";
import { createNovaOpenAI } from "@/lib/agent/openaiProvider";
import type { SubGenerationObjectResult } from "@/lib/agent/subGeneration";
import type { GenerationTarget } from "@/lib/db/generationTargets";
import type { DesignBuildCostPhase } from "@/lib/db/usage";

export interface DesignGenerationContextOptions {
	/** Server-shared OpenAI API key — the one credential behind every model
	 *  this context resolves. */
	apiKey: string;
	userId: string;
	projectId: string;
	runId: string;
	designSessionId: string;
	/** Usage sink (a `UsageAccumulator` in production; absent in fixtures). */
	meter?: SubGenerationUsageMeter;
	/** Structured calls made through this context belong to one known phase. */
	usagePhase?: DesignBuildCostPhase;
}

export class DesignGenerationContext implements StructuredModelRunContext {
	private readonly openai: OpenAIProvider;
	readonly userId: string;
	readonly projectId: string;
	readonly runId: string;
	readonly designSessionId: string;
	private readonly meter: SubGenerationUsageMeter | undefined;
	private readonly usagePhase: DesignBuildCostPhase | undefined;

	constructor(opts: DesignGenerationContextOptions) {
		this.openai = createNovaOpenAI(opts.apiKey);
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

	async runStructured<T>(
		args: StructuredModelRunArgs<T>,
	): Promise<SubGenerationObjectResult<T>> {
		return runStructuredWith(this.model(args.modelId), args, (usage) =>
			this.trackSubGeneration(usage, args.modelId),
		);
	}
}
