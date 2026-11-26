import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseWriteVia } from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import { buildDoc, caseListConfig, f } from "./docHelpers";

export function parentUserWriteFixture(appId?: string, withLinkedWrite = true) {
	const form = testUuid("parent-user-route-form");
	const mode = testUuid("parent-user-route-mode");
	const note = testUuid("parent-user-route-note");
	const own = testUuid("parent-user-route-own");
	const via: CaseWriteVia = [
		{ identifier: "parent", throughCaseType: "family" },
		{ identifier: "user", throughCaseType: "household" },
	];
	const linkedWrite = {
		property: "linked_note",
		value: term(formField(note)),
		via,
	};
	const localWrite = { property: "local_note", value: term(formField(mode)) };
	const doc = buildDoc(
		{
			appId,
			caseTypes: [
				{
					name: "person",
					parent_type: "family",
					properties: [{ name: "local_note", label: "Local note" }],
				},
				{
					name: "family",
					properties: [],
					relations: [
						{
							identifier: "user",
							targetType: "household",
							relationship: "child",
						},
					],
				},
				{
					name: "household",
					properties: [{ name: "linked_note", label: "Household note" }],
				},
			],
			modules: [
				{
					name: "People",
					caseType: "person",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: form,
							name: "Visit",
							type: "followup",
							fields: [
								f({ uuid: mode, id: "mode", kind: "text" }),
								f({
									uuid: note,
									id: "note",
									kind: "text",
									relevant: eq(term(formField(mode)), literal("show")),
								}),
							],
						},
					],
				},
			],
		},
		(draft) => {
			draft.forms[form].caseOperations = [
				{
					uuid: own,
					id: "person",
					action: "own",
					writes: withLinkedWrite ? [localWrite, linkedWrite] : [localWrite],
				},
			];
		},
	);
	return { doc, form, note, own, via, linkedWrite, localWrite };
}
