/**
 * CodeMirror lint extension for CommCare XPath expressions.
 *
 * Takes a getter that reads the current form context from the blueprint.
 * The linter calls it on each run to derive valid paths and case properties,
 * then validates the draft expression against the live blueprint state.
 */

import { linter, type Diagnostic } from "@codemirror/lint";
import type { AppBlueprint, BlueprintForm } from "@/lib/schemas/blueprint";
import { validateXPath } from "@/lib/services/commcare/validate/xpathValidator";
import {
	collectValidPaths,
	collectCaseProperties,
} from "@/lib/services/commcare/validate/index";

export interface XPathLintContext {
	blueprint: AppBlueprint;
	form: BlueprintForm;
	moduleCaseType?: string;
}

/** Create a CodeMirror lint extension that validates against the live blueprint. */
export function xpathLinter(getContext: () => XPathLintContext | undefined) {
	return linter((view) => {
		const expr = view.state.doc.toString();
		if (!expr.trim()) return [];

		const ctx = getContext();
		const validPaths = ctx?.form.questions
			? collectValidPaths(ctx.form.questions)
			: undefined;
		const caseProperties = ctx
			? collectCaseProperties(ctx.blueprint, ctx.moduleCaseType)
			: undefined;

		const errors = validateXPath(expr, validPaths, caseProperties);
		const diagnostics: Diagnostic[] = [];

		for (const err of errors) {
			const from = err.position ?? 0;
			const to = Math.min(from + 1, expr.length);
			diagnostics.push({
				from,
				to,
				severity: "error",
				message: err.message,
			});
		}

		return diagnostics;
	});
}
