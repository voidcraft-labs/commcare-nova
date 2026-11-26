import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type CaseOperation, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-positioned-case-create";
const uuid = (name: string) => targetedUuid(ID, name);

export function positionedCaseCreate() {
	const form = uuid("visit");
	const change: CaseOperation = {
		uuid: uuid("open_visit"),
		id: "open_visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(formField(uuid("visit_name"))),
	};
	const doc = buildDoc(
		{
			appId: ID,
			appName: "Visit records",
			caseTypes: [{ name: "visit", properties: [] }],
			modules: [
				{
					uuid: uuid("visits"),
					name: "Visits",
					forms: [
						{
							uuid: form,
							name: "Record a visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									uuid: uuid("visit_name"),
									id: "visit_name",
									label: proseText("Visit name"),
								}),
								f({
									kind: "case_change",
									uuid: uuid("save_visit"),
									id: "save_visit",
									operationUuid: change.uuid,
								}),
								f({
									kind: "text",
									uuid: uuid("notes"),
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[form].caseOperations = [change];
		},
	);
	return targetedDocument({
		id: ID,
		rows: [
			"a positioned case create and its guard remain together between authored questions",
		],
		doc,
		expected: {
			intent: [
				answerHeld("visit-name", form, "/data/visit_name", "Garden visit", "A"),
			],
		},
	});
}
