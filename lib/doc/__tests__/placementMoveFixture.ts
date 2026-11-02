/**
 * A patient app the commit gate admits, shaped for identity moves: a
 * registration that creates a child case at its root, a follow-up whose own
 * case saves typed answers and holds a query repeat over open patients in a
 * group,
 * and a close form whose close needs a block of its own. Every form's case
 * changes are planned by the production "Saves to" planner (`buildDoc`'s
 * `caseWrite`), and a test holds the placements the planner gives, as a
 * publish would, before it edits.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { planPlacements } from "@/lib/commcare/placement";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	proseText,
	type Uuid,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";

export const U = (id: string): Uuid => testUuid(`move-fld-${id}`);
export const OPT = (value: string): Uuid => testUuid(`move-opt-${value}`);
export const REGISTRATION = testUuid("move-form-registration");
export const FOLLOWUP = testUuid("move-form-followup");
export const DISCHARGE = testUuid("move-form-discharge");
export const PATIENTS = testUuid("move-mod-patients");

/** A bare read of the answer `id`. */
export const read = (id: string): Expression => term(formField(U(id)));

/** `status` holds the choice `value`. */
export const statusIs = (value: string): Expression =>
	({
		kind: "term",
		term: { kind: "choice", field: U("status"), options: [OPT(value)] },
	}) as Expression;

/** Open patients: a query that reads no answer of the form. */
export const OPEN_PATIENTS: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("patient", "visit_status"), literal("open"))],
	},
	value: prop("patient", "case_id"),
};

/** Patients named by the form's `remark` answer, which model iteration
 *  cannot run. */
export const PATIENTS_NAMED: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("patient", "case_name"), term(formField(U("remark"))))],
	},
	value: prop("patient", "case_id"),
};

const field = (spec: Parameters<typeof f>[0]) =>
	f({ ...spec, uuid: `move-fld-${spec.id}` });

const statusOptions = {
	kind: "inline" as const,
	options: ["yes", "no"].map((value) => ({
		value,
		label: proseText(value),
		uuid: OPT(value),
	})),
};

export function moveFixture(): BlueprintDoc {
	return buildDoc({
		appName: "Identity moves",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "visit_status", label: "Visit status" },
					{ name: "remark", label: "Remark" },
				],
			},
			{
				name: "kid",
				parent_type: "patient",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				uuid: "move-mod-patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "move-form-registration",
						name: "Registration",
						type: "registration",
						fields: [
							field({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							field({
								kind: "text",
								id: "first_kid",
								caseWrite: { caseType: "kid", property: "case_name" },
							}),
							field({ kind: "text", id: "nickname" }),
						],
					},
					{
						uuid: "move-form-followup",
						name: "Follow-up visit",
						type: "followup",
						fields: [
							field({
								kind: "int",
								id: "age",
								caseWrite: { caseType: "patient", property: "age" },
							}),
							field({
								kind: "single_select",
								id: "status",
								optionsSource: statusOptions,
								caseWrite: { caseType: "patient", property: "visit_status" },
							}),
							field({
								kind: "text",
								id: "remark",
								caseWrite: { caseType: "patient", property: "remark" },
							}),
							field({
								kind: "group",
								id: "extra",
								children: [
									field({ kind: "text", id: "extra_note" }),
									field({
										kind: "repeat",
										id: "visits",
										label: "Visits",
										repeat_mode: "query_bound",
										data_source: { ids_query: OPEN_PATIENTS },
										children: [field({ kind: "text", id: "visit_note" })],
									}),
								],
							}),
							field({
								kind: "repeat",
								id: "rounds",
								repeat_mode: "user_controlled",
								children: [field({ kind: "text", id: "round_note" })],
							}),
						],
					},
					{
						uuid: "move-form-discharge",
						name: "Discharge",
						type: "close",
						closeCondition: eq(read("reason"), term(literal("moved"))),
						fields: [field({ kind: "text", id: "reason" })],
					},
				],
			},
			{
				name: "Kids",
				caseType: "kid",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Kid visit",
						type: "followup",
						fields: [field({ kind: "text", id: "kid_note" })],
					},
				],
			},
		],
	});
}

/** The registration with a second child case at its root, named by
 *  `nickname`, after the first. */
export function withSecondKid(doc: BlueprintDoc): BlueprintDoc {
	const form = doc.forms[REGISTRATION];
	const first = form.caseOperations?.find((op) => op.action === "create");
	if (first === undefined) throw new Error("The registration creates a kid.");
	form.caseOperations = [
		...(form.caseOperations ?? []),
		{
			...first,
			uuid: testUuid("move-op-second-kid"),
			id: "second_kid",
			name: read("nickname"),
		} as CaseOperation,
	];
	return doc;
}

/** The operation of `formUuid` that `pick` finds. */
export function operationOf(
	doc: BlueprintDoc,
	formUuid: Uuid,
	pick: (op: CaseOperation) => boolean,
): CaseOperation {
	const found = doc.forms[formUuid]?.caseOperations?.find(pick);
	if (found === undefined)
		throw new Error(`The fixture's form ${formUuid} holds that change.`);
	return found;
}

