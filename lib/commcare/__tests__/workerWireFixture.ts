/** Schema- and whole-gate-admitted worker property identities for native wire proof. */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import {
	eq,
	literal,
	sessionUser,
	sessionUserProperty,
	term,
} from "@/lib/domain/expression";
import { runValidation } from "../validator/runner";
export const WORKER_PROPERTY = testUuid("worker-property-supervisor");
export const workerSlugs = [
	"is_supervisor",
	"district-code",
	"supervision_status",
] as const;
export function workerWireFixture(
	slug: (typeof workerSlugs)[number] = "is_supervisor",
) {
	const doc = buildDoc({
		appName: "Worker reference wire",
		modules: [
			{
				name: "Supervisors",
				displayCondition: eq(
					sessionUserProperty(WORKER_PROPERTY),
					literal("n"),
				),
				forms: [
					{
						name: "Check",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								id: "current_worker_id",
								calculate: "#user/hq_user_id",
							}),
							f({
								kind: "hidden",
								id: "current_worker_login",
								calculate: "#user/username",
							}),
							f({
								kind: "hidden",
								id: "current_worker_name",
								calculate: "#user/case_name",
							}),
							f({
								kind: "text",
								id: "supervisor_note",
								label: "Supervisor note",
							}),
						],
					},
				],
			},
		],
	});
	doc.userProperties = {
		[WORKER_PROPERTY]: {
			uuid: WORKER_PROPERTY,
			slug,
			label: "Worker property",
		},
	};
	doc.userPropertyOrder = [WORKER_PROPERTY];
	const moduleUuid = doc.moduleOrder[0],
		formUuid = doc.formOrder[moduleUuid][0],
		fieldUuid = doc.fieldOrder[formUuid].find(
			(uuid) => doc.fields[uuid].id === "supervisor_note",
		);
	if (!fieldUuid) throw new Error("Expected supervisor question");
	const field = doc.fields[fieldUuid];
	if (field.kind !== "text") throw new Error("Expected text question");
	field.relevant = eq(
		{
			kind: "session-user-property",
			userPropertyUuid: WORKER_PROPERTY,
			source: "worker-record",
		},
		literal("n"),
	);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return { doc, moduleUuid, formUuid, fieldUuid };
}

export const WORKER_PLACE_OWNER_FORM = testUuid("worker-place-owner-form");
/**
 * The worker-place owner document: a follow-up, "Move to my group", whose
 * case change moves the chosen patient to the worker's case-sharing group,
 * read from the session (`external-user('commcare_primary_case_sharing_id')`).
 * HQ writes that key only for a worker assigned somewhere
 * (`models.py::get_user_session_data`), and a case block's owner is a bind
 * Core calculates as the form opens, so the form opens for a placed worker
 * and is refused at open for a worker assigned nowhere.
 */
export function workerPlaceOwnerFixture(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Worker place owner",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "worker-place-owner-form",
						name: "Move to my group",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	// After the own case `buildDoc` gives the follow-up.
	doc.forms[WORKER_PLACE_OWNER_FORM].caseOperations = [
		...(doc.forms[WORKER_PLACE_OWNER_FORM].caseOperations ?? []),
		{
			uuid: testUuid("worker-place-owner-move"),
			id: "move",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			owner: term(sessionUser("commcare_primary_case_sharing_id")),
		},
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}
