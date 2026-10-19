import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type Field, fieldSchema, type Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { instantDatetimeValue } from "@/lib/domain/temporalValues";
import { castAnswerText } from "../../engine/answerCast";
import { DataInstance } from "../../engine/dataInstance";
import { buildFieldTree } from "../../engine/fieldTree";
import { evaluateAsync } from "../asyncEvaluator";
import { xpathToString } from "../coerce";
import { evaluate } from "../evaluator";
import type { EvalContext, XPathValue } from "../types";
import {
	CORE_DATE_PARITY,
	CORE_DATE_PARITY_ZONES,
	type CoreDateParityNode,
	type CoreDateParityRow,
	type CoreDateParityZone,
} from "./fixtures/coreDateParity";

// The table's expected column is Core's, held in the lane by
// CoreDateParityRuntimeTest; here the same rows run through Preview's
// evaluator over a real main instance, in each device zone in turn.

const FIELD_KIND: Record<CoreDateParityNode["held"], Field["kind"]> = {
	datetime: "datetime",
	date: "date",
	text: "text",
	"setvalue-datetime": "datetime",
};

/** The answer text Preview's instance holds for each kind of node, written
 * the way the engine writes it in `zone`. */
function heldText(node: CoreDateParityNode, zone: string): string {
	switch (node.held) {
		case "datetime":
			return instantDatetimeValue(Date.parse(node.value), zone);
		case "date":
		case "text":
			return node.value;
		case "setvalue-datetime": {
			// The engine's own setvalue cast (Core's DateTimeData.cast), whose
			// held text the next read returns exactly.
			const cast = castAnswerText("datetime", node.value, zone);
			if (!cast.ok) throw new Error(`Core refuses ${node.value}.`);
			return cast.text;
		}
	}
}

function contextFor(row: CoreDateParityRow, zone: string): EvalContext {
	const root = testUuid(`core-date-parity-${row.id}`);
	const fields: Record<string, Field> = {};
	const order: Record<string, Uuid[]> = { [root]: [] };
	for (const node of row.nodes ?? []) {
		const uuid = testUuid(`core-date-parity-${row.id}-${node.name}`);
		fields[uuid] = fieldSchema.parse({
			uuid,
			id: node.name,
			kind: FIELD_KIND[node.held],
			label: proseText(node.name),
		});
		order[root]?.push(uuid);
	}
	const data = new DataInstance();
	data.initFromFields(buildFieldTree(root, fields, order));
	for (const node of row.nodes ?? []) {
		data.set(`/data/${node.name}`, heldText(node, zone));
	}
	const mainInstance = data.asXPathInstance();
	const rootNode = mainInstance.root();
	return {
		mainInstance,
		contextNode: rootNode,
		originalContextNode: rootNode,
		contextPath: "/",
		position: undefined,
		getValue: (path) => data.get(path),
		resolveHashtag: () => "",
	};
}

function expectCoreResult(
	result: XPathValue,
	expected: string,
	label: string,
): void {
	if (typeof result === "number") {
		expect(Math.abs(result - Number(expected)), label).toBeLessThan(1e-9);
	} else {
		expect(xpathToString(result), label).toBe(expected);
	}
}

describe("Preview dates against Core in four device zones", () => {
	it("evaluates every row as Core does, synchronously and in the worker's evaluator", async () => {
		const originalTimeZone = process.env.TZ;
		vi.useFakeTimers();
		try {
			for (const [label, zone] of Object.entries(CORE_DATE_PARITY_ZONES) as [
				CoreDateParityZone,
				string,
			][]) {
				// Node re-reads the zone on assignment. Every value is built after
				// the switch, because a Date's calendar day is read when it is made.
				process.env.TZ = zone;
				vi.setSystemTime(new Date(CORE_DATE_PARITY.fixedClock));
				for (const row of CORE_DATE_PARITY.rows) {
					const name = `${label}: ${row.id}: ${row.xpath}`;
					expectCoreResult(
						evaluate(row.xpath, contextFor(row, zone)),
						row.expect[label],
						name,
					);
					expectCoreResult(
						await evaluateAsync(row.xpath, contextFor(row, zone)),
						row.expect[label],
						`${name} (async)`,
					);
				}
			}
		} finally {
			vi.useRealTimers();
			if (originalTimeZone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimeZone;
		}
	});
});
