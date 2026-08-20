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
import { parser } from "@/lib/commcare/xpath";
import {
	caseRefAcceptMap,
	type FieldKind,
	type FormType,
	type ReachableCaseTypeIndex,
	type UserProperty,
	type Uuid,
} from "@/lib/domain";

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
	 * `buildSessionLintContext` is the one producer of `"session"`.
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
	ctx: XPathLintContext,
): Map<string, Set<string>> | undefined {
	if (!ctx.reachableCaseTypes) return undefined;
	return caseRefAcceptMap(ctx.reachableCaseTypes, ctx.formType);
}

/**
 * What a session-scoped slot says about a form read. The deep validator
 * refuses the same reference (`FORM_LINK` slots, form-local references);
 * this is the author-facing form of that rule, shown while typing.
 */
export const SESSION_FORM_READ_MESSAGE =
	"This runs after the form has closed, so it can't read the form's answers. Save the answer to a case property and read that instead.";

/** Pre-resolved node type for typed comparisons (never by name at runtime). */
const HASHTAG_REF = (() => {
	const found = parser.nodeSet.types.find((t) => t.name === "HashtagRef");
	if (!found) throw new Error("Unknown node type: HashtagRef");
	return found;
})();

/** The span of every `#form/…` reference, read off the syntax tree. */
function formHashtagSpans(
	expr: string,
): ReadonlyArray<{ readonly from: number; readonly to: number }> {
	const spans: Array<{ from: number; to: number }> = [];
	parser.parse(expr).iterate({
		enter(node) {
			if (node.type !== HASHTAG_REF) return;
			const text = expr.slice(node.from, node.to);
			const slashIdx = text.indexOf("/");
			const namespace = slashIdx >= 0 ? text.slice(1, slashIdx) : text.slice(1);
			if (namespace === "form") spans.push({ from: node.from, to: node.to });
		},
	});
	return spans;
}

/**
 * The diagnostics for one expression against one context — the pure heart
 * of `xpathLinter`, exported so the session-scope rewrite is testable
 * without an editor view.
 */
export function xpathDiagnostics(
	expr: string,
	ctx: XPathLintContext | undefined,
): Diagnostic[] {
	if (!expr.trim()) return [];

	// The per-type accept set comes from `caseTypePropsForValidation`, the
	// single home of the registration-narrowing rule. On a registration form
	// it narrows to the own type's `case_id` only (the case being created
	// doesn't exist at form-init, ancestor reads aren't permitted on a create
	// form); every other form type exposes each reachable type's full
	// property set. The linter, the save gate, and the deep validator all
	// read that one rule — three predicates, one accept set.
	const caseTypeProps = ctx ? caseTypePropsForValidation(ctx) : undefined;
	const session = ctx?.scope === "session";

	const errors = validateXPath(
		expr,
		ctx?.validPaths,
		caseTypeProps,
		ctx?.formType === "registration",
	);
	const diagnostics: Diagnostic[] = [];

	for (const err of errors) {
		/* Under session scope every `/data/…` path is unknown by construction
		 * (the context carries none), so the finding is about WHERE the
		 * expression runs, not about a misspelt field. */
		const formRead =
			session && err.code === "INVALID_REF" && err.ref?.startsWith("/data/");
		const from =
			err.position ??
			(formRead && err.ref !== undefined
				? Math.max(0, expr.indexOf(err.ref))
				: 0);
		const to = Math.min(
			formRead && err.ref !== undefined ? from + err.ref.length : from + 1,
			expr.length,
		);
		diagnostics.push({
			from,
			to,
			severity: "error",
			message: formRead ? SESSION_FORM_READ_MESSAGE : err.message,
		});
	}

	/* `validateXPath` leaves `#form/` to the wire (it resolves there on a
	 * field slot), so a session slot has to name the read itself. */
	if (session) {
		for (const span of formHashtagSpans(expr)) {
			diagnostics.push({
				from: span.from,
				to: span.to,
				severity: "error",
				message: SESSION_FORM_READ_MESSAGE,
			});
		}
	}

	/* The validator resolves `#form/x` to its `/data/x` path before checking
	 * it, so a session slot can reach the same finding twice: once through
	 * the path, once through the hashtag. One sentence per place. */
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.from}:${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Create a CodeMirror lint extension that validates against the live context. */
export function xpathLinter(getContext: () => XPathLintContext | undefined) {
	return linter((view) =>
		xpathDiagnostics(view.state.doc.toString(), getContext()),
	);
}
