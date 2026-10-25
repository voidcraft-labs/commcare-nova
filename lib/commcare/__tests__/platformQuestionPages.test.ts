/**
 * The `question-pages` detector against the XForm builder's field-list rule.
 *
 * Contract: the containers `buildXForm` writes with `appearance="field-list"`
 * (a section always, a group whose label shows in some language, its
 * translation included) are exactly the uses `platformFeatureUses` finds for
 * `question-pages`, the feature Android pages and Web Apps shows on one
 * screen. A detector that drifts from the builder's rule, including a label
 * that only a translation fills, fails here.
 */

import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	platformFeatureUses,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { expandDoc } from "../expander";

const answer = (id: string) => f({ kind: "text", id, label: proseText(id) });
const group = (id: string, label: string, children: FieldSpec[]) =>
	f({
		kind: "group",
		id,
		uuid: `pages-${id}`,
		label: proseText(label),
		children,
	});

function pagesDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Pages",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Sections",
						type: "survey",
						fields: [
							f({
								kind: "section",
								id: "visit",
								label: proseText("Visit"),
								children: [
									group("inner", "Inner", [answer("inner_answer")]),
									answer("visit_answer"),
								],
							}),
							f({
								kind: "section",
								id: "close",
								children: [answer("close_answer")],
							}),
						],
					},
					{
						name: "Groups",
						type: "survey",
						fields: [
							group("household", "Household", [answer("household_answer")]),
							group("plain", "", [answer("plain_answer")]),
							group("translated", "", [answer("translated_answer")]),
						],
					},
				],
			},
		],
	});
	const units = translationUnitsById(doc);
	const translated = Object.values(doc.fields).find(
		(field) => field.id === "translated",
	);
	if (translated === undefined) throw new Error("No translated group.");
	const unitId: TranslationUnitId = makeTranslationUnitId(
		"field",
		translated.uuid,
		"label",
	);
	const unit = units.get(unitId);
	if (unit === undefined) throw new Error("The group has no label unit.");
	const entry: TranslationEntry = {
		value: proseText("Familia"),
		sourceFingerprint: unit.sourceFingerprint,
		origin: "human",
		review: "reviewed",
		translatedFrom: "eng",
	};
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		wireCodes: { eng: "en", spa: "es" },
		translations: { spa: { [unitId]: entry } },
	};
	return doc;
}

it("finds exactly the containers the XForm builder writes as one page", () => {
	const doc = pagesDoc();
	const forms = Object.values(expandDoc(doc)._attachments).filter(
		(xml): xml is string => typeof xml === "string",
	);
	expect(forms).toHaveLength(2);
	const written = forms.flatMap((xml) => {
		new SaxesParser({ xmlns: true }).write(xml).close();
		return findAll(
			(node) =>
				isTag(node) &&
				node.name === "group" &&
				node.attribs.appearance === "field-list",
			parseDocument(xml, { xmlMode: true }).children,
		).map((node) => node.attribs.ref?.split("/").at(-1));
	});
	const found = platformFeatureUses(doc, {
		features: new Set(["question-pages"]),
	}).map((use) =>
		use.owner.kind === "field"
			? doc.fields[use.owner.fieldUuid]?.id
			: undefined,
	);
	expect(found.sort()).toEqual(written.sort());
	expect(found.sort()).toEqual(
		["close", "household", "inner", "translated", "visit"].sort(),
	);
});
