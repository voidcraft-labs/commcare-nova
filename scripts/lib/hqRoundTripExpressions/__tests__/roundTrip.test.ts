/**
 * Step 7 and §10's postcondition are one law over one document (part 09 §5,
 * §10): every expression slot of a target survives its own print, read with
 * the scope its key path from the owner gives it, whichever step wrote it.
 *
 * The plausible failures are a guard that checks only the slots a step
 * rewrote, so a carried value the writer's postcondition refuses passes the
 * scan, and a record scope found by object identity, which a rebuilt target
 * never shares, so a choice filter loses its row's case type or table.
 */

import { describe, expect, it } from "vitest";
import { caseChoiceDoc, choiceUuid } from "@/lib/__tests__/caseChoiceFixture";
import {
	LOOKUP_SELECT_DOC,
	lookupSelectDoc,
} from "@/lib/agent/__tests__/fixtures";
import { authoringValueScope } from "@/lib/agent/authoring/bindings";
import { parseQueryPredicate } from "@/lib/agent/authoring/queryExpressions";
import { wireTable } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import {
	expressionSurvives,
	liftRoundTripStep,
	roundTripFailuresOf,
} from "../steps/liftRoundTrip";
import type { WorkingDocument } from "../steps/working";
import type { StepContext } from "../types";

const NO_TABLES: LookupDefinitionIndex = new Map();

function optionsFilter(doc: BlueprintDoc, field: string) {
	const value = expressionSlotValues(doc, {
		entity: "field",
		uuid: field as never,
	}).find((entry) => entry.ref.slot === "lookup_options_source");
	if (value === undefined) throw new Error(`${field} has no choice filter`);
	return value;
}

/** Step 7 over a working document that holds exactly `doc` as its target. */
function guard(doc: BlueprintDoc, lookup: LookupDefinitionIndex) {
	const working = {
		target: () => ({ ok: true, doc }),
	} as unknown as WorkingDocument;
	return liftRoundTripStep().apply(working, {
		appId: "app-round-trip",
		projectId: "project-round-trip",
		lookup,
		storedCaseKeys: new Map(),
	} as StepContext);
}

describe("the round-trip law over a target", () => {
	it("reads a filter inside a case-sourced select with its row's case type", () => {
		const doc = caseChoiceDoc();
		const filter = optionsFilter(doc, choiceUuid("members"));
		expect(filter.path).toEqual(["optionsSource", "filter"]);
		expect(expressionSurvives(doc, filter, NO_TABLES).ok).toBe(true);
		// Read from the owner's root instead, the filter has no row to read.
		expect(expressionSurvives(doc, { ...filter, path: [] }, NO_TABLES).ok).toBe(
			false,
		);
		expect(roundTripFailuresOf(doc, NO_TABLES)).toEqual([]);
		expect(guard(doc, NO_TABLES).blockers).toEqual([]);
	});

	it("reads a filter inside a lookup-sourced select with its table", () => {
		const table = wireTable("regions", [
			{ name: "code", type: "text" },
			{ name: "label", type: "text" },
		]);
		const [code, label] = table.columns;
		if (code === undefined || label === undefined)
			throw new Error("the table has no columns");
		const lookup: LookupDefinitionIndex = new Map([[table.id, table]]);
		const source = {
			kind: "lookup" as const,
			tableId: table.id,
			valueColumnId: code.id,
			labelColumnId: label.id,
		};
		const bare = lookupSelectDoc(source);
		const expression = parseQueryPredicate(
			"#row/code = 'east'",
			authoringValueScope(
				{
					doc: bare,
					formUuid: LOOKUP_SELECT_DOC.formUuid,
					moduleUuid: LOOKUP_SELECT_DOC.moduleUuid,
					tables: [table],
				},
				{ optionsSource: source },
				["optionsSource", "filter"],
			),
		);
		const doc = lookupSelectDoc({ ...source, filter: expression });
		const filter = optionsFilter(doc, LOOKUP_SELECT_DOC.selectUuid);
		expect(filter.expression).toEqual(expression);
		// Read in its table, the filter's column is the row's, as the SA
		// reads it; from the owner's root it is a qualified table column.
		expect(expressionSurvives(doc, filter, lookup)).toEqual({
			ok: true,
			text: "(#row/code = 'east')",
		});
		expect(expressionSurvives(doc, { ...filter, path: [] }, lookup).text).toBe(
			"(table-column('regions', 'code') = 'east')",
		);
		expect(roundTripFailuresOf(doc, lookup)).toEqual([]);
		expect(guard(doc, lookup).blockers).toEqual([]);
	});

	it("holds a slot no step wrote to its print, as the writer's postcondition does", () => {
		const doc = caseChoiceDoc();
		/* The same filter on a select whose source names no case type: no
		 * scope reads its row, so it cannot survive, and no step of this
		 * working document lifted it. */
		const field = doc.fields[choiceUuid("members")] as unknown as {
			optionsSource: { caseType: string };
		};
		field.optionsSource.caseType = "unknown-type";
		const failures = roundTripFailuresOf(doc, NO_TABLES);
		expect(failures.map((failure) => failure.ref.slot)).toEqual([
			"lookup_options_source",
		]);
		expect(guard(doc, NO_TABLES).blockers).toEqual([
			{ code: "round-trip", count: failures.length, findingCodes: [] },
		]);
	});
});
