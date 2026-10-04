/**
 * Defect 14, close conditions: close forms whose conditions HQ's Case
 * Management save or HQ's build do not keep as the document states them.
 *
 * Nova writes a close condition's question and answer into HQ's `close_case`
 * action as entered (`lib/commcare/formActions.ts`). HQ's Case Management tab
 * offers only selects, hidden values and labels outside repeats as the
 * question (`templates/app_manager/partials/forms/case_config_ko_templates.html`,
 * `getQuestions('select select1', …)`, which
 * `static/app_manager/js/case_config_utils.js::getQuestions` widens by hidden
 * values and labels), so its save clears any other; every save strips an
 * answer's surrounding `"` (`views/forms.py::edit_form_actions`); and HQ
 * builds the answer inside single quotes with nothing escaped
 * (`xform.py::XForm.action_relevance`), so an answer holding `'` reads as
 * another condition, or as no XPath at all, which Core's parser refuses.
 *
 * - `targeted-close-conditions`, one close form per part: a hidden value
 *   holding `"done"` compared with `"done"`, quotes included, so the visit
 *   closes; a hidden value holding `neither` compared with `x' or 'y`, so it
 *   does not, though HQ's build reads the comparison as an `or` of two
 *   strings, true for every value; and a text question, which the tab cannot
 *   set.
 * - `targeted-close-condition-unparsable`: a hidden value compared with
 *   `it's done`, which HQ builds as XPath Core cannot parse.
 *
 * Fixed values: each outcome holds what the document gives it (the hidden
 * value's, or what the worker enters), which its close condition compares.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

/** The visit each close form is opened on, in the restore its expectations read. */
const VISIT = "targeted-visit";

/** An XPath string literal holding `text`, in the quote it does not hold. */
function literal(text: string): string {
	return text.includes("'") ? `"${text}"` : `'${text}'`;
}

interface CloseForm {
	readonly name: string;
	/** The answer the close condition compares. */
	readonly answer: string;
	/** What the close condition reads: a hidden value, or a text question the worker answers. */
	readonly on: "hidden" | "text";
	/** The value the outcome holds: the hidden value's, or the worker's answer; the answer itself unless named. */
	readonly holds?: string;
}

function closeApp(id: string, closes: readonly CloseForm[]) {
	const uuid = (name: string) => targetedUuid(id, name);
	return buildDoc({
		appId: id,
		appName: "Visit outcomes",
		caseTypes: [
			{
				name: "visit",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: closes.map(({ name, answer, on, holds }, index) => ({
					uuid: uuid(`close-${index}`),
					name,
					type: "close" as const,
					closeCondition: { field: "outcome", answer },
					fields: [
						on === "hidden"
							? f({
									kind: "hidden",
									uuid: uuid(`outcome-${index}`),
									id: "outcome",
									calculate: literal(holds ?? answer),
								})
							: f({
									kind: "text",
									uuid: uuid(`outcome-${index}`),
									id: "outcome",
									label: proseText("Outcome"),
								}),
					],
				})),
			},
		],
	});
}

/** Each close form opened on the visit: what its outcome holds, as the document states it. */
function outcomesHeld(
	id: string,
	closes: readonly CloseForm[],
): readonly Expectation[] {
	return closes.map(({ answer, on, holds }, index) => ({
		id: `outcome-held-${index}`,
		export: "local",
		form: targetedUuid(id, `close-${index}`),
		restore: "restore.xml",
		request: {
			session: { command: `m0-f${index}`, data: { case_id: VISIT } },
			...(on === "text" && {
				answers: [{ path: "/data/outcome", value: holds ?? answer }],
			}),
			expressions: ["/data/outcome"],
		},
		expect: [
			...(on === "text" ? [{ pointer: "/answers/0/result", value: "ok" }] : []),
			{ pointer: "/values/0/value", value: holds ?? answer },
		],
	}));
}

const RESTORE = restoreXml({
	cases: [{ id: VISIT, type: "visit", name: "Home visit" }],
});

export function closeConditions() {
	const id = "targeted-close-conditions";
	const closes: readonly CloseForm[] = [
		{ name: "Close when done", answer: '"done"', on: "hidden" },
		{
			name: "Close on either",
			answer: "x' or 'y",
			on: "hidden",
			holds: "neither",
		},
		{ name: "Close on the outcome", answer: "done", on: "text" },
	];
	return targetedDocument({
		id,
		rows: ["14, close conditions"],
		doc: closeApp(id, closes),
		expected: { intent: outcomesHeld(id, closes) },
		files: { "restore.xml": RESTORE },
	});
}

export function closeConditionUnparsable() {
	const id = "targeted-close-condition-unparsable";
	const closes: readonly CloseForm[] = [
		{ name: "Close when finished", answer: "it's done", on: "hidden" },
	];
	return targetedDocument({
		id,
		rows: ["14, close conditions"],
		doc: closeApp(id, closes),
		expected: { intent: outcomesHeld(id, closes) },
		files: { "restore.xml": RESTORE },
	});
}
