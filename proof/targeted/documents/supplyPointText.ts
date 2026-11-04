/**
 * The text CommCare HQ reads as the session's supply point
 * (`targeted-supply-point-text`).
 *
 * Where a project space has CommCare Supply on, HQ's build gives a form's
 * entry a `supply_point_id` datum from the worker's `commtrack-supply-point`
 * user data, with assertions, when the form's stored source contains
 * `instance('commcaresession')/session/data/supply_point_id` as a substring
 * (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, the text
 * `xpath.py::session_var` prints). The test is a substring test over the
 * source, so text that reads nothing is enough.
 *
 * "Stock note", a survey in English and French, says the path in a text
 * question's label in both languages, and holds it as a string literal in
 * a hidden value's calculate. Nova's export writes the path's apostrophes as
 * `&apos;`, so the bytes Nova sends never hold the substring; a save in HQ's
 * form builder writes them plainly. So Nova's publish asks the person to
 * confirm CommCare Supply is off for this document (`commtrack-off`,
 * `lib/commcare/planPrivileges.ts::commtrackReasons`), and its verdict
 * requires it off (`minimumConfiguration.commtrackEnabled: false`).
 *
 * Fixed values: the note answered `ok` holds `ok`, and the hidden value holds
 * the path as text.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { SUPPLY_POINT_SESSION_TEXT } from "@/lib/commcare/xform/supplyPointText";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";

const ID = "targeted-supply-point-text";
const uuid = (name: string) => targetedUuid(ID, name);

/** Reviewed French entries for the units `texts` names. */
function frenchEntries(
	doc: BlueprintDoc,
	texts: ReadonlyMap<TranslationUnitId, ReturnType<typeof proseText>>,
): Record<TranslationUnitId, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId);
		if (unit === undefined)
			throw new Error(
				`${ID} names the translation unit ${unitId}, which it does not hold.`,
			);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	return entries;
}

/** The app, its survey saying the path in a label and holding it in a literal. */
export function supplyPointTextApp(): BlueprintDoc {
	const note = uuid("note");
	const doc = buildDoc({
		appId: ID,
		appName: "Stock notes",
		modules: [
			{
				uuid: uuid("module"),
				name: "Stock",
				forms: [
					{
						uuid: uuid("form"),
						name: "Stock note",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: note,
								id: "note",
								label: proseText(
									`Note what ${SUPPLY_POINT_SESSION_TEXT} names here`,
								),
							}),
							f({
								kind: "hidden",
								uuid: uuid("path"),
								id: "path",
								calculate: `"${SUPPLY_POINT_SESSION_TEXT}"`,
							}),
						],
					},
				],
			},
		],
	});
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: frenchEntries(
				doc,
				new Map([
					[
						makeTranslationUnitId("field", note, "label"),
						proseText(`Notez ce que ${SUPPLY_POINT_SESSION_TEXT} nomme ici`),
					],
				]),
			),
		},
	};
	return doc;
}

export function supplyPointText() {
	const form = uuid("form");
	const intent: Expectation[] = (["local", "A"] as const).map((exportName) => ({
		id: `supply-point-text-${exportName}`,
		export: exportName,
		form,
		request: {
			answers: [{ path: "/data/note", value: "ok" }],
			expressions: ["/data/note", "/data/path"],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value: "ok" },
			{ pointer: "/values/1/value", value: SUPPLY_POINT_SESSION_TEXT },
		],
	}));
	return targetedDocument({
		id: ID,
		rows: ["20, supply_point_id text"],
		doc: supplyPointTextApp(),
		expected: { intent },
	});
}
