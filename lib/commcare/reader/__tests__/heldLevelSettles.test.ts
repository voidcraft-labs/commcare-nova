/**
 * A slot an HQ author spelled without one of Nova's rewrites, read whole and settled.
 *
 * Contract: a menu's display condition, a form's display condition, a case list's filter and a
 * calculated column that read the screen width bare, where Nova prints the read inside
 * `if(count(…) > 0, …, '')` (`emissionRewrites.ts`, `absent-session-value-guard`), are held: the
 * reading is the document Nova's own spelling reads to, with the rewrite recorded at each slot a
 * worker meets it, and every settle that prints a slot again prints it at the level the
 * expression stage held it (`expressions/printLevel.ts`). The failures it catches: a calculated
 * column printed without the reader's rewrite control (`readExpression.ts::printSlot` dropping it
 * before `hqExpressionField`), so a bare read in a column is left unrecognized; a case list
 * settle that prints the filter and the columns with every rewrite applied
 * (`caseList/index.ts::heldListLevels`); and a menus settle that compares the stored display
 * conditions with the expansion's print, which applies every rewrite
 * (`menus/index.ts::heldAtLevel`). Each is a refusal of an app Nova holds. A Search field's
 * starting value and a form's calculate that read a table's column bare, where Nova prints the
 * read inside `empty-rows-guard`, are held the same way over the reading's lookup catalog.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	type BlueprintDoc,
	calculatedColumn,
	NEW_APP_SETTINGS,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	literal,
	tableColumn,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { lookupWireNaming } from "../../lookup/naming";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp } from "../index";
import { readFormSyntax } from "../syntaxRead";
import { exportedBody, inputFor } from "./novaExport";

const MODULE = testUuid("held-level-module");
const COLUMN = testUuid("held-level-column");

const WIDTH = "instance('commcaresession')/session/context/window_width";
const width: Expression = {
	kind: "term",
	term: { kind: "session-context", field: "window_width" },
};
const wider = (value: number): Expression => ({
	kind: "gt",
	left: width,
	right: { kind: "term", term: { kind: "literal", value } },
});

/** A web app whose menu, form, list filter and one calculated column read the screen width. */
function app(): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = [
		...config.columns,
		calculatedColumn(COLUMN, "Width", width),
	];
	config.listColumnOrder = config.columns.map((column) => column.uuid);
	config.detailColumnOrder = config.columns.map((column) => column.uuid);
	config.filter = wider(200);
	return buildDoc({
		appName: "Widths",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				displayCondition: wider(400),
				forms: [
					{
						name: "Visit",
						type: "followup",
						displayCondition: wider(300),
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
}

type Menu = Record<string, unknown> & {
	forms: Record<string, unknown>[];
	case_details: Record<
		"short" | "long",
		Record<string, unknown> & { columns: Record<string, unknown>[] }
	>;
};

/** HQ's source with each slot spelled bare, as an author types it on HQ's pages. */
function bareBody(doc: BlueprintDoc): Record<string, unknown> {
	return exportedBody(doc, {
		modules: (modules) => {
			const menu = modules[0] as Menu;
			menu.module_filter = `${WIDTH} > 400`;
			(menu.forms[0] as Record<string, unknown>).form_filter = `${WIDTH} > 300`;
			menu.case_details.short.filter = `${WIDTH} > 200`;
			for (const screen of ["short", "long"] as const)
				for (const column of menu.case_details[screen].columns)
					if (String(column.field).includes("window_width"))
						column.field = WIDTH;
			return modules;
		},
	});
}

async function read(body: Record<string, unknown>, doc: BlueprintDoc) {
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
			recordDialect: recordDialectRoundTrip,
		}),
	);
}