export const isOwn = (op: CaseOperation) => op.action === "own";
export const isCreate = (op: CaseOperation) => op.action === "create";

/**
 * Hold every placement the planner gives `formUuid`, as a publish records
 * it: each operation's, and the own close's where it stands in a block of
 * its own. Edits the document in place, so it plans over a shallow copy:
 * `planPlacements` memoizes per document object, and a plan cached on
 * `doc` itself would go stale the moment the holds land on it.
 */
export function holdPlanned(doc: BlueprintDoc, formUuid: Uuid): BlueprintDoc {
	const { placements } = planPlacements({ ...doc }, formUuid);
	const form = doc.forms[formUuid];
	for (const op of form.caseOperations ?? []) {
		const planned = placements.get(op.uuid);
		if (planned !== undefined) op.placement = planned.placement;
	}
	const ownClose = placements.get("own-close");
	if (
		ownClose !== undefined &&
		ownClose.sharesWith === undefined &&
		ownClose.placement.kind === "save-to-case"
	)
		form.ownClosePlacement = {
			kind: "save-to-case",
			path: ownClose.placement.path,
		};
	return doc;
}

/** Hold `placement` on the follow-up's query repeat. */
export function holdVisits(
	doc: BlueprintDoc,
	placement: "model-iteration" | "count",
): BlueprintDoc {
	const visits = doc.fields[U("visits")];
	if (visits?.kind !== "repeat" || visits.repeat_mode !== "query_bound")
		throw new Error("The follow-up's visits is a query repeat.");
	doc.fields[U("visits")] = { ...visits, placement };
	return doc;
}

export const holds = (...entries: PlacementHoldEntry[]): Mutation => ({
	kind: "holdPlacements",
	holds: entries,
});

/** The gate's verdict on `batch` over `doc`, as every editor reaches it. */
export function verdict(doc: BlueprintDoc, batch: readonly Mutation[]) {
	return mutationCommitVerdict(doc, batch, LOOKUP_CONTEXT_UNAVAILABLE);
}

/** The codes the gate refuses `batch` with; empty where it admits it. */
export function refusalCodes(
	doc: BlueprintDoc,
	batch: readonly Mutation[],
): string[] {
	const result = verdict(doc, batch);
	return result.ok ? [] : result.findings.map((finding) => finding.code);
}

export const THIRD_KID = testUuid("move-op-third-kid");

/**
 * The registration creates two kids, held at the first and second subcase
 * places. The tab removes the first (the second moves to the first place)
 * and then takes the removal back, restoring both holds. Meanwhile a peer
 * adds a third kid and a publish records it at the second place, the
 * first free one on the head it published.
 */
export function republishedRegistration() {
	const base = holdPlanned(withSecondKid(moveFixture()), REGISTRATION);
	const [first, second] = (
		base.forms[REGISTRATION].caseOperations ?? []
	).filter(isCreate);
	const removed = verdict(
		base,
		withIdentityMoves(base, [
			{
				kind: "updateForm",
				uuid: REGISTRATION,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: first.uuid },
			} as Mutation,
		]).batch,
	);
	if (!removed.ok) throw new Error("The removal commits.");
	const { placement: firstHold, ...firstUnheld } = first;
	const undo: Mutation[] = [
		{
			kind: "updateForm",
			uuid: REGISTRATION,
			patch: {},
			caseOperationChange: { operation: "add", value: firstUnheld },
		} as Mutation,
		{
			kind: "updateForm",
			uuid: REGISTRATION,
			patch: {},
			caseOperationPatch: {
				operation: "move",
				uuid: first.uuid,
				after: operationOf(base, REGISTRATION, isOwn).uuid,
			},
		} as Mutation,
		holds(
			{
				target: "case-operation",
				formUuid: REGISTRATION,
				operationUuid: first.uuid,
				placement: firstHold ?? null,
			},
			{
				target: "case-operation",
				formUuid: REGISTRATION,
				operationUuid: second.uuid,
				placement: second.placement ?? null,
			},
		),
	];
	const third = {
		...firstUnheld,
		uuid: THIRD_KID,
		id: "third_kid",
	} as CaseOperation;
	const peer = verdict(removed.nextDoc, [
		{
			kind: "updateForm",
			uuid: REGISTRATION,
			patch: {},
			caseOperationChange: { operation: "add", value: third },
		} as Mutation,
	]);
	if (!peer.ok) throw new Error("The peer's kid commits.");
	const planned = planPlacements(peer.nextDoc, REGISTRATION).placements.get(
		THIRD_KID,
	)?.placement;
	if (planned === undefined) throw new Error("The third kid has a place.");
	const published = verdict(peer.nextDoc, [
		holds({
			target: "case-operation",
			formUuid: REGISTRATION,
			operationUuid: THIRD_KID,
			placement: planned,
		}),
	]);
	if (!published.ok) throw new Error("The publish's record commits.");
	return {
		tab: removed.nextDoc,
		unpublished: peer.nextDoc,
		head: published.nextDoc,
		undo,
		first: first.uuid,
		firstHold,
		second: second.uuid,
	};
}
