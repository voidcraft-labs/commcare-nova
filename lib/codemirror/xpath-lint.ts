/**
 * CodeMirror lint extension for form expressions.
 *
 * The linter underlines exactly what the slot's editor context checks
 * (`expressionEditorContext.ts`): each parse issue at its span, then the
 * slot checker's findings at the spans of the text as typed. The inline
 * lint and `XPathField`'s save gate read this one function.
 *
 * A mount may offer actions on a finding (`XPathLintActions`): each is a
 * label and a run over the draft as it stands, shown as a button in the
 * finding's lint tooltip. An action never edits the text; what it does to the
 * stored expression is the mount's.
 */

import { type Action, type Diagnostic, linter } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type {
	ExpressionEditorContext,
	ExpressionFinding,
} from "./expressionEditorContext";

export const EXPRESSION_CONTEXT_UNAVAILABLE_MESSAGE =
	"This expression's place in the app changed. Reopen it to use the latest version.";

/** One action a mount offers on a finding: its label, and what it does with
 *  the draft. */
export interface XPathLintAction {
	readonly name: string;
	readonly run: (draft: string) => void;
}

/** The actions a mount offers on one finding of a draft, or none. */
export type XPathLintActions = (
	finding: ExpressionFinding,
	draft: string,
) => readonly XPathLintAction[];

/** The context's check of the text, as diagnostics, each with the actions
 *  the mount offers on its finding. */
export function xpathDiagnostics(
	source: string,
	context: ExpressionEditorContext | undefined,
	actionsFor?: XPathLintActions,
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
	return context.check(source).map((finding) => {
		const actions = actionsFor?.(finding, source) ?? [];
		const diagnostic: Diagnostic = {
			from: finding.from,
			to: finding.to,
			severity: "error",
			message: finding.message,
		};
		return actions.length === 0
			? diagnostic
			: {
					...diagnostic,
					actions: actions.map(
						(action): Action => ({
							name: action.name,
							apply: (view: EditorView) =>
								action.run(view.state.doc.toString()),
						}),
					),
				};
	});
}

export function xpathLinter(
	getContext: () => ExpressionEditorContext | undefined,
	getActions?: () => XPathLintActions | undefined,
) {
	return linter((view) =>
		xpathDiagnostics(view.state.doc.toString(), getContext(), getActions?.()),
	);
}
