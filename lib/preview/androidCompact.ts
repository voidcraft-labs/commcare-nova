/**
 * Which questions Android draws as a compact widget inside a compact group.
 *
 * A question under a group whose appearance is `compact`, at any depth
 * (`FormController.indexIsInCompact`), is handed to Android's widget
 * factory with `inCompactGroup` set (`QuestionsView`,
 * `FormEntryActivityUIController`). The factory passes it on only to the
 * text and number widgets: `StringWidget` (a text or password question,
 * `StringNumberWidget` among them) and `IntegerWidget` / `DecimalWidget`
 * (`WidgetFactory.buildBasicWidget`). Every other widget is built without
 * it and draws as it does anywhere. A compact widget
 * (`QuestionWidget(Context, FormEntryPrompt, boolean)`) puts the label's
 * text on one line, shortened to fit (`question_widget_text_compact.xml`),
 * beside a fixed-width answer box (`edit_text_question_widget_compact.xml`),
 * and builds no media, hint or help for the question. The screen still
 * holds one question (Core pages a compact group as it pages any group).
 */

import type { Field } from "@/lib/domain";

export function androidDrawsCompact(field: Field): boolean {
	return (
		field.kind === "text" ||
		field.kind === "secret" ||
		field.kind === "int" ||
		field.kind === "decimal"
	);
}
