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
	type SearchInputDef,
	searchInputOptions,
	type Uuid,
} from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { PreviewXPathRuntimeError } from "../xpath/runtimeError";
import { XPathInvalidPathError } from "../xpath/runtimeValues";
import type { XPathRuntimeFailure } from "../xpath/workerProtocol";
import type { PreviewLookupData } from "./lookupEvaluation";

/** The places instance's id, in every form and link that reads them. */
const LOCATIONS_INSTANCE_ID = "locations";
const SEARCH_INPUT_INSTANCE_PREFIX = "search-input:";

export type PreviewDataRefusalReason =
	/** A value read below an instance that holds nothing, named by its id. */
	| { readonly kind: "empty-instance"; readonly instanceId: string }
	/** A choice list whose table has no rows. `fieldUuid` is the form's
	 * question, where the refusal came from one. */
	| {
			readonly kind: "empty-choice-table";
			readonly tableId: LookupTableId;
			readonly fieldUuid?: Uuid;
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
			reason.kind === "empty-instance"
				? `CommCare refuses this read: the instance “${reason.instanceId}” holds nothing on the device.`
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
	| { readonly kind: "places" }
	| { readonly kind: "table"; readonly tableName: string }
	| {
			readonly kind: "choices";
			readonly tableName: string;
			readonly fieldUuid?: Uuid;
	  }
	| { readonly kind: "search-answers" }
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
	if (reason.kind === "empty-choice-table") {
		return {
			kind: "choices",
			tableName: tableName(lookupData, reason.tableId) ?? reason.tableId,
			...(reason.fieldUuid === undefined
				? {}
				: { fieldUuid: reason.fieldUuid }),
		};
	}
	const { instanceId } = reason;
	if (instanceId === LOCATIONS_INSTANCE_ID) return { kind: "places" };
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
