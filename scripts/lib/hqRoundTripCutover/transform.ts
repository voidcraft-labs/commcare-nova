/**
 * The cutover's ordered document transform: raw carriers in, the target
 * document and every change a member is told about out.
 *
 * A step is one module under `./steps/`, registered here at its place in the
 * one fixed order (part 10 of step 2's plan, "The transform steps, in
 * order"): identity additions, then removals, then renames, then semantic
 * moves, then case lists, then the one step that takes values read from HQ.
 * A step mutates its own copy of the document and returns the changes it
 * made; one that changes nothing a person or a worker sees returns none. The
 * transform runs only after the matcher's Nova side has been read from the
 * untouched document.
 */

import type { LookupDataType } from "@/lib/lookup/types";
import type {
	DocumentNoticeReason,
	NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import { copyRawDocument, type RawDocument } from "./oldShape";

/** How the plan classed one deployment of the app (`plan.ts`). */
export type DeploymentOutcome =
	| "read-in-full"
	| "no-form-ids"
	| "deleted"
	| "unsupported"
	| "unreadable"
	| "transient";

/** One deployment of the app the plan holds, as a step may read it. */
export interface StepDeployment {
	readonly deploymentId: string;
	readonly outcome: DeploymentOutcome;
	/** The source read's `profile.properties`; null where no source was read. */
	readonly profileProperties: Readonly<Record<string, unknown>> | null;
}

/** What a step may read beside the document; nothing else of the database or HQ. */
export interface StepContext {
	readonly appId: string;
	readonly projectId: string;
	/** The Project's lookup tables by uuid: each column uuid's type. */
	readonly lookupColumnTypes: ReadonlyMap<
		string,
		ReadonlyMap<string, LookupDataType>
	>;
	/** The app's deployments the plan holds, by deployment id. */
	readonly deployments: readonly StepDeployment[];
}

/** One change a step made that the app's members are told about. */
export interface DocumentChange {
	readonly reason: DocumentNoticeReason;
	readonly entity: NoticeEntityRef;
	readonly detail?: Readonly<Record<string, string>>;
}

export interface CutoverStep {
	readonly id: string;
	/** Mutates `document`, the transform's private copy. */
	apply(document: RawDocument, context: StepContext): readonly DocumentChange[];
}

/** Every registered step, in the one order they run in. */
export const CUTOVER_STEPS: readonly CutoverStep[] = [];

export interface StepResult {
	readonly stepId: string;
	readonly changes: readonly DocumentChange[];
}

export interface TransformResult {
	readonly target: RawDocument;
	/** Every step's changes, in step order. */
	readonly changes: readonly DocumentChange[];
	/** Each registered step with the changes it made, in order. */
	readonly steps: readonly StepResult[];
}

/** Run every registered step over a private copy of `document`. */
export function transformDocument(
	document: RawDocument,
	context: StepContext,
	steps: readonly CutoverStep[] = CUTOVER_STEPS,
): TransformResult {
	const target = copyRawDocument(document);
	const results = steps.map((step) => ({
		stepId: step.id,
		changes: step.apply(target, context),
	}));
	return {
		target,
		changes: results.flatMap((result) => result.changes),
		steps: results,
	};
}
