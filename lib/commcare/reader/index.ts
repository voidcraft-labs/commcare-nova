/**
 * The reader of CommCare HQ's apps: one pure function from an app as HQ
 * serves it to a Nova document, or to the account of why it cannot be held.
 * It reads nothing but its arguments, never throws for an app's content, and
 * reports every finding of a reading in one pass. Server code only; outside
 * the `lib/commcare` barrel.
 */
import "server-only";

import { inventoryIndex } from "../surface/inventory";
import { readApplication } from "./appShell";
import { assembleDocument, assembleDocumentSteps } from "./assemble";
import { readCaseLists, readCaseListsSteps, settleCaseLists } from "./caseList";
import {
	compareEntryFacts,
	compareEntryFactsSteps,
	readCaseManagement,
	settleCaseManagement,
	settleCaseManagementSteps,
	writeCaseOperations,
} from "./caseManagement";
import { createReadContext, type ReadContext } from "./context";
import {
	readMenus,
	readRootSelectionsTaken,
	registerLinkExpressions,
	settleMenus,
	settleMenusSteps,
} from "./menus";
import { bindExpressions, bindExpressionsSteps } from "./provisional";
import { readSearches, settleSearches } from "./search";
import { readStructure } from "./structure";
import { countingSyntaxReads } from "./syntaxRead";
import type { ReaderInput, ReaderOptions, ReadOutcome } from "./types";
import { mintFields, readForms, readFormsSteps } from "./xform";
import { finishForms } from "./xform/afterBinding";
import { finishText } from "./xform/prose";

export { knownCaseTypesOf } from "./caseManagement/knownCaseTypes";
export { knownLanguageCodesOf } from "./languages";
export type * from "./types";

/** One stage of a reading: reads what it claims, writes the drafts, the facts or the document. */
export type ReaderStage = (ctx: ReadContext) => void;

/** A stage a part at a time: it stops between its parts until it is resumed,
 *  so a stage long at the byte cap is no one long piece. */
type SteppedStage = (ctx: ReadContext) => Generator<void, void, void>;

/** A stage of one part. */
function whole(stage: ReaderStage): SteppedStage {
	// biome-ignore lint/correctness/useYield: a stage of one part has nowhere to stop; it runs whole at its first step.
	return function* (ctx) {
		stage(ctx);
	};
}

/** Each stage, and a long one's parts. */
const STAGE_PARTS: readonly (readonly [ReaderStage, SteppedStage?])[] = [
	[readApplication],
	[readStructure],
	[readForms, readFormsSteps],
	[(ctx) => readMenus(ctx, ctx.draft)],
	[(ctx) => readCaseManagement(ctx, ctx.draft)],
	[mintFields],
	[(ctx) => writeCaseOperations(ctx, ctx.draft)],
	[
		(ctx) => readCaseLists(ctx, ctx.draft),
		(ctx) => readCaseListsSteps(ctx, ctx.draft),
	],
	[(ctx) => readSearches(ctx, ctx.draft)],
	[(ctx) => readRootSelectionsTaken(ctx, ctx.draft)],
	[
		(ctx) => compareEntryFacts(ctx, ctx.draft),
		(ctx) => compareEntryFactsSteps(ctx, ctx.draft),
	],
	[(ctx) => registerLinkExpressions(ctx, ctx.draft)],
	[bindExpressions, bindExpressionsSteps],
	[
		(ctx) => settleCaseManagement(ctx, ctx.draft),
		(ctx) => settleCaseManagementSteps(ctx, ctx.draft),
	],
	[(ctx) => settleCaseLists(ctx, ctx.draft)],
	[(ctx) => settleSearches(ctx, ctx.draft)],
	[
		(ctx) => settleMenus(ctx, ctx.draft),
		(ctx) => settleMenusSteps(ctx, ctx.draft),
	],
	[finishText],
	[finishForms],
	[assembleDocument, assembleDocumentSteps],
];

/**
 * The stages, run in this order over one context. Whatever a stage that is not
 * here would claim stays unclaimed, and the close reports it as
 * `unrecognized`: a reader missing a stage reads every app that needs it to an
 * account and admits nothing it cannot read.
 */
export const STAGES: readonly ReaderStage[] = STAGE_PARTS.map(
	([stage]) => stage,
);

/** `STAGES` a part at a time: a long stage's own parts, every other whole. */
const STAGE_STEPS: readonly SteppedStage[] = STAGE_PARTS.map(
	([stage, steps]) => steps ?? whole(stage),
);

/** Read one HQ app into a Nova document, or into the account of why it cannot be held. */
export function readHqApp(
	input: ReaderInput,
	options: ReaderOptions = {},
): ReadOutcome {
	const steps = readHqAppSteps(input, options);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * `readHqApp` one stage at a time, and a long stage a part at a time: the
 * reading stops after each until it is resumed, so a caller on a request can
 * let the event loop turn between them: an app at the byte cap is seconds of
 * reading. Nothing outside the reading's own context is held across a stop.
 */
export function* readHqAppSteps(
	input: ReaderInput,
	options: ReaderOptions = {},
): Generator<void, ReadOutcome, void> {
	if (input.modules.length !== input.source.modules.length)
		throw new Error(
			`The reader was given ${input.modules.length} aligned menus for a source that holds ${input.source.modules.length}. Pass the menus of the same reading the source came from.`,
		);
	const ctx = createReadContext(input, options, inventoryIndex());
	// `onStage` names the part a throw came from.
	for (const [index, stage] of STAGE_STEPS.entries()) {
		options.onStage?.(index);
		const steps = stage(ctx);
		/* Counted per part, since another reading may run between two. */
		while (!countingSyntaxReads(ctx.accounting, () => steps.next()).done) yield;
		yield;
	}
	options.onStage?.("close");
	const { findings, work, claims, defects } = ctx.close();
	if (findings.length > 0)
		return {
			kind: "account",
			findings,
			work,
			claims,
			defects,
			unreadTables: [...ctx.facts.unreadTables],
			readsLocations: ctx.readsLocations,
		};
	if (ctx.assembled === undefined)
		throw new Error(
			"The reader closed a reading with no finding and no document. A reading with no finding is assembled into a document by the last of the reader's stages; check that STAGES ends with the assembly stage and that it sets the reading's draft.",
		);
	return { kind: "read", draft: ctx.assembled, work, claims, defects };
}
