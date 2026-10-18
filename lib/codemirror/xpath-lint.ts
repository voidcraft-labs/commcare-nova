/**
 * CodeMirror lint extension for CommCare XPath expressions.
 *
 * Takes a getter that returns pre-collected context slices (valid paths,
 * case properties, form field entries). The builder's XPath editors derive
 * these directly from the normalized doc so the lint/autocomplete surface
 * stays decoupled from the domain model.
 */

import { type Diagnostic, linter } from "@codemirror/lint";
import type { FormParseResult } from "@/lib/commcare/xpath/expressionAst";
import {
	expressionEditVerdict,
	formLogicFinding,
} from "@/lib/doc/commitVerdicts";
import {
	caseRefAcceptMap,
	type FieldKind,
	type FormType,
	type ReachableCaseTypeIndex,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { spanFor } from "@/lib/domain/expression/spans";
import { checkExpression } from "@/lib/domain/expression/typeChecker";

/**
 * Context snapshot used by the XPath linter and autocomplete sources.
 *
 * Pre-collected at the call site (typically once per XPath editor mount)
 * so the lint / autocomplete runs don't have to walk forms or blueprints
 * themselves. Thinning the interface to just what the CodeMirror plugin
 * reads decouples this directory from the builder's domain model —
 * anything that can produce these three sets is a valid source.
 */
export interface XPathReferenceContext {
	/** Uuid of the form this context describes. Identifies the context's
	 *  scope so caches keyed on it (e.g. `ReferenceProvider`'s form-entry
	 *  cache) rebuild when the active form changes — navigation swaps the
	 *  context without mutating the doc, so an identity key is the only
	 *  signal that the cached form is no longer the current one. */
	formUuid: string;
	/** Valid `/data/...` paths reachable in the current form. Used by lint
	 *  reference checking and data-path autocomplete. */
	validPaths: Set<string>;
	/** The case types this form can READ — its own loaded case (depth 0) plus
	 *  its ancestor chain — each mapped to its `depth` and property metadata.
	 *  Keyed by case-type name so a `#<type>/<prop>` ref resolves to exactly one
	 *  type. `undefined` when the module has no case type (survey-only) — matches
	 *  the linter's "don't check case refs". Child case types are intentionally
	 *  absent: a child case is created fresh and never loaded, so its properties
	 *  are unreadable at runtime (including them was a latent false-accept). */
	reachableCaseTypes: ReachableCaseTypeIndex | undefined;
	/** Value-producing fields in the current form, mapped to their XPath path
	 *  + human label. Used by #form/x autocomplete (label as `detail`). The
	 *  caller filters to value-producing kinds before handing the list in.
	 *  `kind` is narrowed to the domain `FieldKind` union so downstream
	 *  consumers (reference provider, chip rendering) can index
	 *  `fieldRegistry` without a widening cast. */
	formEntries: ReadonlyArray<{
		uuid: Uuid;
		path: string;
		label: string;
		kind: FieldKind;
	}>;
	/** Custom worker information available to identity-aware #user surfaces. */
	userProperties?: ReadonlyArray<Pick<UserProperty, "uuid" | "slug" | "label">>;
	/**
	 * The owning form's type. Drives surfaces that change behavior with
	 * form-creates-case semantics — most notably case-ref autocomplete and
	 * linting on registration forms, where the own case type surfaces only
	 * `case_id` (no other property is resolvable at form-init — the case
	 * doesn't exist in casedb yet) and ancestor types are dropped entirely.
	 * `caseRefAcceptMap` owns that rule so the editor's affordances agree with
	 * the validator's rejection set.
	 */
	formType: FormType;
	/**
	 * Where the expression runs. `"form"` (the default) is a field's slot,
	 * evaluated inside the open form instance. `"session"` is an after-submit
	 * link's condition or carried value, which CommCare evaluates after the
	 * form has closed: form paths and `#form/` references have nothing to
	 * read, so the linter names that (`SESSION_FORM_READ_MESSAGE`) instead
	 * of reporting an unknown field, and autocomplete withholds both.
	 * `buildExpressionLintContext` derives this from the actual slot profile.
	 */
	scope?: "form" | "session";
}

/**
 * Derive the per-type accept structure (`case-type name → property names`) the
 * XPath validator checks `#<type>/<prop>` refs against. Encodes the
 * form-type-narrowing rule in ONE place via `caseRefAcceptMap` so the inline
 * linter (here), `XPathField`'s save gate, and the deep validator never drift.
 * `undefined` when the form has no case type — the validator then skips case-ref
 * checking entirely.
 */
export function caseTypePropsForValidation(
	ctx: XPathReferenceContext,
): Map<string, Set<string>> | undefined {
	if (!ctx.reachableCaseTypes) return undefined;
	return caseRefAcceptMap(
		ctx.reachableCaseTypes,
		ctx.formType,
		ctx.scope ?? "form",
	);
}

/** Editable expressions always carry their actual slot and the matching parser. */
export interface XPathLintContext extends XPathReferenceContext {
	readonly expressionContext: ExpressionContext;
	readonly parse: (source: string) => FormParseResult;
}

export const EXPRESSION_CONTEXT_UNAVAILABLE_MESSAGE =
	"This expression's place in the app changed. Reopen it to use the latest version.";

/** Parser and shared checker diagnostics, placed on the authored source tree. */
export function xpathDiagnostics(
	source: string,
	context: XPathLintContext | undefined,
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
	const parsed = context.parse(source);
	if (!parsed.ok)
		return parsed.issues.map((issue) => ({
			from: issue.from,
			to: issue.to,
			severity: "error",
			message: issue.message,
		}));
	if (parsed.expression === undefined) return [];
	const result = checkExpression(parsed.expression, context.expressionContext);
	if (result.errors.length > 0)
		return result.errors.map((error) => {
			const span = spanFor(parsed.spans, error.path) ?? {
				from: 0,
				to: source.length,
			};
			return {
				from: span.from,
				to: Math.min(span.to, source.length),
				severity: "error",
				message: formLogicFinding(
					error,
					context.expressionContext,
					parsed.expression,
				).message,
			};
		});
	const verdict = expressionEditVerdict(
		parsed.expression,
		context.expressionContext,
	);
	return verdict.ok
		? []
		: [
				{
					from: 0,
					to: source.length,
					severity: "error",
					message: verdict.reason,
				},
			];
}

export function xpathLinter(getContext: () => XPathLintContext | undefined) {
	return linter((view) =>
		xpathDiagnostics(view.state.doc.toString(), getContext()),
	);
}
