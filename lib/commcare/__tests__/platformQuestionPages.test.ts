/**
 * The `question-pages` detector against the XForm builder's field-list rule.
 *
 * Contract: the containers `buildXForm` writes with `appearance="field-list"`
 * (a section always, a group exactly when it holds `fieldList`, labelled or
 * not) are exactly the uses `platformFeatureUses` finds for
 * `question-pages`, the feature Android pages and Web Apps shows on one
 * screen. A detector that drifts from the builder's rule, such as one that
 * still reads a group's label, fails here: the labelled group without the
 * flag and the unlabelled group with it each separate the two readings.
 */

import { findAll } from "domutils";
import { expect, it } from "vitest";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	platformFeatureUses,
	proseText,
} from "@/lib/domain";
import { expandDoc } from "../expander";
import { parseXml } from "../xmlParse";

const answer = (id: string) => f({ kind: "text", id, label: proseText(id) });
const group = (
	id: string,
	label: string,
	fieldList: boolean,
	children: FieldSpec[],
) =>
	f({
		kind: "group",
		id,
		uuid: `pages-${id}`,
		label: proseText(label),
		...(fieldList && { fieldList: true }),
		children,
	});

function pagesDoc(): BlueprintDoc {
	return buildDoc({
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
									group("nested", "Nested", true, [answer("nested_answer")]),
									group("inner", "Inner", false, [answer("inner_answer")]),
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
							group("household", "Household", false, [
								answer("household_answer"),
							]),
							group("unlabelled", "", true, [answer("unlabelled_answer")]),
							group("plain", "", false, [answer("plain_answer")]),
						],
					},
				],
			},
		],
	});
}

/** The last step of each body group's `ref` the form writes as one page. */
function fieldListGroups(xml: string): (string | undefined)[] {
	return findAll(
		(node) => node.name === "group" && node.attribs.appearance === "field-list",
		parseXml(xml).children,
	).map((node) => node.attribs.ref?.split("/").at(-1));
}

it("finds exactly the containers the XForm builder writes as one page", () => {
	const doc = pagesDoc();
	const forms = Object.values(expandDoc(doc)._attachments).filter(
		(xml): xml is string => typeof xml === "string",
	);
	expect(forms).toHaveLength(2);
	const written = forms.flatMap(fieldListGroups);
	const found = platformFeatureUses(doc, {
		features: new Set(["question-pages"]),
	}).map((use) =>
		use.owner.kind === "field"
			? doc.fields[use.owner.fieldUuid]?.id
			: undefined,
	);
	expect(found.sort()).toEqual(written.sort());
	expect(found.sort()).toEqual(
		["close", "nested", "unlabelled", "visit"].sort(),
	);
});
