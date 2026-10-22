import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { expressionCandidateDoc } from "@/lib/doc/hooks/useExpressionSlotContext";
import {
	type BlueprintDoc,
	type CaseType,
	type Column,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	double,
	prop,
	relationStep,
	slotContext,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { nextColumnDisplay } from "../columnDisplayState";
import { admittedWorkspace, commitWorkspace } from "./admittedWorkspace";

it("does not restore a related calculation after a peer enables Search", () => {
	const caseTypes: CaseType[] = [
		{
			name: "patient",
			parent_type: "household",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
			],
		},
		{
			name: "household",
			properties: [
				{ name: "score", label: proseText("Score"), data_type: "int" },
			],
		},
	];
	const uuid = testUuid("retained-calculation");
	const original = calculatedColumn(
		uuid,
		"Score",
		double(
			term(prop("patient", "score", ancestorPath(relationStep("parent")))),
		),
	);
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = [original];
	config.listColumnOrder = [uuid];
	config.detailColumnOrder = [uuid];
	const { doc, moduleUuid } = admittedWorkspace(caseTypes, config, "patient");
	const plain = plainColumn(uuid, "case_name", "Score");
	const displayContext = (current: BlueprintDoc) => ({
		caseTypes,
		currentCaseType: "patient",
		moduleUuid,
		expressionContextForColumn: (column: Column) => {
			const slot = {
				entity: "module",
				uuid: moduleUuid,
				slot: "case_list_column_expression",
				member: { columnUuid: uuid },
			} as const;
			const candidate = expressionCandidateDoc(current, slot, {
				entity: "column",
				value: column,
			});
			return candidate === undefined
				? undefined
				: slotContext(candidate, slot, new Map());
		},
	});
	expect(
		nextColumnDisplay(
			plain,
			"calculated",
			displayContext(doc),
			new Map([["calculated", original]]),
		),
	).toEqual(original);
	const after = commitWorkspace(doc, [
		{
			kind: "updateColumn",
			moduleUuid,
			uuid,
			column: { kind: "plain", field: "case_name", header: "Score" },
		},
		{
			kind: "addSearchInput",
			moduleUuid,
			searchInput: simpleSearchInputDef(
				testUuid("enable-search"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		},
	]);
	const next = nextColumnDisplay(
		plain,
		"calculated",
		displayContext(after),
		new Map([["calculated", original]]),
	);
	expect(next).toMatchObject({
		kind: "calculated",
		expression: { kind: "term", term: { kind: "literal", value: "" } },
	});
	if (next?.kind !== "calculated")
		throw new Error("missing calculation choice");
	const committed = commitWorkspace(after, [
		{
			kind: "updateColumn",
			moduleUuid,
			uuid,
			column: {
				kind: "calculated",
				header: next.header,
				expression: next.expression,
			},
		},
	]);
	expect(committed.modules[moduleUuid].caseListConfig?.columns[0]).toEqual(
		next,
	);
});
