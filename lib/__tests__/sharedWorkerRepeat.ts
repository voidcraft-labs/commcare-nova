import { testUuid } from "@/__tests__/helpers/uuid";
import { formField, literal, term } from "@/lib/domain/expression";
import { buildDoc, caseListConfig, f } from "./docHelpers";

/** Both entries use the same XForm. Only the second entry loads the worker as its own case. */
export function sharedWorkerRepeat(writesOwn: boolean, appId?: string) {
	const source = testUuid("repeated-worker-source-menu");
	const destination = testUuid("repeated-worker-shared-menu");
	const shared = testUuid("repeated-worker-shared-form");
	const selection = testUuid("repeated-worker-own-selection");
	const own = testUuid("repeated-worker-own-arm");
	const form = testUuid("repeated-worker-content");
	const repeat = testUuid("repeated-worker-shared-repeat");
	const answer = testUuid("repeated-worker-shared-answer");
	const worker = testUuid("repeated-worker-shared-change");
	const propertyUuid = testUuid("repeated-worker-shared-property");
	const property = "visit_note";

	const patientMenu = () => ({
		caseType: "patient",
		caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
	});
	const doc = buildDoc(
		{
			appId,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: property, label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					...patientMenu(),
					uuid: source,
					name: "Source",
					forms: [
						{
							uuid: form,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "repeat",
									uuid: repeat,
									id: "kids",
									children: [f({ kind: "text", uuid: answer, id: "kid" })],
								}),
							],
						},
					],
				},
				{
					...patientMenu(),
					uuid: destination,
					name: "Shared",
					forms: [
						{
							uuid: shared,
							name: "Shared visit",
							type: "followup",
							fields: [],
						},
					],
				},
			],
		},
		(draft) => {
			draft.userProperties = {
				[propertyUuid]: {
					uuid: propertyUuid,
					slug: property,
					label: "Visit note",
				},
			};
			draft.userPropertyOrder = [propertyUuid];
			draft.modules[source].heldKind = "advanced";
			draft.modules[destination].heldKind = "advanced";
			draft.forms[form].caseSelections = [
				{
					uuid: selection,
					name: "Patient",
					tag: "patient",
					caseType: "patient",
					source: { kind: "choose", module: source },
				},
			];
			draft.forms[shared].shadowOf = {
				form: form,
				selections: [
					{
						kind: "replace",
						selection,
						caseType: "commcare-user",
						source: { kind: "worker-record" },
					},
				],
			};
			draft.forms[form].caseOperations = [
				...(writesOwn
					? [
							{
								uuid: own,
								id: "patient",
								action: "own" as const,
								writes: [
									{
										property,
										value: term(literal("earlier write")),
									},
								],
							},
						]
					: []),
				{
					uuid: worker,
					id: "worker",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					forEach: { repeat },
					writes: [{ property, value: term(formField(answer)) }],
				},
			];
		},
	);
	return { doc, form, shared, own, worker };
}