describe("slots that read the screen width bare, read whole", () => {
	it("are held as Nova's own spelling reads, with the guard recorded at each", async () => {
		const doc = app();
		const outcome = await read(bareBody(doc), doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The source read to an account: ${JSON.stringify(outcome.findings)}`,
			);
		const held = outcome.draft.doc;
		const form = held.formOrder[MODULE]?.[0];
		expect(held.modules[MODULE]?.displayCondition).toEqual(wider(400));
		expect(
			form === undefined ? undefined : held.forms[form]?.displayCondition,
		).toEqual(wider(300));
		expect(held.modules[MODULE]?.caseListConfig?.filter).toEqual(wider(200));
		expect(
			held.modules[MODULE]?.caseListConfig?.columns.find(
				(column) => column.uuid === COLUMN,
			),
		).toMatchObject({ kind: "calculated", expression: width });
		expect(
			outcome.draft.facts.rewrites
				.map((rewrite) => `${rewrite.id} ${rewrite.place.kind} ${rewrite.key}`)
				.sort(),
		).toEqual([
			"absent-session-value-guard case-list schema:Detail.filter",
			"absent-session-value-guard case-list schema:DetailColumn.field",
			"absent-session-value-guard form schema:Form.form_filter",
			"absent-session-value-guard menu schema:Module.module_filter",
		]);
		// Each rewrite names the value of the stored app its slot was read from, which places it.
		expect(
			outcome.draft.facts.rewrites.map((rewrite) => rewrite.pointer).sort(),
		).toEqual([
			"/modules/0/case_details/short/columns/1/field",
			"/modules/0/case_details/short/filter",
			"/modules/0/forms/0/form_filter",
			"/modules/0/module_filter",
		]);
	});

	// The control: Nova's own spelling reads to the same document with no rewrite.
	it("spelled inside the guard, read to the same document with no rewrite", async () => {
		const doc = app();
		const outcome = await read(exportedBody(doc), doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The export read to an account: ${JSON.stringify(outcome.findings)}`,
			);
		expect(outcome.draft.facts.rewrites).toEqual([]);
		expect(outcome.draft.doc.modules[MODULE]?.displayCondition).toEqual(
			wider(400),
		);
	});
});

const TABLE = "01890000-0000-7000-8000-000000000401" as LookupTableId;
const CODE = "01890000-0000-7000-8000-000000000402" as LookupColumnId;
const NAME = "01890000-0000-7000-8000-000000000403" as LookupColumnId;
const KIND = testUuid("held-level-kind");
const columns = [
	{ id: CODE, wireName: "code", label: "Code", dataType: "text" as const },
	{ id: NAME, wireName: "name", label: "Name", dataType: "text" as const },
];
const tables = [{ id: TABLE, name: "Kinds", tag: "kinds", columns }];

/** The name of the kind coded `a`, read from the project space's table of kinds. */
const kindName: Expression = {
	kind: "table-lookup",
	tableId: TABLE,
	resultColumnId: NAME,
	where: eq(term(tableColumn(TABLE, CODE)), literal("a")),
};

/** An app whose Search field starts at a kind's name, and whose form works out the same name. */
function tableApp(): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(KIND, "kind", "Kind", "text", "kind", {
			default: kindName,
		}),
	];
	return buildDoc({
		appName: "Kinds",
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: {},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "hidden", id: "kind_name", calculate: kindName }),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "kind", label: proseText("Kind") },
				],
			},
		],
	});
}

/** `text` without Nova's empty-rows guard: the read `if(count(rows) > 0, read, '')` guards,
 *  as the source's own text of that argument. */
function unguarded(text: string): string {
	const read = readFormSyntax(text);
	const node = read.ok ? read.node : undefined;
	const value = node?.kind === "call" ? node.args[1] : undefined;
	if (node?.kind !== "call" || node.name !== "if" || value === undefined)
		throw new Error("Nova printed no guarded read of the table here.");
	return text.slice(value.from, value.to);
}

/** The characters the XForm serializer escapes in an attribute (`serializeXml.ts`). */
const XML_ESCAPES: readonly (readonly [string, string])[] = [
	["&", "&amp;"],
	["<", "&lt;"],
	[">", "&gt;"],
	['"', "&quot;"],
	["'", "&apos;"],
];

/** `text` as the XForm serializer writes it into an attribute. */
function escaped(text: string): string {
	return XML_ESCAPES.reduce(
		(out, [raw, entity]) => out.split(raw).join(entity),
		text,
	);
}

/** HQ's source with the Search field's starting value and the form's calculate reading the
 *  table bare, as an author types each on HQ's pages. */
