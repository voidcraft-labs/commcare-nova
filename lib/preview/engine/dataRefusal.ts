/**
 * What a device refuses because the data it holds is empty, as Preview
 * presents it.
 *
 * Core checks a path before it reads it (`DataInstance.hasTemplatePath`), and
 * the places, the lookup tables, the selected cases and the search answers
 * are plain instances with no templates, so with nothing in them a value read
 * below them is refused ("Logic references … which is not a valid question or
 * value"), and a choice list over a table with no rows does not open
 * (`ItemSetUtils.populateDynamicChoices`, and for a Search prompt
 * `RemoteQuerySessionManager.populateItemSetChoices`). That is the running
 * app turning away the Project's data, never a Preview fault: each surface
 * says what a phone does and what to change, and nothing reaches telemetry.
 */

import {
	type BlueprintDoc,
	type CaseOperation,
	expressionSlotValues,
	type Form,
	type SearchInputDef,
	searchInputOptions,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import type { FormSelectionSource } from "@/lib/domain/formEntryCases";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { PreviewXPathRuntimeError } from "../xpath/runtimeError";
import { XPathInvalidPathError } from "../xpath/runtimeValues";
import type { XPathRuntimeFailure } from "../xpath/workerProtocol";
import type { PreviewLookupData } from "./lookupEvaluation";
import { PREVIEW_UNKNOWN_WORKER_KEYS } from "./workerSessionKeys";

/** The places instance's id, in every form and link that reads them. */
const LOCATIONS_INSTANCE_ID = "locations";
/** The session's id. Its only part Preview can leave a key out of is the
 *  worker's data (`xpathInstances.ts::commcareSessionXPathInstance`). */
const SESSION_INSTANCE_ID = "commcaresession";
const SEARCH_INPUT_INSTANCE_PREFIX = "search-input:";

type HiddenCalculationRefusal = {
	readonly kind: "hidden-calculation";
	readonly question: string;
	readonly problem: "date-as-boolean" | "empty-choice";
};

export type PreviewDataRefusalReason =
	| { readonly kind: "invalid-case-location" }
	| {
			readonly kind: "entry-record";
			readonly selection: string;
			readonly source: FormSelectionSource["kind"];
	  }
	| HiddenCalculationRefusal
	| { readonly kind: "project-search" }
	/** A value read below an instance that holds nothing, named by its id. */
	| { readonly kind: "empty-instance"; readonly instanceId: string }
	/** A case owner moved to the worker's place at a level, for a worker
	 * assigned nowhere: Core refuses the owner's read when the form opens
	 * (`lib/commcare/xpath/wire/tree.ts::WirePath.refusesEmpty`). */
	| { readonly kind: "group-count" }
	| { readonly kind: "owner-without-place" }
	/** A choice list whose table has no rows. `fieldUuid` is the form's
	 * question, where the refusal came from one. */
	| {
			readonly kind: "empty-choice-table";
			readonly tableId: LookupTableId;
			readonly fieldUuid?: Uuid;
	  }
	/** A Search screen of one field whose starting value is a choice the
	 * field's list does not offer: Core lets such a choice go only in a pass
	 * it gives a second field, so the screen fails ("Invalid itemset state",
	 * `RemoteQuerySessionManager.refreshItemSetChoices`). `input` is the
	 * field's label, or its name where it has none. */
	| {
			readonly kind: "unoffered-starting-choice";
			readonly inputUuid: Uuid;
			readonly input: string;
	  }
	/** A date-range Search field whose starting value Web Apps' date picker
	 * cannot show as a pair of dates, so its screen does not open. */
	| {
			readonly kind: "unreadable-starting-range";
			readonly inputUuid: Uuid;
			readonly input: string;
	  };

/** A read of a worker-data key the worker's device lacks: the session is the
 *  instance it misses in. */
export const WORKER_INFORMATION_REFUSAL: PreviewDataRefusalReason = {
	kind: "empty-instance",
	instanceId: SESSION_INSTANCE_ID,
};

/** Where in an entry the refusal stopped it: the form, or its links once the
 * form is saved. */
export type PreviewDataRefusalStage = "form" | "links";

export class PreviewDataRefusal extends Error {
	readonly reason: PreviewDataRefusalReason;
	readonly stage: PreviewDataRefusalStage;

	constructor(
		reason: PreviewDataRefusalReason,
		stage: PreviewDataRefusalStage = "form",
	) {
		super(
			reason.kind === "project-search"
				? "The connected project space runs this search."
				: reason.kind === "hidden-calculation"
					? `CommCare cannot hold the calculated answer for “${reason.question}” (${reason.problem}).`
					: reason.kind === "entry-record"
						? `This form could not find the record for “${reason.selection}”.`
						: reason.kind === "invalid-case-location"
							? "A saved case location cannot be read as coordinates."
							: reason.kind === "empty-instance"
								? `CommCare refuses this read: the instance “${reason.instanceId}” holds nothing on the device.`
								: reason.kind === "group-count"
									? "This form needs exactly one case-sharing group for this worker."
									: reason.kind === "owner-without-place"
										? "CommCare refuses this case owner: the worker is assigned no place to move the case to."
										: reason.kind === "unreadable-starting-range"
											? "Web Apps could not open the starting dates for this search."
											: reason.kind === "unoffered-starting-choice"
												? `CommCare refuses this Search screen: its one field “${reason.input}” starts on a choice its list doesn't offer.`
												: "CommCare refuses this choice list: its table has no rows.",
		);
		this.name = "PreviewDataRefusal";
		this.reason = reason;
		this.stage = stage;
	}
}

/**
 * The refusal an error stands for, or `undefined` for every other error. A
 * miss in the form's own instance is a broken path, not empty data, so it
 * stays a fault.
 */
export function previewDataRefusalOf(
	error: unknown,
): PreviewDataRefusal | undefined {
	if (error instanceof PreviewDataRefusal) return error;
	if (error instanceof XPathInvalidPathError && error.missedIn !== null)
		return new PreviewDataRefusal({
			kind: "empty-instance",
			instanceId: error.missedIn,
		});
	return undefined;
}

/** What a screen read gives: its value, or Core's refusal of data the device
 *  lacks, which the screen shows in its own place. */
export type PreviewScreenRead<T> =
	| { readonly kind: "read"; readonly value: T }
	| { readonly kind: "refused"; readonly refusal: PreviewDataRefusal };

/**
 * Read a screen, holding Core's refusal as the screen's state rather than an
 * error that leaves the render: a menu screen that reads a condition over
 * data the device lacks (a worker key the worker has none of, a table with no
 * rows) shows the refusal where its list would be, as a phone stops there,
 * and nothing is logged, since the app is right and the data is empty. Every
 * other error still throws.
 */
export function readPreviewScreen<T>(read: () => T): PreviewScreenRead<T> {
	try {
		return { kind: "read", value: read() };
	} catch (error) {
		const refusal = previewDataRefusalOf(error);
		if (refusal === undefined) throw error;
		return { kind: "refused", refusal };
	}
}

/**
 * The error a failed worker evaluation raises on the host: Core's refusal of
 * empty data where the worker says so, else the diagnostic runtime error.
 */
export function workerFailureError(failure: XPathRuntimeFailure): Error {
	return failure.refusal === undefined
		? new PreviewXPathRuntimeError(failure.error)
		: new XPathInvalidPathError(failure.refusal.instanceId);
}

/** What a refusal is about, named from the document and the lookup data. */
export type PreviewDataRefusalSubject =
	| { readonly kind: "invalid-case-location" }
	| Extract<PreviewDataRefusalReason, { kind: "entry-record" }>
	| HiddenCalculationRefusal
	| { readonly kind: "project-search" }
	| { readonly kind: "places" }
	| { readonly kind: "group-count" }
	| { readonly kind: "owner-place" }
	| { readonly kind: "table"; readonly tableName: string }
	| {
			readonly kind: "choices";
			readonly tableName: string;
			readonly fieldUuid?: Uuid;
	  }
	| { readonly kind: "search-answers" }
	/** A Search field of a one-field screen that starts on a choice its list
	 *  does not offer, by its label. */
	| {
			readonly kind: "starting-choice" | "starting-range";
			readonly input: string;
	  }
	/** A key of the worker's data the device holds none of: a place key of
	 *  a worker assigned nowhere, or a field no one defined. */
	| { readonly kind: "worker-information" }
	| { readonly kind: "other" };

function tableName(
	lookupData: PreviewLookupData | null | undefined,
	tableId: LookupTableId,
): string | undefined {
	return lookupData?.tablesById.get(tableId)?.name;
}

/**
 * Name the data a refusal is about. A lookup table is read under its form id
 * or its suite id (`item-list:<tag>`), so both resolve to the table.
 */
export function previewDataRefusalSubject(
	reason: PreviewDataRefusalReason,
	lookupData: PreviewLookupData | null | undefined,
): PreviewDataRefusalSubject {
	if (reason.kind === "entry-record" || reason.kind === "hidden-calculation")
		return reason;
	if (reason.kind === "project-search") return reason;
	if (reason.kind === "empty-choice-table") {
		return {
			kind: "choices",
			tableName: tableName(lookupData, reason.tableId) ?? reason.tableId,
			...(reason.fieldUuid === undefined
				? {}
				: { fieldUuid: reason.fieldUuid }),
		};
	}
	if (reason.kind === "group-count") return { kind: "group-count" };
	if (reason.kind === "invalid-case-location") return reason;
	if (reason.kind === "owner-without-place") return { kind: "owner-place" };
	if (reason.kind === "unreadable-starting-range")
		return { kind: "starting-range", input: reason.input };
	if (reason.kind === "unoffered-starting-choice")
		return { kind: "starting-choice", input: reason.input };
	const { instanceId } = reason;
	if (instanceId === LOCATIONS_INSTANCE_ID) return { kind: "places" };
	if (instanceId === SESSION_INSTANCE_ID) return { kind: "worker-information" };
	if (instanceId.startsWith(SEARCH_INPUT_INSTANCE_PREFIX))
		return { kind: "search-answers" };
	const table = lookupData?.naming.tables.find(
		(candidate) =>
			candidate.xformInstanceId === instanceId ||
			candidate.fixtureId === instanceId,
	);
	if (table !== undefined) {
		return {
			kind: "table",
			tableName: tableName(lookupData, table.tableId) ?? instanceId,
		};
	}
	return { kind: "other" };
}

/** Whether a lookup table holds the data the refusal found empty, so a new
 * lookup snapshot can change it. */
export function previewDataRefusalReadsTable(
	reason: PreviewDataRefusalReason,
	lookupData: PreviewLookupData | null | undefined,
): boolean {
	const subject = previewDataRefusalSubject(reason, lookupData).kind;
	return (
		subject === "choices" ||
		subject === "table" ||
		(reason.kind === "entry-record" && reason.source === "table")
	);
}

/** Whether an operation moves its case to the worker's place at a level. */
export function operationOwnerMovesToPlace(operation: CaseOperation): boolean {
	return (
		operation.owner?.kind === "term" &&
		operation.owner.term.kind === "owner-location-at-level"
	);
}

/**
 * Where the form moves a case to the worker's place at a level while the
 * worker is assigned nowhere: `form` when one of the form's own operations
 * does, plus the repeats whose operations do, by uuid. The owner's read is
 * printed bare, so Core refuses it as soon as it is calculated: for the
 * form's own operations when the form opens, since a calculate runs whether
 * or not its case block is relevant (`Triggerable.apply`), and for an
 * operation inside a repeat as soon as a row of that repeat exists.
 * `undefined` when nothing is refused; `locations` absent means the snapshot
 * was read without places, which says nothing.
 */
export function ownerMovesToNoPlace(
	operations: readonly CaseOperation[] | undefined,
	locations: readonly unknown[] | undefined,
): { readonly form: boolean; readonly repeats: ReadonlySet<Uuid> } | undefined {
	if (locations === undefined || locations.length > 0) return undefined;
	const moving = (operations ?? []).filter(operationOwnerMovesToPlace);
	if (moving.length === 0) return undefined;
	return {
		form: moving.some((operation) => operation.forEach === undefined),
		repeats: new Set(
			moving.flatMap((operation) =>
				operation.forEach === undefined ? [] : [operation.forEach.repeat],
			),
		),
	};
}

/**
 * Where a form reads, in what its case blocks print, a worker-data key the
 * worker's device lacks (the place keys of a worker assigned nowhere): `form`
 * when the form's own open or close condition or one of its own operations
 * does, plus the repeats whose operations do, by uuid. A case block's values,
 * owner, name and conditions are binds of the form, which Core evaluates as
 * soon as their node exists (`Triggerable.apply`, whether or not the block is
 * relevant), and a bare read of a key the session lacks is refused there
 * (`XPathNodeset.unpack`): when the form opens for the form's own, and as
 * soon as a row exists for one inside a repeat. Preview evaluates these in
 * SQL at submission, so the engine refuses at those points instead. A read
 * under an `if` branch the device never takes is refused here too, which the
 * device would not do. `undefined` when nothing is refused.
 */
export function caseBlocksReadAbsentWorkerKey(
	doc: BlueprintDoc,
	form: Pick<Form, "uuid" | "caseOperations">,
	sessionUser: Readonly<Record<string, string | undefined>>,
): { readonly form: boolean; readonly repeats: ReadonlySet<Uuid> } | undefined {
	let atForm = false;
	const repeats = new Set<Uuid>();
	for (const slot of expressionSlotValues(doc, {
		entity: "form",
		uuid: form.uuid,
	})) {
		const [head, index] = slot.path;
		if (
			head !== "caseOperations" &&
			head !== "openCondition" &&
			head !== "closeCondition"
		)
			continue;
		if (!readsAbsentWorkerKey(slot.expression, sessionUser)) continue;
		const repeat =
			head === "caseOperations" && typeof index === "number"
				? form.caseOperations?.[index]?.forEach?.repeat
				: undefined;
		if (repeat === undefined) atForm = true;
		else repeats.add(repeat);
	}
	return atForm || repeats.size > 0 ? { form: atForm, repeats } : undefined;
}

/** Whether an expression reads, from the session by name, a worker-data key
 *  `sessionUser` lacks and every device need not hold. */
function readsAbsentWorkerKey(
	expression: Expression,
	sessionUser: Readonly<Record<string, string | undefined>>,
): boolean {
	let reads = false;
	walkExpressionTerms(expression, (term) => {
		if (
			term.kind === "session-user" &&
			term.source !== "worker-record" &&
			!(
				Object.hasOwn(sessionUser, term.field) &&
				sessionUser[term.field] !== undefined
			) &&
			!PREVIEW_UNKNOWN_WORKER_KEYS.has(term.field)
		)
			reads = true;
	});
	return reads;
}

/**
 * The first Search prompt whose choices come from a table, which is the
 * prompt a refused Search screen names.
 */
export function searchInputForTable(
	inputs: readonly SearchInputDef[],
	tableId: LookupTableId,
): SearchInputDef | undefined {
	return inputs.find((input) => searchInputOptions(input)?.tableId === tableId);
}
