/**
 * A reading of an HQ author's own text is a fixed point of writing it back.
 *
 * Contract: for a text an author wrote in CommCare HQ that the reader holds,
 * the tree it reads is canonical (`canonicalExpression` leaves it as it is),
 * and writing the read app back with the production emitter and reading that
 * gives the same tree: `read(emit(read(A))) = read(A)`. The texts are each a
 * spelling Nova itself writes another way, one for each of the emitter's nine
 * rewrites: an absolute read in a starting value, an absolute read in a row
 * predicate inside a repeat, a bare comparison of two dates and times, an
 * unguarded read of a table, a bare read of the screen width, a case list
 * filter opening with `true() and`, a validation holding a count, and two
 * search rows, one hand-written with fixed quotes around a Search field's
 * answer and one calling `today()`. Each text reaches its own rewrite: the
 * reading reports it exactly where a worker meets the change, and Nova's
 * print of the tree read reaches it, but for the two relocations into
 * `current()`, whose tree read is spelled from `current()` already.
 *
 * Plausible failures: a reading that keeps HQ's spelling where Nova's print
 * differs, so a second reading of Nova's own export reads another tree (the
 * app would change at every round trip), a held tree that is not the
 * canonical one of its print collisions, and a text read under a rewrite it
 * never reaches, or reported under one it does not.
 */
import { isDeepStrictEqual } from "node:util";
import { findAll } from "domutils";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { expressionSlotKey } from "@/lib/domain/referenceSlots";
import { emitCsql } from "../../../csql/emitter";
import {
	EMISSION_REWRITES,
	type EmissionRewriteId,
} from "../../../emissionRewrites";
import { lookupWireNaming } from "../../../lookup/naming";
import { serializeXml } from "../../../serializeXml";
import { searchWireShape } from "../../../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../../../suite/case-search/types";
import { parseXml } from "../../../xmlParse";
import { serializeWire } from "../../../xpath/wire/serialize";
import { exportedBody } from "../../__tests__/novaExport";
import { canonicalExpression } from "../canonical";
import { readSearchFilterRow } from "../csqlRead";
import { lookupTypes, printSlot } from "../readExpression";
import { csqlRow, csqlVectorDoc, rowContext, rowEnv } from "./csqlVectors";
import {
	type EmissionReading,
	type ReadTables,
	readBody,
	readEmission,
} from "./readBackCorpus";

const TABLE = "01890000-0000-7000-8000-000000000301" as LookupTableId;
const NAME = "01890000-0000-7000-8000-000000000302" as LookupColumnId;
const WEIGHT = "01890000-0000-7000-8000-000000000303" as LookupColumnId;

const DISTRICTS = {
	id: TABLE,
	name: "Districts",
	tag: "districts",
	columns: [
		{ id: NAME, wireName: "name", label: "Name", dataType: "text" as const },
		{
			id: WEIGHT,
			wireName: "weight",
			label: "Weight",
			dataType: "int" as const,
		},
	],
};

/** The table, named for the export and held in the project space's catalog. */
const TABLES: ReadTables = {
	naming: lookupWireNaming([DISTRICTS]),
	catalog: {
		table: (tag) =>
			tag === DISTRICTS.tag
				? {
						tableId: TABLE,
						column: (name) =>
							DISTRICTS.columns.find((column) => column.wireName === name)?.id,
					}
				: undefined,
		definitions: new Map([[TABLE, DISTRICTS]]),
	},
};

function app(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "p", label: "P" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({
								kind: "text",
								id: "q2",
								label: "Q2",
								default_value: "#form/q1",
							}),
							f({ kind: "datetime", id: "dt1", label: "First" }),
							f({
								kind: "text",
								id: "dt2",
								label: "Second",
								relevant: "#form/q1 != ''",
							}),
							f({
								kind: "text",
								id: "checked",
								label: "Checked",
								validate: "#form/q1 != ''",
							}),
							// Its choices read the table, so the form declares it.
							f({
								kind: "single_select",
								id: "pick",
								label: "Pick",
								optionsSource: {
									kind: "lookup",
									tableId: TABLE,
									valueColumnId: NAME,
									labelColumnId: NAME,
								},
							}),
							f({
								kind: "repeat",
								id: "r",
								label: "Visits",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", id: "k", label: "Kind" }),
									f({ kind: "hidden", id: "c", calculate: "1" }),
								],
							}),
							f({ kind: "hidden", id: "d", calculate: "1" }),
						],
					},
				],
			},
		],
	});
}

