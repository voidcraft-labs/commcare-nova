/**
 * Defect 14, close conditions: close forms whose conditions HQ's Case
 * Management tab cannot state.
 *
 * HQ's Case Management tab offers only selects, hidden values and labels
 * outside repeats as the question
 * (`templates/app_manager/partials/forms/case_config_ko_templates.html`,
 * `getQuestions('select select1', …)`, which
 * `static/app_manager/js/case_config_utils.js::getQuestions` widens by hidden
 * values and labels), so its save clears any other; every save strips an
 * answer's surrounding `"` (`views/forms.py::edit_form_actions`); a save over
 * a select with inline options writes its first option for an answer that is
 * none of them; and HQ builds the answer inside single quotes with nothing
 * escaped (`xform.py::XForm.action_relevance`), so an answer holding `'`
 * reads as another condition, or as no XPath at all, which Core's parser
 * refuses. Nova writes such a close as a Save to Case close in the form's
 * source, with `close_case` `never`
 * (`lib/domain/closeCondition.ts::closeConditionPlacement`), so the save keeps
 * it and both export paths close the same case.
 *
 * - `targeted-close-conditions`, one close form per part: a hidden value
 *   holding `"done"` compared with `"done"`, quotes included, so the visit
 *   closes; a hidden value holding `neither` compared with `x' or 'y`, so it
 *   does not, though HQ's build of the answer as entered reads the
 *   comparison as an `or` of two strings, true for every value; a text
 *   question, which the tab cannot set; and a select with the inline options
 *   `a` and `b` compared with `c`, which is neither, so it does not close.
 * - `targeted-close-condition-unparsable`: a hidden value compared with
 *   `it's done`, which HQ builds as XPath Core cannot parse.
 *
 * Fixed values: each outcome holds what the document gives it (the hidden
 * value's, what the worker enters, or the option the worker picks), which
 * its close condition compares.
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
	/** What the close condition reads: a hidden value, or a text question or a select the worker answers. */
	readonly on: "hidden" | "text" | "select";
	/** A select's inline option values, in order. */
	readonly options?: readonly string[];
	/** The value the outcome holds: the hidden value's, or the worker's answer; the answer itself unless named. */
	readonly holds?: string;
}

/** The outcome question `close` reads, in the form at `index`. */
function outcomeField(
	uuid: (name: string) => ReturnType<typeof targetedUuid>,
	{ answer, on, options, holds }: CloseForm,
	index: number,
) {
	switch (on) {
		case "hidden":
			return f({
				kind: "hidden",
				uuid: uuid(`outcome-${index}`),
				id: "outcome",
				calculate: literal(holds ?? answer),
			});
		case "text":
			return f({
				kind: "text",
				uuid: uuid(`outcome-${index}`),
				id: "outcome",
				label: proseText("Outcome"),
			});
		case "select":
			return f({
				kind: "single_select",
				uuid: uuid(`outcome-${index}`),
				id: "outcome",
				label: proseText("Outcome"),
				options: (options ?? []).map((value) => ({
					value,
					label: proseText(value),
				})),
			});
	}
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
				forms: closes.map((close, index) => ({
					uuid: uuid(`close-${index}`),
					name: close.name,
					type: "close" as const,
					closeCondition: { field: "outcome", answer: close.answer },
					fields: [outcomeField(uuid, close, index)],
				})),
			},
		],
	});
}

/**
 * What the worker answers the outcome, as Web Apps sends it: the text itself,
 * or a select's option by its 1-based index. A hidden value takes no answer.
 */
function outcomeAnswer({
	answer,
	on,
	options,
	holds,
}: CloseForm): string | undefined {
	const value = holds ?? answer;
	switch (on) {
		case "hidden":
			return undefined;
		case "text":
			return value;
		case "select": {
			const position = (options ?? []).indexOf(value);
			if (position < 0) {
				throw new Error(
					`The close form's outcome holds ${JSON.stringify(value)}, which is none of its options.`,
				);
			}
			return String(position + 1);
		}
	}
}

/** Each close form opened on the visit: what its outcome holds, as the document states it. */
function outcomesHeld(
	id: string,
	closes: readonly CloseForm[],
): readonly Expectation[] {
	return closes.map((close, index) => {
		const answered = outcomeAnswer(close);
		return {
			id: `outcome-held-${index}`,
			export: "local",
			form: targetedUuid(id, `close-${index}`),
			restore: "restore.xml",
			request: {
				session: { command: `m0-f${index}`, data: { case_id: VISIT } },
				...(answered !== undefined && {
					answers: [{ path: "/data/outcome", value: answered }],
				}),
				expressions: ["/data/outcome"],
			},
			expect: [
				...(answered !== undefined
					? [{ pointer: "/answers/0/result", value: "ok" }]
					: []),
				{ pointer: "/values/0/value", value: close.holds ?? close.answer },
			],
		};
	});
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
		{
			name: "Close on a missing option",
			answer: "c",
			on: "select",
			options: ["a", "b"],
			holds: "a",
		},
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
