/**
 * A menu's and a form's display condition that reads the session through HQ's
 * `#session/` shorthand, read whole.
 *
 * Contract: HQ's build writes `#session/` as `instance('commcaresession')/session/`
 * in every slot it interpolates (`corehq/apps/app_manager/xpath.py::interpolate_xpath`),
 * and HQ's pages write the shorthand, so a display condition spelled either way
 * is held as the one tree Nova's own spelling reads to. The failure it catches:
 * the menus settle comparing the stored text with Nova's print as written,
 * which leaves the shorthand unrecognized though the expression stage held it.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp } from "../index";
import { exportedBody, inputFor } from "./novaExport";

const MODULE = testUuid("session-shorthand-module");

const inEnglish: Expression = {
	kind: "eq",
	left: {
		kind: "term",
		term: { kind: "session-context", field: "applanguage" },
	},
	right: { kind: "term", term: { kind: "literal", value: "en" } },
};
const named: Expression = {
	kind: "neq",
	left: { kind: "term", term: { kind: "session-context", field: "username" } },
	right: { kind: "term", term: { kind: "literal", value: "" } },
};

/** A menu shown in English, whose survey is shown to a worker with a name. */
function app(): BlueprintDoc {
	return buildDoc({
		appName: "Shorthand",
		modules: [
			{
				uuid: MODULE,
				name: "Tools",
				displayCondition: inEnglish,
				forms: [
					{
						name: "Survey",
						type: "survey",
						displayCondition: named,
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
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
		}),
	);
}

describe("display conditions spelled with HQ's #session/ shorthand", () => {
	it("are held as the tree Nova's own spelling reads to", async () => {
		const doc = app();
		const body = exportedBody(doc, {
			modules: (modules) => {
				const menu = modules[0] as Record<string, unknown> & {
					forms: Record<string, unknown>[];
				};
				menu.module_filter = "#session/context/applanguage = 'en'";
				(menu.forms[0] as Record<string, unknown>).form_filter =
					"#session/context/username != ''";
				return modules;
			},
		});
		const outcome = await read(body, doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The source read to an account: ${JSON.stringify(outcome.findings)}`,
			);
		const held = outcome.draft.doc;
		const form = held.formOrder[MODULE]?.[0];
		expect(held.modules[MODULE]?.displayCondition).toEqual(inEnglish);
		expect(
			form === undefined ? undefined : held.forms[form]?.displayCondition,
		).toEqual(named);
	});

	// The control: Nova's own spelling reads to the same document.
	it("read to the same document as Nova's own spelling", async () => {
		const doc = app();
		const outcome = await read(exportedBody(doc), doc);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(
				`The export read to an account: ${JSON.stringify(outcome.findings)}`,
			);
		expect(outcome.draft.doc.modules[MODULE]?.displayCondition).toEqual(
			inEnglish,
		);
	});
});