/** The one element named `name` whose attribute `key` is `keyValue`, with
 *  `attribute` set to `value` and `drop` removed: an edit as HQ's form
 *  builder would leave it, made on the parsed source. */
function setAttribute(
	xml: string,
	name: string,
	key: string,
	keyValue: string,
	attribute: string,
	value: string,
	drop?: string,
): string {
	const document = parseXml(xml);
	const found = findAll(
		(one) => one.name === name && one.attribs[key] === keyValue,
		document.children,
	);
	const [element] = found;
	if (element === undefined || found.length !== 1)
		throw new Error(`No one ${name} element has ${key}="${keyValue}".`);
	element.attribs[attribute] = value;
	if (drop !== undefined) delete element.attribs[drop];
	return serializeXml(document);
}

/** HQ's text, as an author wrote it, for each slot this test reads, with the
 *  rewrite Nova's print of it reaches. */
const AUTHORED: readonly {
	readonly text: string;
	readonly rewrite: EmissionRewriteId;
}[] = [
	{ text: "/data/q1", rewrite: "default-reads-current" },
	{
		text: "count(instance('casedb')/casedb/case[@case_type = 'patient'][p = /data/r/k])",
		rewrite: "row-predicate-current",
	},
	{ text: "/data/dt1 > /data/dt1", rewrite: "instant-comparison" },
	{
		text: "instance('districts')/districts_list/districts[name = /data/q1]/weight",
		rewrite: "empty-rows-guard",
	},
	{ text: "count(/data/r/k[. = 'x']) > 0", rewrite: "validation-counts-moved" },
	{ text: "true() and p = 'x'", rewrite: "filter-identities-dropped" },
	{
		text: "instance('commcaresession')/session/context/window_width > 400",
		rewrite: "absent-session-value-guard",
	},
];
const [DEFAULT, ROW_PREDICATE, INSTANT, TABLE_READ, COUNT, FILTER, WIDTH] =
	AUTHORED.map((one) => one.text) as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];

function authoredBody(doc: BlueprintDoc): Record<string, unknown> {
	return exportedBody(doc, {
		expand: { lookupNaming: TABLES.naming },
		xml: (xml) => {
			let edited = setAttribute(
				xml,
				"setvalue",
				"ref",
				"/data/q2",
				"value",
				DEFAULT,
			);
			edited = setAttribute(
				edited,
				"bind",
				"nodeset",
				"/data/r/c",
				"calculate",
				ROW_PREDICATE,
				"vellum:calculate",
			);
			edited = setAttribute(
				edited,
				"bind",
				"nodeset",
				"/data/d",
				"calculate",
				TABLE_READ,
				"vellum:calculate",
			);
			edited = setAttribute(
				edited,
				"bind",
				"nodeset",
				"/data/dt2",
				"relevant",
				INSTANT,
				"vellum:relevant",
			);
			return setAttribute(
				edited,
				"bind",
				"nodeset",
				"/data/checked",
				"constraint",
				COUNT,
				"vellum:constraint",
			);
		},
		modules: (modules) => {
			const menu = modules[0] as Record<string, unknown>;
			menu.module_filter = WIDTH;
			const details = menu.case_details as {
				short: Record<string, unknown>;
			};
			details.short.filter = FILTER;
			return modules;
		},
	});
}

/** The registration a reading holds for `text`, and what it answered. */
function heldFor(reading: EmissionReading, text: string) {
	const slot = reading.slots.find((one) => one.registration.text === text);
	if (slot === undefined) throw new Error(`Nothing registered ${text}.`);
	return {
		registration: slot.registration,
		tree: slot.outcome.expression,
		claim: slot.outcome.claim,
	};
}

