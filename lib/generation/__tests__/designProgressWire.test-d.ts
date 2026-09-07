/** Compiler-owned wire restatement contract; no runtime fixture assertions. */
import type {
	BuildLocalizationProjection as ServerBuildLocalization,
	BuildPlanSummaryProjection as ServerBuildPlanSummary,
	DesignBuildStage as ServerDesignBuildStage,
	DesignOutlineProjection as ServerDesignOutline,
	DesignPulseProjection as ServerDesignPulse,
	DesignProgressEnvelope as ServerEnvelope,
} from "@/lib/agent/build/progress";
import type {
	BuildLocalizationProjection,
	BuildPlanSummaryProjection,
	DesignBuildStage,
	DesignOutlineProjection,
	DesignProgressEnvelope,
	DesignPulseProjection,
} from "@/lib/generation/designProgressWire";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type StagesMatch = Assert<
	Exact<DesignBuildStage, ServerDesignBuildStage>
>;
export type OutlineMatch = Assert<
	Exact<DesignOutlineProjection, ServerDesignOutline>
>;
export type PlanMatch = Assert<
	Exact<BuildPlanSummaryProjection, ServerBuildPlanSummary>
>;
export type LocalizationMatch = Assert<
	Exact<BuildLocalizationProjection, ServerBuildLocalization>
>;
export type EnvelopeMatch = Assert<
	Exact<DesignProgressEnvelope<string>, ServerEnvelope<string>>
>;
export type PulseMatch = Assert<
	Exact<DesignPulseProjection, ServerDesignPulse>
>;
