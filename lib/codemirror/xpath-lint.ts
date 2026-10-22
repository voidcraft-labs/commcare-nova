/**
 * CodeMirror lint extension for form expressions.
 *
 * The linter underlines exactly what the slot's editor context checks
 * (`expressionEditorContext.ts`): each parse issue at its span, then the
 * slot checker's findings at the spans of the text as typed. The inline
 * lint and `XPathField`'s save gate read this one function.
 */

import { type Diagnostic, linter } from "@codemirror/lint";
import type { ExpressionEditorContext } from "./expressionEditorContext";

export const EXPRESSION_CONTEXT_UNAVAILABLE_MESSAGE =
	"This expression's place in the app changed. Reopen it to use the latest version.";

/** The context's check of the text, as diagnostics. */
export function xpathDiagnostics(
	source: string,
	context: ExpressionEditorContext | undefined,
): Diagnostic[] {
	if (!source.trim()) return [];
	if (context === undefined)
		return [
			{
				from: 0,
				to: source.length,
				severity: "error",
				message: EXPRESSION_CONTEXT_UNAVAILABLE_MESSAGE,
			},
		];
	return context.check(source).map(({ from, to, message }) => ({
		from,
		to,
		severity: "error",
		message,
	}));
}

export function xpathLinter(
	getContext: () => ExpressionEditorContext | undefined,
) {
	return linter((view) =>
		xpathDiagnostics(view.state.doc.toString(), getContext()),
	);
}
