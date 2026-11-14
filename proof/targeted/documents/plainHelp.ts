/**
 * Text shown as typed (`targeted-plain-help`).
 *
 * The survey "Help" asks two questions whose help text is the same,
 * `**bold** and a [link](https://example.org)`: the first holds `plainHelp`,
 * which Nova writes with no markdown form, and the second does not, which
 * Nova writes with one. The first also holds a hint and a validation message
 * typed with the same symbols, which Nova writes with no markdown form
 * whatever the question holds: no runtime reads one. Their texts differ from
 * each other and from the help: HQ's build keeps one of a form's texts that
 * hold the same values and points every reference at it (commcare-hq
 * `corehq/apps/app_manager/xform.py::XForm.normalize_itext`), so a hint
 * holding the help's text would be built as the help itself, and a markdown
 * copy given to it would move it onto the second question's help
 * (`proof/rules/test_hint_validation_markdown_form.py` reads each apart).
 * Android formats a help text only where its text holds that form
 * (commcare-android `QuestionWidget.java::createHelpLayout`), so the first
 * question's help shows its symbols on a device and the second's shows
 * formatting (`proof/android/test_form_reads.py::test_a_help_text_without_markdown_renders_its_text_as_written`).
 *
 * The survey "As typed" holds `plainText`, the form builder's Disable Text
 * Formatting: Nova writes `vellum:ignore="markdown"` on `h:html` and no
 * markdown form on its label, its choices or its help text, so a device
 * shows each as typed. HQ's form builder reopens it with the property set and
 * writes no markdown form on a save (Vellum `src/parser.js::parseXForm`,
 * `src/javaRosa/plugin.js::contributeToModelXML`), and keeps a hint written
 * with none as it is, so its saves hold both forms as Nova wrote them, which
 * `proof/editors/test_text_formatting_saves.py` reads from what HQ stores
 * (proof 4 compares saves after the spelling rules, which erase both).
 *
 * Fixed values: the first form's note holds what the worker answers.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-plain-help";
const uuid = (name: string) => targetedUuid(ID, name);

/** The text each help and as-typed text holds. */
export const PLAIN_HELP_TEXT = "**bold** and a [link](https://example.org)";
/** The first question's hint, typed with the help's symbols in a text of its own. */
export const PLAIN_HINT_TEXT = "**hint** and a [link](https://example.org)";
/** The first question's validation message, typed with the help's symbols in a text of its own. */
export const PLAIN_MESSAGE_TEXT =
	"**message** and a [link](https://example.org)";

export function plainHelp() {
	const help = uuid("help-form");
	const asTyped = uuid("as-typed-form");
	const doc = buildDoc({
		appId: ID,
		appName: "Help as typed",
		// Declared for Web Apps and Android, as a new app is.
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: uuid("module"),
				name: "Help",
				forms: [
					{
						uuid: help,
						name: "Help",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("plain-help"),
								id: "plain_help",
								label: proseText("Help as typed"),
								help: proseText(PLAIN_HELP_TEXT),
								plainHelp: true,
								hint: proseText(PLAIN_HINT_TEXT),
								validate: ". != 'invalid'",
								validate_msg: proseText(PLAIN_MESSAGE_TEXT),
							}),
							f({
								kind: "text",
								uuid: uuid("marked-help"),
								id: "marked_help",
								label: proseText("Help in markdown"),
								help: proseText(PLAIN_HELP_TEXT),
							}),
						],
					},
					{
						uuid: asTyped,
						name: "As typed",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: uuid("as-typed-choices"),
								id: "as_typed_choices",
								label: proseText(PLAIN_HELP_TEXT),
								help: proseText(PLAIN_HELP_TEXT),
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: uuid("as-typed-choice"),
											value: "choice",
											label: proseText(PLAIN_HELP_TEXT),
										},
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[asTyped] = { ...doc.forms[asTyped], plainText: true };
	return targetedDocument({
		id: ID,
		rows: [
			"help text shown as typed: plainHelp writes no markdown form",
			"a form whose text formatting is off: plainText writes vellum:ignore and no markdown form",
		],
		doc,
		expected: {
			intent: [
				answerHeld("plain-help-held", help, "/data/marked_help", "seen"),
				answerHeld("plain-help-held-a", help, "/data/marked_help", "seen", "A"),
			],
		},
	});
}
