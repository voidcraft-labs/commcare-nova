import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { concat, eq, literal, term } from "../expression/builders";
import { printFormExpression } from "../expression/print";
import type { Expression } from "../expression/types";
import { referenceNames } from "../referenceNames";

describe("expression identity projection", () => {
	it("projects current field paths while retaining literal text and stored identities", () => {
		const form = testUuid("projection-form");
		const field = testUuid("projection-field");
		const group = testUuid("projection-group");
		const doc = {
			forms: { [form]: {} },
			fields: { [field]: { id: "age" }, [group]: { id: "details" } },
			fieldOrder: { [form]: [group], [group]: [field] },
		};
		const expression = concat(
			term(literal("literal #form/age")),
			term({ kind: "field", uuid: field }),
			term({ kind: "field", uuid: field, spelling: "absolute" }),
		);
		const original = structuredClone(expression);
		const before = printFormExpression(expression, referenceNames(doc));
		expect(before.text).toBe(
			"concat('literal #form/age', #form/details/age, /data/details/age)",
		);
		expect(before.unresolved).toEqual([]);
		doc.fields[field].id = "years";
		const after = printFormExpression(expression, referenceNames(doc));
		expect(after.text).toBe(
			"concat('literal #form/age', #form/details/years, /data/details/years)",
		);
		expect(after.unresolved).toEqual([]);
		expect(expression).toEqual(original);
	});

	it("identifies a missing worker property without printing its UUID", () => {
		const missing = testUuid("missing-expression-worker-property");
		const expression: Expression = eq(
			term({
				kind: "session-user-property",
				userPropertyUuid: missing,
				source: "worker-record",
			}),
			literal("north"),
		);
		const projected = printFormExpression(expression, {
			userPropertySlug: () => undefined,
		});
		expect(projected.text).toBe("[reference needs repair] = 'north'");
		expect(projected.unresolved).toEqual([
			{ path: ["left"], reason: "identity" },
		]);
		expect(projected.text).not.toContain(missing);
	});
});
