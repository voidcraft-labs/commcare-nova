/**
 * Completion of secondary-instance reads, driven through CodeMirror's
 * `CompletionContext` over the real editor context of each slot.
 *
 * Contract: inside `instance('…')` the editor offers exactly the ids the
 * slot reads (a data table only by its tag, places only when the app has
 * levels, the chosen cases only in a several-case form's questions, the
 * search's results only where the entry carries the inline query, a
 * no-matches form's search answers only there), and each step and predicate
 * below offers the names the parser binds. Every completion offered and
 * then completed to a read is accepted by the editor's own parser and
 * checker, so nothing is offered and then refused.
 */

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	INSTANCE_READS,
	instanceReadFixture,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import {
	NAME_FIELD,
	noMatchesDoc,
} from "@/lib/commcare/__tests__/noMatchesWireFixture";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Uuid } from "@/lib/domain";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { parseLookupRevision } from "@/lib/lookup/schema";
import {
	buildExpressionEditorContext,
	type ExpressionEditorContext,
} from "../expressionEditorContext";
import { instanceSource } from "../xpath-autocomplete";
import { xpath } from "../xpath-language";
import { xpathDiagnostics } from "../xpath-lint";

const { doc, table } = instanceReadFixture();
const VISIT_PROPERTY = testUuid("instance-completion-catchment");
doc.locationProperties = {
	[VISIT_PROPERTY]: {
		uuid: VISIT_PROPERTY,
		slug: "catchment",
		label: "Catchment",
	},
};
doc.locationPropertyOrder = [VISIT_PROPERTY];

const lookupContext: LookupValidationContext = {
	kind: "available",
	projectId: "project",
	projectRevision: parseLookupRevision("1"),
	definitions: [table],
};

function fieldSlot(formUuid: Uuid, id: string): ExpressionSlotRef {
	const field = Object.values(doc.fields).find(
		(each) => each.id === id && doc.fieldParent[each.uuid] === formUuid,
	);
	if (field === undefined) throw new Error(`No field ${id}`);
	return { entity: "field", uuid: field.uuid, slot: "calculate" };
}

const VISIT = fieldSlot(INSTANCE_READS.visitForm, "region_label");
const BATCH = fieldSlot(INSTANCE_READS.batchForm, "chosen");
const CHECK_IN = fieldSlot(INSTANCE_READS.searchForm, "found");
const RESULTS_LINK: ExpressionSlotRef = {
	entity: "form",
	uuid: INSTANCE_READS.searchForm,
	slot: "form_link_condition",
	member: { linkUuid: INSTANCE_READS.resultsLink },
};

function context(slot: ExpressionSlotRef): ExpressionEditorContext {
	const built = buildExpressionEditorContext(doc, slot, lookupContext);
	if (built === undefined) throw new Error("The slot has no editor context");
	return built;
}

/** The completion at the end of `text`, or at the `|` it holds. */
function complete(slot: ExpressionSlotRef, written: string) {
	const cursor = written.indexOf("|");
	const text = cursor < 0 ? written : written.replace("|", "");
	const pos = cursor < 0 ? text.length : cursor;
	const state = EditorState.create({ doc: text, extensions: [xpath()] });
	const result = instanceSource(() => context(slot).reads)(
		new CompletionContext(state, pos, false),
	);
	return {
		text,
		pos,
		result,
		labels: result?.options.map((option) => option.label) ?? [],
	};
}

/** The text after completing with `label`, as CodeMirror applies it. */
function applied(written: string, slot: ExpressionSlotRef, label: string) {
	const { text, pos, result } = complete(slot, written);
	if (result === null) throw new Error(`Nothing completes ${written}`);
	return text.slice(0, result.from) + label + text.slice(result.to ?? pos);
}

function accepted(slot: ExpressionSlotRef, source: string) {
	expect(xpathDiagnostics(source, context(slot)), source).toEqual([]);
}

