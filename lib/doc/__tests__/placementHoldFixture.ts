/**
 * A follow-up form with every kind of held placement target: the own case
 * and an update of it (two case operations), the form's own close, and a
 * query repeat over open patients. Built on the placement planner's own
 * fixture, so a hold's verdict is read over the same shapes its rules are
 * tested on.
 */
import {
	OP,
	OWN,
	own,
	placementFixture,
	read,
	U,
} from "@/lib/commcare/__tests__/placementFixture";
import type { PlacementHoldEntry } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	Form,
	OwnClosePlacement,
	Uuid,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";

export { OP, OWN, read, U };

export const UPDATE = OP("upd");
export const VISITS = U("visits");

/** Open patients, a query that reads no answer of the form. */
export const OPEN_PATIENTS: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("patient", "status"), literal("open"))],
	},
	value: prop("patient", "case_id"),
};

/** Patients named by the form's `name` answer: a query over an answer, which
 *  model iteration cannot run. */
export const PATIENTS_NAMED: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("patient", "case_name"), term(formField(U("name"))))],
	},
	value: prop("patient", "case_id"),
};

export function update(extra: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: UPDATE,
		id: "upd",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "status", value: read("status") }],
		...extra,
	} as CaseOperation;
}

export const saveToCase = (
	...path: [string, ...string[]]
): Extract<CasePlacement, { kind: "save-to-case" }> => ({
	kind: "save-to-case",
	path,
});

export const ownCloseAt = (
	...path: [string, ...string[]]
): OwnClosePlacement => ({
	kind: "save-to-case",
	path,
});

export interface HoldFixture {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
}

/** The fixture, with `configure` writing holds or shapes onto it. */
export function holdFixture(
	configure: (doc: BlueprintDoc, formUuid: Uuid) => void = () => {},
	operations: () => CaseOperation[] = () => [own(), update()],
	formType: Form["type"] = "followup",
): HoldFixture {
	const { doc, formUuid } = placementFixture(formType, {
		operations,
		extraRoot: [
			{
				kind: "repeat",
				id: "visits",
				repeat_mode: "query_bound",
				data_source: { ids_query: OPEN_PATIENTS },
				children: [{ kind: "text", id: "visit_note" }],
			},
		],
	});
	configure(doc, formUuid);
	return { doc, formUuid };
}

export function operationHold(
	formUuid: Uuid,
	operationUuid: Uuid,
	placement: CasePlacement | null,
): PlacementHoldEntry {
	return { target: "case-operation", formUuid, operationUuid, placement };
}

export function ownCloseHold(
	formUuid: Uuid,
	placement: OwnClosePlacement | null,
): PlacementHoldEntry {
	return { target: "own-close", formUuid, placement };
}

export function queryRepeatHold(
	fieldUuid: Uuid,
	placement: "model-iteration" | "count" | null,
): PlacementHoldEntry {
	return { target: "query-repeat", fieldUuid, placement };
}
