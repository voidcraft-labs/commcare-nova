/**
 * A mutating tool must still commit when the document holds a lookup carrier.
 *
 * The commit gate is absolute rather than a delta: a lookup occurrence it
 * cannot check is a `soundness` finding, and a soundness finding rejects. So a
 * tool layer that hands the gate an unavailable definition snapshot refuses
 * every mutating call on an app that touches Project data — not just the calls
 * that touch lookups. That is a whole-app brick with a retryable-sounding
 * message, and it is invisible to any test that only parses input schemas or
 * only executes read tools, which is what the suite had.
 *
 * These execute the real tool bodies through a context whose
 * `lookupDefinitions` answers: against a doc that already carries a
 * lookup-backed select, and against a doc whose FIRST lookup reference the
 * call itself introduces. The second half is the case the gate must resolve
 * from the candidate, not the snapshot — a snapshot with no lookup carrier
 * yields no definitions to ask for, and a select can never be bound to a
 * Project data table at all.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import {
	echoLookupDefinitions,
	LOOKUP_SELECT_DOC,
	lookupSelectDoc,
	lookupTableDefinition,
	makeToolWorkspaceHarness,
} from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";
import { setFieldOptionsSourceTool } from "../setFieldOptionsSource";
import { updateModuleTool } from "../updateModule";

const {
	moduleUuid: MODULE,
	formUuid: FORM,
	selectUuid: SELECT,
} = LOOKUP_SELECT_DOC;

const TABLE = lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000a001");
const VALUE = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const LABEL = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c002",
);
/* A second table, lexically after TABLE: the gate's target set is sorted, so
 * a union of both reads exactly `[TABLE, TABLE_B]`. */
const TABLE_B = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-00000000a002",
);
const VALUE_B = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c011",
);
const LABEL_B = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c012",
);

const CATALOG = [
	lookupTableDefinition({
		id: TABLE,
		name: "Referral destinations",
		tag: "referral_destinations",
		columns: [
			{ id: VALUE, wireName: "code", label: "Code" },
			{ id: LABEL, wireName: "name", label: "Name" },
		],
	}),
	lookupTableDefinition({
		id: TABLE_B,
		name: "Facilities",
		tag: "facilities",
		columns: [
			{ id: VALUE_B, wireName: "code", label: "Code" },
			{ id: LABEL_B, wireName: "name", label: "Name" },
		],
	}),
];

const LOOKUP_SOURCE = {
	kind: "lookup" as const,
	tableId: TABLE,
	valueColumnId: VALUE,
	labelColumnId: LABEL,
};

const SECOND_LOOKUP_SOURCE = {
	kind: "lookup" as const,
	tableId: TABLE_B,
	valueColumnId: VALUE_B,
	labelColumnId: LABEL_B,
};

/** A doc whose select draws its choices from a Project data table. */
function docWithLookupCarrier(): BlueprintDoc {
	return lookupSelectDoc(LOOKUP_SOURCE);
}

/** The same form with inline choices: a doc with no lookup reference
 *  anywhere — the fresh-app shape a first table binding starts from. */
function docWithInlineSelect(): BlueprintDoc {
	return lookupSelectDoc({
		kind: "inline",
		options: [
			{
				uuid: asUuid("44444444-4444-4444-8444-444444444444"),
				value: "clinic",
				label: proseText("Clinic"),
			},
			{
				uuid: asUuid("55555555-5555-4555-8555-555555555555"),
				value: "hospital",
				label: proseText("Hospital"),
			},
		],
	});
}

function makeHarness(
	doc: BlueprintDoc,
	options: { readonly answering: boolean },
) {
	const lookupDefinitions = echoLookupDefinitions(CATALOG);
	const h = makeToolWorkspaceHarness(doc, {
		appId: "app-1",
		...(options.answering ? { lookupDefinitions } : {}),
	});
	return { h, lookupDefinitions };
}

describe("mutating a document that carries a lookup source", () => {
	it("commits an edit that has nothing to do with the lookup", async () => {
		const doc = docWithLookupCarrier();
		const { h, lookupDefinitions } = makeHarness(doc, { answering: true });

		const out = await h.runTool(updateModuleTool, {
			moduleUuid: MODULE,
			name: "Referral queue",
		});

		expect(out.result).not.toHaveProperty("error");
		expect(h.currentDoc().modules[MODULE]?.name).toBe("Referral queue");
		// The gate was given a real snapshot, resolved from the carrier the doc
		// already holds — not from anything this call touched.
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE]);
	});

	it("refuses, rather than committing blind, when definitions cannot be read", async () => {
		const doc = docWithLookupCarrier();
		const { h } = makeHarness(doc, { answering: false });

		const out = await h.runTool(updateModuleTool, {
			moduleUuid: MODULE,
			name: "Referral queue",
		});

		/* Fail closed: an unreadable snapshot is a soundness finding, so the
		 * whole batch is refused. The point of the test above is that this is
		 * reached only when the definitions genuinely cannot be read. */
		expect(out.result).toHaveProperty("error");
	});
});

describe("introducing a lookup reference", () => {
	it("binds a select's first table through set_field_options_source", async () => {
		const { h, lookupDefinitions } = makeHarness(docWithInlineSelect(), {
			answering: true,
		});

		const out = await h.runTool(setFieldOptionsSourceTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
			fieldUuid: SELECT,
			source: LOOKUP_SOURCE,
		});

		expect(out.result).not.toHaveProperty("error");
		expect(h.currentDoc().fields[SELECT]).toMatchObject({
			optionsSource: LOOKUP_SOURCE,
		});
		// The snapshot holds no lookup carrier; the table to resolve comes from
		// the candidate alone. A gate that reads only the snapshot asks for
		// nothing and refuses the reference as uncheckable.
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("binds a new select's first table through add_fields", async () => {
		const { h, lookupDefinitions } = makeHarness(docWithInlineSelect(), {
			answering: true,
		});

		const out = await h.runTool(addFieldsTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
			fields: [
				{
					kind: "single_select",
					id: "facility",
					parentUuid: null,
					label: proseText("Facility"),
					optionsSource: LOOKUP_SOURCE,
				},
			],
		});

		expect(out.result).not.toHaveProperty("error");
		const added = Object.values(h.currentDoc().fields).find(
			(field) => field.id === "facility",
		);
		expect(added).toMatchObject({ optionsSource: LOOKUP_SOURCE });
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("binds a second table on a doc already bound to another", async () => {
		const { h, lookupDefinitions } = makeHarness(docWithLookupCarrier(), {
			answering: true,
		});

		const out = await h.runTool(addFieldsTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
			fields: [
				{
					kind: "single_select",
					id: "facility",
					label: proseText("Facility"),
					optionsSource: SECOND_LOOKUP_SOURCE,
				},
			],
		});

		expect(out.result).not.toHaveProperty("error");
		// The union of the snapshot's table and the candidate's — a gate that
		// resolves only the snapshot's would report the second table missing.
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE, TABLE_B]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("still refuses a first binding when definitions cannot be read", async () => {
		const { h } = makeHarness(docWithInlineSelect(), { answering: false });

		const out = await h.runTool(setFieldOptionsSourceTool, {
			moduleUuid: MODULE,
			formUuid: FORM,
			fieldUuid: SELECT,
			source: LOOKUP_SOURCE,
		});

		expect(out.result).toHaveProperty("error");
		expect(h.recordMutations).not.toHaveBeenCalled();
	});
});