/** The tree a reading holds in the slot `key`, whatever its text. */
function heldAt(reading: EmissionReading, key: string): Expression | undefined {
	return reading.slots.find(
		(one) => expressionSlotKey(one.registration.ref) === key,
	)?.outcome.expression;
}

/** The two relocations into `current()`, which a read stored `current` never reaches. */
const RELOCATIONS: ReadonlySet<EmissionRewriteId> = new Set([
	"default-reads-current",
	"row-predicate-current",
]);

/** The rewrites whose report a worker reads: those that change what one meets. */
function reported(id: EmissionRewriteId): EmissionRewriteId[] {
	return EMISSION_REWRITES[id].behavior === "changes" ? [id] : [];
}

describe("a reading of an HQ author's text, written back and read again", () => {
	it("gives the same canonical tree in every slot, each reaching its own rewrite", async () => {
		const doc = app();
		const first = await readBody(
			authoredBody(doc),
			doc,
			recordDialectRoundTrip,
			TABLES,
		);
		const read = first.doc;
		if (read === undefined) throw new Error("The first reading bound nothing.");
		const second = await readEmission(read, recordDialectRoundTrip, TABLES);
		for (const { text, rewrite } of AUTHORED) {
			const { registration, tree, claim } = heldFor(first, text);
			expect(tree, `${text}: ${JSON.stringify(claim)}`).toBeDefined();
			if (tree === undefined) continue;
			const ref = registration.ref;
			const context = slotContext(read, ref, lookupTypes(first.env));
			if (context === undefined) throw new Error(`No slot holds ${text}.`);
			expect(canonicalExpression(tree, context), text).toEqual(tree);
			expect(heldAt(second, expressionSlotKey(ref)), text).toEqual(tree);
			const reached = new Set<EmissionRewriteId>();
			printSlot(read, ref, tree, first.env, {
				rewrites: { withhold: new Set(), reached: (id) => reached.add(id) },
			});
			if (RELOCATIONS.has(rewrite)) {
				// The tree read is spelled from `current()` already, as Nova's print
				// writes it, so nothing relocates it again.
				expect(JSON.stringify(tree), text).toContain('"spelling":"current"');
				expect([...reached], text).not.toContain(rewrite);
			} else expect([...reached], text).toContain(rewrite);
			expect(
				first.rewrites
					.filter(
						(one) =>
							one.key === registration.key &&
							isDeepStrictEqual(one.place, registration.place),
					)
					.map((one) => one.id),
				text,
			).toEqual(reported(rewrite));
		}
	});
});

describe("a search row an HQ author wrote, written back and read again", () => {
	const doc = csqlVectorDoc();
	const env = rowEnv(doc);
	const filter = rowContext(doc);
	const answer =
		"instance('search-input:results')/input/field[@name = 'region']";

	/** Nova's own row for a predicate, as the HQ JSON holds it. */
	function novaRow(predicate: Expression): string {
		const mod = doc.modules[filter.slot.uuid];
		const shape = mod?.caseSearchConfig
			? searchWireShape(mod.caseSearchConfig)
			: undefined;
		const wire = emitCsql(predicate, {
			types: filter,
			bindings:
				shape === undefined
					? {}
					: { searchInputInstanceId: searchInputInstanceId(shape) },
		}).wrapper;
		return serializeWire(wire, { target: "hq-json", interpolation: "none" })
			.text;
	}

	it.each([
		{
			text: `concat('village = "', ${answer}, '"')`,
			rewrite: "search-value-guards" as const,
		},
		{
			text: csqlRow("dob < today()"),
			rewrite: "search-today-device-day" as const,
		},
	])("reads $rewrite back as the tree it read", ({ text, rewrite }) => {
		const once = readSearchFilterRow(text, filter, env);
		if (!once.ok) throw new Error(`The row is not held: ${text}`);
		expect(once.rewrites).toEqual([rewrite]);
		expect(canonicalExpression(once.predicate, filter)).toEqual(once.predicate);
		expect(readSearchFilterRow(novaRow(once.predicate), filter, env)).toEqual({
			ok: true,
			predicate: once.predicate,
			level: "exact",
			rewrites: [],
		});
	});
});
