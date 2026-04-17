/**
 * CodeMirror lint extension for CommCare XPath expressions.
 *
 * Takes a getter that returns pre-collected context slices (valid paths,
 * case properties, form field entries). The builder's XPath editors derive
 * these directly from the normalized doc — no wire-format `AppBlueprint`
 * or `BlueprintForm` appears in the lint/autocomplete surface.
 */

import { type Diagnostic, linter } from "@codemirror/lint";
import { validateXPath } from "@/lib/services/commcare/validate/xpathValidator";

/**
 * Context snapshot used by the XPath linter and autocomplete sources.
 *
 * Pre-collected at the call site (typically once per XPath editor mount)
 * so the lint / autocomplete runs don't have to walk forms or blueprints
 * themselves. Thinning the interface to just what the CodeMirror plugin
 * reads decouples this directory from the builder's domain model —
 * anything that can produce these three sets is a valid source.
 */
export interface XPathLintContext {
	/** Valid `/data/...` paths reachable in the current form. Used by lint
	 *  reference checking and data-path autocomplete. */
	validPaths: Set<string>;
	/** Case properties reachable from this form's module. Keyed by name for
	 *  O(1) autocomplete lookup; values carry the human-readable label shown
	 *  as the completion `detail`. `undefined` when the module has no case
	 *  type (survey-only) — matches the linter's "don't check #case refs". */
	caseProperties: Map<string, { label?: string }> | undefined;
	/** Value-producing fields in the current form, mapped to their XPath path
	 *  + human label. Used by #form/x autocomplete (label as `detail`). The
	 *  caller filters to value-producing kinds before handing the list in. */
	formEntries: ReadonlyArray<{
		path: string;
		label: string;
		kind: string;
	}>;
}

/** Create a CodeMirror lint extension that validates against the live context. */
export function xpathLinter(getContext: () => XPathLintContext | undefined) {
	return linter((view) => {
		const expr = view.state.doc.toString();
		if (!expr.trim()) return [];

		const ctx = getContext();
		const caseProperties = ctx?.caseProperties
			? new Set(ctx.caseProperties.keys())
			: undefined;

		const errors = validateXPath(expr, ctx?.validPaths, caseProperties);
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
