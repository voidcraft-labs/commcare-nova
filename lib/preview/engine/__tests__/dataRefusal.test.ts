// Core refuses a value read below an instance that holds nothing, and a
// choice list over a table with no rows. Preview names which data was empty
// from the evaluator's own structured error, never from its message, and
// says what a phone does and what to change.

import { describe, expect, it } from "vitest";
import {
	LOCATION_FORM,
	LOCATION_LEVELS,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { wireTable } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import type { LocationFixtureRow } from "@/lib/organization/footprint";
import { dataRefusalCopy } from "../../runtimeMessages";
import { evaluate } from "../../xpath/evaluator";
import { PreviewXPathRuntimeError } from "../../xpath/runtimeError";
import {
	type XPathInstance,
	XPathInvalidPathError,
	type XPathNode,
} from "../../xpath/runtimeValues";
import {
	PreviewDataRefusal,
	previewDataRefusalOf,
	previewDataRefusalReadsTable,
	previewDataRefusalSubject,
	workerFailureError,
} from "../dataRefusal";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { previewLookupData } from "../lookupEvaluation";
import {
	locationsXPathInstance,
	lookupXPathInstances,
} from "../xpathInstances";

const table = wireTable("districts", [
	{ name: "code", type: "text" },
	{ name: "name", type: "text" },
]);
const empty = previewLookupData({
	projectRevision: "1",
	definitions: [table],
	rowsByTable: new Map([[table.id, []]]),
});
const naming = empty.naming.tables[0];
if (naming === undefined) throw new Error("The table has no wire naming.");

function refusalOf(
	expression: string,
	instances: ReadonlyMap<string, XPathInstance>,
): unknown {
	try {
		evaluate(expression, {
			contextPath: "/data",
			position: undefined,
			getValue: () => undefined,
			resolveXPathInstance: (id: string) => instances.get(id),
		});
	} catch (error) {
		return error;
	}
	throw new Error(`“${expression}” evaluated without a refusal.`);
}

describe("a read below an instance that holds nothing", () => {
	it("names the empty table it missed, under its form id and its suite id", () => {
		const instances = lookupXPathInstances(empty, {
			includeFixtureAliases: true,
		});
		for (const id of [naming.xformInstanceId, naming.fixtureId]) {
			const read = `instance('${id}')/${naming.listElementName}/${naming.rowElementName}[code = 'n']/name`;
			const error = refusalOf(read, instances);
			expect(error).toBeInstanceOf(XPathInvalidPathError);
			const refusal = previewDataRefusalOf(error);
			expect(refusal?.reason).toEqual({
				kind: "empty-instance",
				instanceId: id,
			});
			expect(refusal?.stage).toBe("form");
			expect(
				refusal && previewDataRefusalSubject(refusal.reason, empty),
			).toEqual({ kind: "table", tableName: table.name });
		}
		const join = `join(' ', instance('${naming.xformInstanceId}')/${naming.listElementName}/${naming.rowElementName}/name)`;
		expect(previewDataRefusalOf(refusalOf(join, instances))?.reason).toEqual({
			kind: "empty-instance",
			instanceId: naming.xformInstanceId,
		});
	});

	it("names the places when the worker is assigned nowhere", () => {
		const instances = new Map([
			[
				"locations",
				locationsXPathInstance([], {
					organizationLevels: {},
					organizationLevelOrder: [],
					locationProperties: {},
					locationPropertyOrder: [],
				}),
			],
		]);
		const refusal = previewDataRefusalOf(
			refusalOf(
				"instance('locations')/locations/location[@id = 'x']/name",
				instances,
			),
		);
		expect(refusal?.reason).toEqual({
			kind: "empty-instance",
			instanceId: "locations",
		});
		expect(refusal && previewDataRefusalSubject(refusal.reason, null)).toEqual({
			kind: "places",
		});
	});

	it("keeps a broken path in the form's own instance a fault", () => {
		// The form's own instance has no id; a path that misses there is a
		// broken reference, not empty data.
		const data: XPathNode = {
			instanceId: null,
			path: "/data",
			name: "data",
			kind: "element",
			multiplicity: 0,
			value: () => "",
			parent: () => undefined,
			children: () => [],
			attributes: () => [],
			hasChildTemplate: () => false,
			hasAttributeTemplate: () => false,
			isRelevant: () => true,
		};
		let caught: unknown;
		try {
			evaluate("nowhere", {
				contextPath: "/data",
				position: undefined,
				getValue: () => undefined,
				contextNode: data,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(XPathInvalidPathError);
		expect((caught as XPathInvalidPathError).missedIn).toBeNull();
		expect(previewDataRefusalOf(caught)).toBeUndefined();
		expect(previewDataRefusalOf(new Error("anything else"))).toBeUndefined();
	});

	it("raises the worker's refusal as the same error on the host, and a fault as a diagnostic", () => {
		const error = {
			code: "evaluation-failed",
			reason: { phase: "evaluation", kind: "invalid-path" },
			operation: "evaluate",
			entryKey: "e",
			revision: 1,
			profile: "form",
		} as const;
		const refused = workerFailureError({
			ok: false,
			error,
			refusal: { instanceId: "locations" },
		});
		expect(previewDataRefusalOf(refused)?.reason).toEqual({
			kind: "empty-instance",
			instanceId: "locations",
		});
		const fault = workerFailureError({ ok: false, error });
		expect(fault).toBeInstanceOf(PreviewXPathRuntimeError);
		expect(previewDataRefusalOf(fault)).toBeUndefined();
	});
});

describe("what each refusal says", () => {
	it("says what a phone does and what to change, for each kind of empty data", () => {
		expect(
			dataRefusalCopy("eng", "form", { kind: "places" }, { worker: "Asha" }),
		).toEqual({
			title: "This form stops here on a phone",
			body: "This form reads a place, and Asha is assigned nowhere, so a phone stops here. You can give Asha a place under Users and personas in App setup.",
		});
		expect(dataRefusalCopy("eng", "form", { kind: "places" }).body).toBe(
			"This form reads a place, and you're assigned nowhere, so a phone stops here. You can preview as a persona who has a place.",
		);
		expect(
			dataRefusalCopy("eng", "links", {
				kind: "table",
				tableName: "Districts",
			}),
		).toEqual({
			title: "This form's next step stops on a phone",
			body: "This form's links read “Districts”, which has no rows, so a phone stops here. You can add rows to “Districts” in Project data.",
		});
		expect(
			dataRefusalCopy("eng", "menu", { kind: "table", tableName: "Districts" }),
		).toEqual({
			title: "This menu doesn't open on a phone",
			body: "This menu reads “Districts”, which has no rows, so a phone stops here. You can add rows to “Districts” in Project data.",
		});
		expect(
			dataRefusalCopy(
				"eng",
				"form",
				{ kind: "choices", tableName: "Districts" },
				{ question: "District" },
			).body,
		).toBe(
			"“District” gets its choices from “Districts”, which has no rows, so a phone won't open it. You can add rows to “Districts” in Project data.",
		);
		expect(
			dataRefusalCopy(
				"eng",
				"search",
				{ kind: "choices", tableName: "Districts" },
				{ input: "District" },
			),
		).toEqual({
			title: "This search doesn't open on a phone",
			body: "Search field “District” gets its choices from “Districts”, which has no rows, so a phone won't open this search. You can add rows to “Districts” in Project data.",
		});
		expect(
			dataRefusalCopy("spa", "form", { kind: "table", tableName: "Distritos" })
				.body,
		).toBe(
			"Este formulario lee «Distritos», que no tiene filas, así que un teléfono se detiene aquí. Puede añadir filas a «Distritos» en los datos del proyecto.",
		);
	});
});

describe("a choice list over a table with no rows", () => {
	it("is a refusal naming the table, and the table's name resolves for the copy", () => {
		const refusal = new PreviewDataRefusal({
			kind: "empty-choice-table",
			tableId: table.id,
		});
		expect(previewDataRefusalOf(refusal)).toBe(refusal);
		expect(previewDataRefusalSubject(refusal.reason, empty)).toEqual({
			kind: "choices",
			tableName: table.name,
		});
	});
});

// A new lookup snapshot opens a refused form again only when a table held
// what the form found empty; places, chosen cases and search answers come
// with the device's cases, the session and the search instead.
describe("which refusals a lookup snapshot can change", () => {
	it("is a table's rows or a table's choices, under either of its ids", () => {
		for (const instanceId of [naming.xformInstanceId, naming.fixtureId])
			expect(
				previewDataRefusalReadsTable(
					{ kind: "empty-instance", instanceId },
					empty,
				),
			).toBe(true);
		expect(
			previewDataRefusalReadsTable(
				{ kind: "empty-choice-table", tableId: table.id },
				null,
			),
		).toBe(true);
	});

	it("is never the places, the chosen cases or the search answers", () => {
		for (const instanceId of [
			"locations",
			"selected_cases",
			"search-input:results",
		])
			expect(
				previewDataRefusalReadsTable(
					{ kind: "empty-instance", instanceId },
					empty,
				),
			).toBe(false);
	});
});

// The owner's move to a place prints bare, so a phone refuses the form when
// it opens for a worker assigned nowhere (`LocationOwnerRuntimeTest`):
// Preview refuses there too, saying why the case can't move.
describe("a case owner moved to a place, for a worker assigned nowhere", () => {
	const open = (
		doc: ReturnType<typeof locationOwnerFixture>,
		locations?: readonly LocationFixtureRow[],
	) => {
		const input = buildEngineInput(doc, LOCATION_FORM, null);
		if (input === undefined) throw new Error("The fixture form is missing.");
		return () =>
			new FormEngine(input, "patient", undefined, null, null, {
				rows: [],
				indices: [],
				...(locations === undefined ? {} : { locations }),
			});
	};
	const clinic: LocationFixtureRow = {
		id: "place-3",
		levelUuid: LOCATION_LEVELS[2].uuid,
		siteCode: "place-3",
		name: "Clinic",
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		lineage: {},
	};

	it("refuses the form when it opens, as a refusal about the owner's place", () => {
		let caught: unknown;
		try {
			open(locationOwnerFixture("direct"), [])();
		} catch (error) {
			caught = error;
		}
		const refusal = previewDataRefusalOf(caught);
		expect(refusal?.reason).toEqual({ kind: "owner-without-place" });
		expect(refusal?.stage).toBe("form");
		expect(refusal && previewDataRefusalSubject(refusal.reason, null)).toEqual({
			kind: "owner-place",
		});
		expect(refusal && previewDataRefusalReadsTable(refusal.reason, null)).toBe(
			false,
		);
	});

	it("opens once the worker has a place, without places read, and for an ordinary owner", () => {
		expect(open(locationOwnerFixture("direct"), [clinic])).not.toThrow();
		expect(open(locationOwnerFixture("direct"))).not.toThrow();
		expect(open(locationOwnerFixture("plain"), [])).not.toThrow();
	});

	it("says the case has no owner to move to, naming the persona", () => {
		expect(
			dataRefusalCopy(
				"eng",
				"form",
				{ kind: "owner-place" },
				{ worker: "Asha" },
			),
		).toEqual({
			title: "This form stops here on a phone",
			body: "This form moves the case to Asha's place, and Asha is assigned nowhere, so the case has no owner to move to and a phone stops here. You can give Asha a place under Users and personas in App setup.",
		});
		expect(dataRefusalCopy("eng", "form", { kind: "owner-place" }).body).toBe(
			"This form moves the case to your place, and you're assigned nowhere, so the case has no owner to move to and a phone stops here. You can preview as a persona who has a place.",
		);
	});
});
