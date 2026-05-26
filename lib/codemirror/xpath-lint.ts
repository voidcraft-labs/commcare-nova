/**
 * CodeMirror lint extension for CommCare XPath expressions.
 *
 * Takes a getter that returns pre-collected context slices (valid paths,
 * case properties, form field entries). The builder's XPath editors derive
 * these directly from the normalized doc so the lint/autocomplete surface
 * stays decoupled from the domain model.
 */

import { type Diagnostic, linter } from "@codemirror/lint";
import { validateXPath } from "@/lib/commcare/validator/xpathValidator";
import type { FieldKind, FormType } from "@/lib/domain";

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
	 *  caller filters to value-producing kinds before handing the list in.
	 *  `kind` is narrowed to the domain `FieldKind` union so downstream
	 *  consumers (reference provider, chip rendering) can index
	 *  `fieldRegistry` without a widening cast. */
	formEntries: ReadonlyArray<{
		path: string;
		label: string;
		kind: FieldKind;
	}>;
	/**
	 * The owning form's type. Drives surfaces that change behavior with
	 * form-creates-case semantics — most notably `#case/` autocomplete on
	 * registration forms, which surfaces only `#case/case_id` because no
	 * other case property is resolvable at form-init (the case doesn't
	 * exist in casedb yet). Mirrors the `CASE_HASHTAG_ON_CREATE_FORM`
	 * validator rule so the editor's affordances agree with the rule's
	 * rejection set.
	 */
	formType: FormType;
}

/** Create a CodeMirror lint extension that validates against the live context. */
export function xpathLinter(getContext: () => XPathLintContext | undefined) {
	return linter((view) => {
		const expr = view.state.doc.toString();
		if (!expr.trim()) return [];

		const ctx = getContext();
		// Narrow the case-property accept set to mirror the
		// CASE_HASHTAG_ON_CREATE_FORM rule + the autocomplete filter:
		// on a registration form the case being created doesn't exist
		// at form-init, so `#case/case_id` is the only resolvable
		// reference. Hand-typed `#case/<other>` shows the same inline
		// rejection the doc-layer rule and the autocomplete already
		// agree on — three predicates, one accept set.
		const caseProperties = (() => {
			if (!ctx?.caseProperties) return undefined;
			if (ctx.formType !== "registration") {
				return new Set(ctx.caseProperties.keys());
			}
			return ctx.caseProperties.has("case_id")
				? new Set(["case_id"])
				: new Set<string>();
		})();

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