function bareTableBody(doc: BlueprintDoc): Record<string, unknown> {
	const naming = lookupWireNaming(tables);
	const exported = exportedBody(doc, { expand: { lookupNaming: naming } });
	const guardedDefault =
		(
			exported.modules as {
				search_config: { properties: { default_value: string }[] };
			}[]
		)[0]?.search_config.properties[0]?.default_value ?? "";
	return exportedBody(doc, {
		expand: { lookupNaming: naming },
		modules: (modules) => {
			const prompt = (
				modules[0] as {
					search_config: { properties: Record<string, unknown>[] };
				}
			).search_config.properties[0] as Record<string, unknown>;
			prompt.default_value = unguarded(guardedDefault);
			return modules;
		},
		xml: (xml) => {
			const bind = xml.indexOf('nodeset="/data/kind_name"');
			const start = xml.lastIndexOf("<bind", bind);
			const end = xml.indexOf("/>", bind);
			const element = xml.slice(start, end);
			const opens = element.indexOf('calculate="') + 'calculate="'.length;
			const guarded = element.slice(opens, element.indexOf('"', opens));
			if (bind < 0 || guarded === "")
				throw new Error("The form holds no calculate of the kind's name.");
			const bare = escaped(
				unguarded(
					XML_ESCAPES.reduceRight(
						(out, [raw, entity]) => out.split(entity).join(raw),
						guarded,
					),
				),
			);
			return `${xml.slice(0, start)}${element.replace(guarded, bare)}${xml.slice(end)}`;
		},
	});
}

/** The starting value a reading holds for the Search field `kind`. */
function searchDefault(doc: BlueprintDoc): unknown {
	const inputs = doc.modules[MODULE]?.caseListConfig?.searchInputs ?? [];
	const input = inputs.find((one) => one.name === "kind");
	if (input === undefined)
		throw new Error("The reading holds no Search field kind.");
	return "default" in input ? input.default : undefined;
}

/** The calculate a reading holds for the form's Hidden Value `kind_name`. */
function kindNameCalculate(doc: BlueprintDoc): unknown {
	const field = Object.values(doc.fields).find((one) => one.id === "kind_name");
	if (field?.kind !== "hidden")
		throw new Error("The reading holds no Hidden Value kind_name.");
	return field.calculate;
}

async function readTables(body: Record<string, unknown>, doc: BlueprintDoc) {
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
			recordDialect: recordDialectRoundTrip,
			lookup: {
				table: (tag) =>
					tag === "kinds"
						? {
								tableId: TABLE,
								column: (name) =>
									columns.find((column) => column.wireName === name)?.id,
							}
						: undefined,
				definitions: new Map(tables.map((table) => [table.id, table])),
			},
		}),
	);
}

// Contract: a Search field's starting value and a form's calculate that read a table's column
// bare, where Nova prints the read inside `if(count(<rows>) > 0, …, '')` (`empty-rows-guard`),
// are held at the level whose print is the source, through a whole reading over a lookup
// catalog, with the guard recorded at each. The failure it catches: a search settle that prints
// the field with every rewrite applied, refusing the whole search, or a form slot's print that
// drops the reader's control.
describe("slots that read a table's column bare, read whole", () => {
	it("are held as Nova's own spelling reads, with the guard recorded at each", async () => {
		const doc = tableApp();
		const outcome = await readTables(bareTableBody(doc), doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The source read to an account: ${JSON.stringify(outcome.findings)}`,
			);
		const held = outcome.draft.doc;
		expect(searchDefault(held)).toEqual(kindName);
		expect(kindNameCalculate(held)).toEqual(kindName);
		expect(
			outcome.draft.facts.rewrites
				.map((rewrite) => `${rewrite.id} ${rewrite.place.kind} ${rewrite.key}`)
				.sort(),
		).toEqual([
			"empty-rows-guard question xform:model/bind@calculate",
			"empty-rows-guard search schema:CaseSearchProperty.default_value",
		]);
	});

	// The control: Nova's own spelling reads to the same document with no rewrite.
	it("spelled inside the guard, read to the same document with no rewrite", async () => {
		const doc = tableApp();
		const outcome = await readTables(
			exportedBody(doc, { expand: { lookupNaming: lookupWireNaming(tables) } }),
			doc,
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The export read to an account: ${JSON.stringify(outcome.findings)}`,
			);
		expect(outcome.draft.facts.rewrites).toEqual([]);
		expect(searchDefault(outcome.draft.doc)).toEqual(kindName);
		expect(kindNameCalculate(outcome.draft.doc)).toEqual(kindName);
	});
});
