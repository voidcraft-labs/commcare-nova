import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Field, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { DataInstance } from "../../engine/dataInstance";
import { buildFieldTree } from "../../engine/fieldTree";
import { xpathNodeAtPath } from "../../engine/xpathInstances";
import { evaluateAsync } from "../asyncEvaluator";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

function fixture(): EvalContext {
	const repeatUuid = testUuid("operator-repeat");
	const textUuid = testUuid("operator-text");
	const amountUuid = testUuid("operator-amount");
	const dateUuid = testUuid("operator-date");
	const datetimeUuid = testUuid("operator-datetime");
	const fields: Record<string, Field> = {
		[repeatUuid]: {
			uuid: repeatUuid,
			id: "items",
			kind: "repeat",
			label: proseText("Items"),
			repeat_mode: "user_controlled",
		} as Field,
		[textUuid]: {
			uuid: textUuid,
			id: "text",
			kind: "text",
			label: proseText("Text"),
		} as Field,
		[amountUuid]: {
			uuid: amountUuid,
			id: "amount",
			kind: "int",
			label: proseText("Amount"),
		} as Field,
		[dateUuid]: {
			uuid: dateUuid,
			id: "when",
			kind: "date",
			label: proseText("When"),
		} as Field,
		[datetimeUuid]: {
			uuid: datetimeUuid,
			id: "recorded_at",
			kind: "datetime",
			label: proseText("Recorded at"),
		} as Field,
	};
	const root = testUuid("operator-form");
	const order: Record<string, Uuid[]> = {
		[root]: [repeatUuid],
		[repeatUuid]: [textUuid, amountUuid, dateUuid, datetimeUuid],
	};
	const data = new DataInstance();
	data.initFromFields(buildFieldTree(root, fields, order));
	data.addRepeatInstance("/data/items");
	data.set("/data/items[0]/text", "alpha");
	data.set("/data/items[0]/amount", "10");
	data.set("/data/items[0]/when", "2026-08-24");
	data.set("/data/items[0]/recorded_at", "2026-08-24T15:30:00.000Z");
	data.set("/data/items[1]/text", "beta");
	data.set("/data/items[1]/amount", "20");
	data.set("/data/items[1]/when", "2026-08-25");
	data.set("/data/items[1]/recorded_at", "2026-08-25T18:45:00.000Z");
	const mainInstance = data.asXPathInstance();
	const contextNode = xpathNodeAtPath(mainInstance, "/data/items[0]/text");
	if (!contextNode) throw new Error("Missing operator fixture context.");
	return {
		mainInstance,
		contextNode,
		originalContextNode: contextNode,
		contextPath: contextNode.path,
		position: undefined,
		getValue: (path) => data.get(path),
		resolveHashtag: () => "",
	};
}

function atMainRoot(context: EvalContext): EvalContext {
	const root = context.mainInstance?.root();
	if (root === undefined) throw new Error("Missing operator fixture root.");
	return {
		...context,
		contextNode: root,
		originalContextNode: root,
		contextPath: "/",
	};
}

describe("JavaRosa nodeset binary semantics", () => {
	// Pinned Core 8e9ba8d: XPathEqExpr calls FunctionUtils.unpack() on each
	// operand. XPathCmpExpr and XPathArithExpr reach the same unpack through
	// toNumeric(). This intentionally differs from XPath 1.0 pairwise comparison.
	it("coerces valid empty and singleton nodesets", () => {
		const context = fixture();
		expect(evaluate("/data/items[text = 'missing']/text = ''", context)).toBe(
			true,
		);
		expect(
			evaluate("/data/items[text = 'missing']/text = false()", context),
		).toBe(true);
		expect(
			evaluate("/data/items[text = 'alpha']/text = 'alpha'", context),
		).toBe(true);
		expect(evaluate("/data/items[text = 'alpha']/amount = '10'", context)).toBe(
			true,
		);
		expect(evaluate("/data/items[text = 'alpha']/text = true()", context)).toBe(
			true,
		);
	});

	it("uses typed number and date coercion after singleton unpack", () => {
		const context = fixture();
		expect(evaluate("/data/items[text = 'alpha']/amount < 20", context)).toBe(
			true,
		);
		expect(
			evaluate(
				"/data/items[text = 'alpha']/when = date('2026-08-24')",
				context,
			),
		).toBe(true);
		expect(
			evaluate(
				"/data/items[text = 'alpha']/when < date('2026-08-25')",
				context,
			),
		).toBe(true);
		expect(evaluate("/data/items[text = 'alpha']/amount + 1", context)).toBe(
			11,
		);
		expect(
			evaluate("/data/items[text = 'missing']/amount + 1", context),
		).toBeNaN();
		expect(evaluate("/data/items[text = 'missing']/amount < 1", context)).toBe(
			false,
		);
		expect(
			evaluate(
				"/data/items[text = 'alpha']/amount = /data/items[text = 'beta']/amount",
				context,
			),
		).toBe(false);
	});

	it("keeps double(nodeset) on Core's whole-day numeric path", () => {
		const context = fixture();
		expect(
			evaluate("double(/data/items[text = 'alpha']/recorded_at)", context),
		).toBe(evaluate("number(date('2026-08-24'))", context));
	});

	it("throws instead of pairwise-comparing multi-node sets", () => {
		const context = atMainRoot(fixture());
		for (const expression of [
			"/data/items/text = 'alpha'",
			"'alpha' = /data/items/text",
			"/data/items/text = /data/items/text",
			"/data/items/amount < 30",
			"/data/items/amount + 1",
			"/data/items/text and true()",
		]) {
			expect(() => evaluate(expression, context), expression).toThrow(
				"more than one node",
			);
		}
	});

	it("distinguishes an invalid path from a valid empty nodeset", () => {
		expect(() => evaluate("/data/not_authored = ''", fixture())).toThrow(
			"does not exist in the instance",
		);
		expect(() =>
			evaluate("/data/items[text = 'missing']/not_authored", fixture()),
		).toThrow("does not exist in the instance");
	});

	it("shares the same unpack and coercion rules after awaiting", async () => {
		const context = fixture();
		const delay = vi.fn(async () => undefined);
		await expect(
			evaluateAsync(
				"/data/items[text = 'alpha']/amount < sleep(0, 20)",
				context,
				{ delay },
			),
		).resolves.toBe(true);
		await expect(
			evaluateAsync(
				"/data/items[text = 'alpha']/when = sleep(0, date('2026-08-24'))",
				context,
				{ delay },
			),
		).resolves.toBe(true);
		await expect(
			evaluateAsync(
				"sleep(0, /data/items[text = 'missing']/text) = false()",
				context,
				{ delay },
			),
		).resolves.toBe(true);
		await expect(
			evaluateAsync(
				"sleep(0, /data/items/text) = 'alpha'",
				atMainRoot(context),
				{ delay },
			),
		).rejects.toThrow("more than one node");
	});
});
