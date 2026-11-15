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
 * (`menus/index.ts::heldAtLevel`). Each is a refusal of an app Nova holds.
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
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp } from "../index";
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
