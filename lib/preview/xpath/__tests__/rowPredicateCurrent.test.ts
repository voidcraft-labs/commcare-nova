/**
 * Preview over the text Nova prints for a form read inside a row predicate
 * (`lib/commcare/xpath/wire/formReads.ts`): a read that crosses the repeat
 * its slot is in prints `current()/…`, and Preview evaluates that text, so
 * each entry of a two-entry repeat counts the cases whose kind is its own.
 *
 * Plausible failure: `current()` read as the predicate's candidate row, or
 * as the first entry, so both entries count the same cases.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type Field, fieldSchema, type Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { CaseRow } from "../../engine/caseDataBindingTypes";
import { DataInstance } from "../../engine/dataInstance";
import { buildFieldTree } from "../../engine/fieldTree";
import {
	caseDatabaseXPathInstance,
	xpathNodeAtPath,
} from "../../engine/xpathInstances";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

function visit(caseId: string, kind: string): CaseRow {
	return {
		case_id: caseId,
		app_id: "app-1",
		case_type: "visit",
		owner_id: "worker-1",
		status: "open",
		opened_on: new Date("2026-08-01T00:00:00.000Z"),
		modified_on: new Date("2026-08-02T00:00:00.000Z"),
		closed_on: null,
		case_name: caseId,
		external_id: null,
		parent_case_id: null,
		properties: { kind },
	};
}

/** A repeat `visits` of two entries, answered `home` and `clinic`. */
function visits(): DataInstance {
	const repeatUuid = testUuid("row-current.visits");
	const kindUuid = testUuid("row-current.kind");
	const countUuid = testUuid("row-current.count");
	const fields: Record<string, Field> = {
		[repeatUuid]: {
			uuid: repeatUuid,
			id: "visits",
			kind: "repeat",
			label: proseText("Visits"),
			repeat_mode: "user_controlled",
		},
		[kindUuid]: {
			uuid: kindUuid,
			id: "kind",
			kind: "text",
			label: proseText("Kind"),
		},
		[countUuid]: {
			uuid: countUuid,
			id: "same",
			kind: "hidden",
			calculate: { kind: "term", term: { kind: "literal", value: 0 } },
		},
	};
	const root = testUuid("row-current.form");
	const order: Record<string, Uuid[]> = {
		[root]: [repeatUuid],
		[repeatUuid]: [kindUuid, countUuid],
	};
	for (const field of Object.values(fields)) fieldSchema.parse(field);
	const data = new DataInstance();
	data.initFromFields(buildFieldTree(root, fields, order));
	data.addRepeatInstance("/data/visits");
	data.set("/data/visits[0]/kind", "home");
	data.set("/data/visits[1]/kind", "clinic");
	return data;
}

function at(data: DataInstance, contextPath: string): EvalContext {
	const mainInstance = data.asXPathInstance();
	const contextNode = xpathNodeAtPath(mainInstance, contextPath);
	if (contextNode === undefined)
		throw new Error("Fixture context node is missing.");
	const casedb = caseDatabaseXPathInstance({
		rows: [visit("v1", "home"), visit("v2", "home"), visit("v3", "clinic")],
		indices: [],
	});
	return {
		mainInstance,
		contextNode,
		originalContextNode: contextNode,
		contextPath,
		position: undefined,
		getValue: (path) => data.get(path),
		resolveXPathInstance: (id) => (id === "casedb" ? casedb : undefined),
	};
}

describe("a form read inside a row predicate, as Nova prints it", () => {
	const printed =
		"count(instance('casedb')/casedb/case[@case_type = 'visit'][kind = current()/../kind])";

	it("gives each entry of the repeat its own count", () => {
		const data = visits();
		expect(evaluate(printed, at(data, "/data/visits[0]/same"))).toBe(2);
		expect(evaluate(printed, at(data, "/data/visits[1]/same"))).toBe(1);
	});

	it("reads the entry's own answer in the repeat's own relevant", () => {
		const data = visits();
		const relevant =
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][kind = current()/kind])";
		expect(evaluate(relevant, at(data, "/data/visits[0]"))).toBe(2);
		expect(evaluate(relevant, at(data, "/data/visits[1]"))).toBe(1);
	});
});