describe("instance ids", () => {
	it("offers the ids a question of an ordinary form reads", () => {
		expect(complete(VISIT, "instance('").labels).toEqual([
			"casedb",
			"commcaresession",
			"regions",
			"locations",
		]);
		expect(complete(VISIT, "instance('|')").labels).toEqual([
			"casedb",
			"commcaresession",
			"regions",
			"locations",
		]);
	});

	it("names a table by its tag with the table's name beside it", () => {
		const regions = complete(VISIT, "instance('re").result?.options.find(
			(option) => option.label === "regions",
		);
		expect(regions?.detail).toBe(table.name);
		expect(complete(VISIT, "instance('re").result?.from).toBe(
			"instance('".length,
		);
	});

	it("offers the chosen cases only in a several-case form's questions", () => {
		const batch = complete(BATCH, "instance('").labels;
		const chosen = batch.filter(
			(label) =>
				!["casedb", "commcaresession", "regions", "locations"].includes(label),
		);
		expect(chosen).toHaveLength(1);
		expect(complete(VISIT, "instance('").labels).not.toContain(chosen[0]);
		accepted(BATCH, `count(instance('${chosen[0]}')/results/value)`);
	});

	it("offers what the search found only where the entry carries the search", () => {
		expect(complete(CHECK_IN, "instance('").labels).toContain("results:inline");
		expect(complete(RESULTS_LINK, "instance('").labels).toContain(
			"results:inline",
		);
		expect(complete(VISIT, "instance('").labels).not.toContain(
			"results:inline",
		);
	});

	it("offers places only when the app has organization levels", () => {
		const levels = doc.organizationLevels;
		doc.organizationLevels = {};
		try {
			expect(complete(VISIT, "instance('").labels).not.toContain("locations");
		} finally {
			doc.organizationLevels = levels;
		}
	});

	it("offers a no-matches form its search answers, and no search results", () => {
		const noMatches = noMatchesDoc();
		const slot: ExpressionSlotRef = {
			entity: "field",
			uuid: NAME_FIELD,
			slot: "default_value",
		};
		const lint = buildExpressionEditorContext(
			noMatches,
			slot,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const at = (written: string) => {
			const state = EditorState.create({ doc: written, extensions: [xpath()] });
			return (
				instanceSource(() => lint?.reads)(
					new CompletionContext(state, written.length, false),
				)?.options.map((option) => option.label) ?? []
			);
		};
		expect(at("instance('")).toEqual([
			"casedb",
			"commcaresession",
			"search-input:results:inline",
		]);
		expect(at("instance('search-input:results:inline')/")).toEqual(["input/"]);
		expect(at("instance('search-input:results:inline')/input/")).toEqual([
			"field[@name = 'patient_name']",
		]);
		const diagnostics = (written: string) =>
			lint === undefined
				? ["no context"]
				: xpathDiagnostics(written, lint).map(
						(diagnostic) => diagnostic.message,
					);
		expect(
			diagnostics(
				"instance('search-input:results:inline')/input/field[@name = 'patient_name']",
			),
		).toEqual([]);
		expect(
			diagnostics(
				"instance('search-input:results:inline')/results/inputs/patient_name",
			),
		).not.toEqual([]);
	});

	it("never offers groups or the remote search's results", () => {
		for (const slot of [VISIT, BATCH, CHECK_IN, RESULTS_LINK])
			for (const held of ["groups", "results"])
				expect(complete(slot, "instance('").labels).not.toContain(held);
	});

	it("offers no id inside another function's quotes", () => {
		expect(complete(VISIT, "concat('").result).toBeNull();
		expect(complete(VISIT, "concat('|')").result).toBeNull();
	});
});

describe("the paths under each instance", () => {
	it("walks a table to its columns, in a step and in the row's predicate", () => {
		expect(complete(VISIT, "instance('regions')/").labels).toEqual([
			"regions_list/",
		]);
		expect(complete(VISIT, "instance('regions')/regions_list/").labels).toEqual(
			["regions"],
		);
		expect(
			complete(VISIT, "instance('item-list:regions')/regions_list/regions/")
				.labels,
		).toEqual(["value", "label"]);
		expect(
			complete(VISIT, "instance('regions')/regions_list/regions[").labels,
		).toEqual(["value", "label"]);
		expect(
			complete(VISIT, "instance('regions')/regions_list/regions[va").result
				?.from,
		).toBe("instance('regions')/regions_list/regions[".length);
	});

	it("walks places to their values, and offers level codes opposite @type", () => {
		expect(
			complete(VISIT, "instance('locations')/locations/location/").labels,
		).toEqual([
			"@type",
			"@id",
			"@region_id",
			"@district_id",
			"@clinic_id",
			"name",
			"site_code",
			"external_id",
			"latitude",
			"longitude",
			"location_data/",
		]);
		expect(
			complete(VISIT, "instance('locations')/locations/location/location_data/")
				.labels,
		).toEqual(["catchment"]);
		expect(
			complete(VISIT, "instance('locations')/locations/location[").labels,
		).toContain("location_data/catchment");
		for (const written of [
			"instance('locations')/locations/location[@type = '",
			"instance('locations')/locations/location[@type = '|']",
		])
			expect(complete(VISIT, written).labels).toEqual([
				"region",
				"district",
				"clinic",
			]);
	});

	it("walks a search's results behind the related-case exclusion", () => {
		expect(
			complete(CHECK_IN, "instance('results:inline')/results/").labels,
		).toEqual(["case[not(commcare_is_related_case = true())]"]);
		const row =
			"instance('results:inline')/results/case[not(commcare_is_related_case = true())]";
		const values = complete(CHECK_IN, `${row}/`).labels;
		expect(values).toEqual(
			expect.arrayContaining([
				"@case_id",
				"@case_type",
				"@owner_id",
				"@status",
				"district",
			]),
		);
		expect(values).not.toContain("case_id");
		expect(complete(CHECK_IN, `${row}[`).labels).toEqual(values);
	});

	it("lists the session values the entry supplies, each by what it holds", () => {
		const data = complete(VISIT, "instance('commcaresession')/session/data/")
			.result?.options;
		expect(data?.map((option) => option.detail)).toEqual([
			"The case chosen in Patients",
		]);
		accepted(
			VISIT,
			`instance('commcaresession')/session/data/${data?.[0]?.label}`,
		);
	});
});

describe("every completion completes to a read the editor accepts", () => {
	const count = (read: string) => `count(${read})`;
	const reads: ReadonlyArray<
		readonly [string, ExpressionSlotRef, string, (read: string) => string]
	> = [
		[
			"a table's column",
			VISIT,
			"instance('regions')/regions_list/regions/",
			count,
		],
		[
			"a table's predicate",
			VISIT,
			"instance('regions')/regions_list/regions[",
			(read) => count(`${read} = 'north']/label`),
		],
		[
			"a place's value",
			VISIT,
			"instance('locations')/locations/location/",
			count,
		],
		[
			"a place's property",
			VISIT,
			"instance('locations')/locations/location/location_data/",
			count,
		],
		[
			"a place's level",
			VISIT,
			"instance('locations')/locations/location[@type = '",
			(read) => count(`${read}']/name`),
		],
		[
			"a search result's value",
			CHECK_IN,
			"instance('results:inline')/results/case[not(commcare_is_related_case = true())]/",
			count,
		],
		[
			"a place's predicate",
			VISIT,
			"instance('locations')/locations/location[",
			(read) => count(`${read} = 'x']/name`),
		],
		[
			"a search result's predicate",
			CHECK_IN,
			"instance('results:inline')/results/case[not(commcare_is_related_case = true())][",
			(read) => count(`${read} = 'patient']`),
		],
		[
			"a session value",
			VISIT,
			"instance('commcaresession')/session/data/",
			(read) => read,
		],
	];
	it.each(reads)("%s", (_, slot, written, finish) => {
		const offered = complete(slot, written).labels;
		expect(offered.length).toBeGreaterThan(0);
		for (const label of offered)
			if (!label.endsWith("/") && !label.endsWith("'"))
				accepted(slot, finish(applied(written, slot, label)));
	});
});
