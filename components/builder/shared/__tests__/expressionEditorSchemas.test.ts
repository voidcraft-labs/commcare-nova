import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { lookupColumnIdSchema, lookupTableIdSchema } from "@/lib/domain";
import {
	checkExpression,
	literal,
	literalType,
	prop,
	type ScalarType,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { editorExpressionContext } from "../editorTypeContext";
import {
	type ExpressionEditContext,
	expressionCardSchemas,
	isAuthorableExpressionKind,
} from "../expressionEditorSchemas";
import { defaultExpressionForSlot } from "../primitives/ExpressionPicker";

describe("expression contextual authorability", () => {
	it("requires a populated lookup catalog and refuses nested row lookups", () => {
		const table = {
			id: lookupTableIdSchema.parse("00000000-0000-7000-8000-000000000001"),
			name: "Clinics",
			columns: [
				{
					id: lookupColumnIdSchema.parse(
						"00000000-0000-7000-8000-000000000002",
					),
					label: "Code",
					wireName: "code",
					dataType: "text" as const,
				},
			],
		};
		expect(isAuthorableExpressionKind("table-lookup")).toBe(false);
		expect(
			isAuthorableExpressionKind("table-lookup", { lookupTables: [] }),
		).toBe(false);
		expect(
			isAuthorableExpressionKind("table-lookup", {
				lookupTables: [{ ...table, columns: [] }],
			}),
		).toBe(false);
		expect(
			isAuthorableExpressionKind("table-lookup", { lookupTables: [table] }),
		).toBe(true);
		expect(
			isAuthorableExpressionKind("table-lookup", {
				lookupTables: [table],
				tableScope: { tableId: table.id, columns: table.columns },
			}),
		).toBe(false);
	});
});

const context: ExpressionEditContext = expressionEditorFixture(
	"calculated-column",
	{
		caseTypes: [],
		currentCaseType: "",
		knownInputs: [],
	},
).context;
describe("actual slot defaults used by expression menus", () => {
	it.each(["if", "switch", "coalesce"] as const)(
		"seeds all %s result branches for an integer slot",
		(kind) => {
			const constraint = { accepts: new Set<ScalarType>(["int"]) };
			const next =
				kind === "if"
					? defaultExpressionForSlot(
							expressionCardSchemas.if,
							context,
							constraint,
							"value",
						)
					: kind === "switch"
						? defaultExpressionForSlot(
								expressionCardSchemas.switch,
								context,
								constraint,
								"value",
							)
						: defaultExpressionForSlot(
								expressionCardSchemas.coalesce,
								context,
								constraint,
								"value",
							);
			expect(
				checkExpression(next, editorExpressionContext(context)),
			).toMatchObject({ errors: [] });
			const branches =
				next.kind === "if"
					? [next.then, next.else]
					: next.kind === "switch"
						? [...next.cases.map((c) => c.then), next.fallback]
						: next.kind === "coalesce"
							? next.values
							: [];
			expect(branches.length).toBeGreaterThan(0);
			for (const branch of branches) {
				if (branch.kind !== "term" || branch.term.kind !== "literal")
					throw new Error("Expected a typed initial literal");
				expect(literalType(branch.term)).toBe("int");
			}
		},
	);
	it("adapts date addition to a datetime-only slot while retaining its interval", () => {
		const next = defaultExpressionForSlot(
			expressionCardSchemas["date-add"],
			context,
			{ accepts: new Set<ScalarType>(["datetime"]) },
			"value",
		);
		expect(next).toEqual({
			...expressionCardSchemas["date-add"].defaultValue(context),
			date: { kind: "now" },
		});
		expect(
			checkExpression(next, editorExpressionContext(context)),
		).toMatchObject({ errors: [] });
	});
	it("prefers a compatible case property for subjects and a typed literal for ordinary values", () => {
		const ctx: ExpressionEditContext = {
			...context,
			currentCaseType: "patient",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		};
		const constraint = { accepts: new Set<ScalarType>(["int"]) };
		expect(
			defaultExpressionForSlot(
				expressionCardSchemas.term,
				ctx,
				constraint,
				"subject",
			),
		).toEqual(term(prop("patient", "age")));
		expect(
			defaultExpressionForSlot(
				expressionCardSchemas.term,
				ctx,
				constraint,
				"value",
			),
		).toEqual(term(literal(0)));
	});
});
