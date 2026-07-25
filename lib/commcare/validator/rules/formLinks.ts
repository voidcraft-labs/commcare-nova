/**
 * End-of-form link validation.
 *
 * Links are checked in canonical `(order, uuid)` sequence because that is
 * the sequence the emitted guards are built in: link 2's guard negates
 * link 1's condition, so "which link comes first" is not presentation
 * here, it is semantics.
 *
 * The two rules that only exist because links are EXCLUSIVE:
 *
 *   - a link sitting after an unconditional one can never fire, so it is
 *     refused rather than emitted with an always-false guard;
 *   - a condition that can never match is refused for the same reason a
 *     display condition is: it is dead navigation with nothing an author
 *     could have meant by it. (Unlike the Search action's `match-none`,
 *     which genuinely means "never offer Search".)
 *
 * Everything else here is about what a guard may READ, and that follows
 * from where it runs. The stack `if` evaluates in the session context at
 * end of form, so `casedb` is fully in scope with this submission's
 * writes already applied — relation walks, counts, and presence tests are
 * all available, which is why a link condition is strictly more capable
 * than the same form's display condition. What it CANNOT reach is the
 * submitted form instance: neither runtime puts it in scope, so a
 * condition is written against the case, not against the answers.
 */

import type { BlueprintDoc, Form, FormLink, Uuid } from "@/lib/domain";
import {
	CASE_LOADING_FORM_TYPES,
	isUnconditionalFormLink,
	orderedFormLinks,
} from "@/lib/domain";
import {
	checkPredicate,
	isMatchNone,
	type Predicate,
	simplifyForEmission,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
	walkTerms,
} from "@/lib/domain/predicate";
import { endOfFormCaseAnchor } from "../../suite/endOfForm";
import { type ValidationError, validationError } from "../errors";
import {
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";
import { formatPath, moduleTypeContext } from "./case-list/shared";
import {
	firstPortabilityIssue,
	hasSearchInputReference,
} from "./displayConditions";

export interface FormLinkContext {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly formUuid: Uuid;
	readonly formName: string;
}

/**
 * How an author refers to one link in an error message. The destination
 * is what they picked from a menu, so it is what they will recognize —
 * a position ("link 2") is only a tie-break when two links share one
 * destination.
 */
function linkLabel(
	doc: BlueprintDoc,
	link: ReturnType<typeof orderedFormLinks>[number],
	position: number,
): string {
	const target = link.target;
	const mod = doc.modules[target.moduleUuid];
	if (target.type === "module") {
		return mod === undefined
			? `the ${ordinal(position)} link`
			: `the link to "${mod.name}"`;
	}
	const targetForm = doc.forms[target.formUuid];
	return targetForm === undefined
		? `the ${ordinal(position)} link`
		: `the link to "${targetForm.name}"`;
}

function ordinal(position: number): string {
	const names = ["first", "second", "third", "fourth", "fifth"];
	return names[position - 1] ?? `${position}th`;
}

export function formLinkValidation(
	doc: BlueprintDoc,
	form: Form,
	ctx: FormLinkContext,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	if (form.formLinks === undefined) return [];
	const errors: ValidationError[] = [];
	const loc = {
		moduleUuid: ctx.moduleUuid,
		moduleName: ctx.moduleName,
		formUuid: ctx.formUuid,
		formName: ctx.formName,
	};
	const who = `"${ctx.formName}"`;

	if (form.formLinks.length === 0) {
		errors.push(
			validationError(
				"FORM_LINK_EMPTY",
				"form",
				`${who} is set up to send the user somewhere specific after submitting, but no destination is listed. Add a destination, or remove the setting so the form uses its ordinary After Submit screen.`,
				loc,
			),
		);
		return errors;
	}

	const mod = doc.modules[ctx.moduleUuid];
	const anchor = endOfFormCaseAnchor(form.type, mod?.caseType);
	const typeCtx = moduleTypeContext(mod, doc, lookupTables);
	const ordered = orderedFormLinks(form);

	let unconditionalAt: number | undefined;

	for (let index = 0; index < ordered.length; index++) {
		const link = ordered[index];
		const label = linkLabel(doc, link, index + 1);
		const target = link.target;

		// ── Reachability ─────────────────────────────────────────────
		if (unconditionalAt !== undefined) {
			const covering = linkLabel(
				doc,
				ordered[unconditionalAt],
				unconditionalAt + 1,
			);
			errors.push(
				validationError(
					"FORM_LINK_UNREACHABLE",
					"form",
					`In ${who}, ${label} can never be used, because ${covering} above it has no condition and so always applies. Give ${covering} a condition, or move ${label} above it.`,
					loc,
				),
			);
		} else if (isUnconditionalFormLink(link)) {
			unconditionalAt = index;
		}

		// ── Target ────────────────────────────────────────────────────
		const targetMod = doc.modules[target.moduleUuid];
		if (targetMod === undefined) {
			errors.push(
				validationError(
					"FORM_LINK_TARGET_NOT_FOUND",
					"form",
					`In ${who}, ${label} points at a menu that is no longer in the app. Pick a destination that still exists, or remove the link.`,
					loc,
				),
			);
		} else if (target.type === "form") {
			if (doc.forms[target.formUuid] === undefined) {
				errors.push(
					validationError(
						"FORM_LINK_TARGET_NOT_FOUND",
						"form",
						`In ${who}, ${label} points at a form that is no longer in "${targetMod.name}". Pick a destination that still exists, or remove the link.`,
						loc,
					),
				);
			} else if (
				target.moduleUuid === ctx.moduleUuid &&
				target.formUuid === ctx.formUuid
			) {
				errors.push(
					validationError(
						"FORM_LINK_SELF_REFERENCE",
						"form",
						`In ${who}, ${label} sends the user straight back into this same form, which would loop with no way out. Point it at a different form or at a menu.`,
						loc,
					),
				);
			}
		}

		// ── Condition ─────────────────────────────────────────────────
		errors.push(...conditionErrors(link.condition, label, who, loc, anchor));
		if (link.condition !== undefined) {
			for (const error of semanticCheckErrors(
				checkPredicate(link.condition, typeCtx),
			)) {
				const path = formatPath(error.path);
				errors.push(
					validationError(
						"FORM_LINK_CONDITION_TYPE_ERROR",
						"form",
						`In ${who}, the condition on ${label} does not add up${path ? ` (at ${path})` : ""}: ${error.message}`,
						loc,
						{ path },
					),
				);
			}
			const portability = firstPortabilityIssue(link.condition, typeCtx);
			if (portability !== undefined) {
				errors.push(
					validationError(
						"FORM_LINK_CONDITION_NOT_ON_DEVICE",
						"form",
						`In ${who}, the condition on ${label} ${portability}.`,
						loc,
					),
				);
			}
		}

		// ── Author-supplied datums ────────────────────────────────────
		errors.push(...datumErrors(doc, link, label, who, loc));
	}

	return errors;
}

function conditionErrors(
	condition: Predicate | undefined,
	label: string,
	who: string,
	loc: FormLinkContext & Record<string, unknown>,
	anchor: ReturnType<typeof endOfFormCaseAnchor>,
): ValidationError[] {
	if (condition === undefined) return [];
	const errors: ValidationError[] = [];

	if (isMatchNone(simplifyForEmission(condition))) {
		errors.push(
			validationError(
				"FORM_LINK_CONDITION_ALWAYS_FALSE",
				"form",
				`In ${who}, the condition on ${label} can never be true, so the user would never be sent there. Change the condition, or remove the link.`,
				loc,
			),
		);
	}

	if (hasSearchInputReference(condition)) {
		errors.push(
			validationError(
				"FORM_LINK_CONDITION_SEARCH_INPUT_UNAVAILABLE",
				"form",
				`In ${who}, the condition on ${label} uses a search answer, but the search screen is long gone by the time the form is submitted. Use a case value or a current-user value instead.`,
				loc,
			),
		);
	}

	const unreadable = firstUnreadableCaseTerm(condition, anchor?.caseType);
	if (unreadable !== undefined) {
		errors.push(
			validationError(
				"FORM_LINK_CONDITION_CASE_DATA_UNAVAILABLE",
				"form",
				anchor === undefined
					? `In ${who}, the condition on ${label} reads case information, but this form has no case to read it from. Use a fixed value or a current-user value instead.`
					: `In ${who}, the condition on ${label} reads ${unreadable} information, but the only case available when this form is submitted is the "${anchor.caseType}" it works on. Read a "${anchor.caseType}" value, or a value connected to it.`,
				loc,
			),
		);
	}

	return errors;
}

/**
 * The first case read the guard cannot resolve, named by its case type.
 *
 * With an anchor, every read of the anchored type resolves — including
 * relation walks, counts, and presence tests, all of which the emitter
 * anchors on the concrete session case id. A read STARTING from another
 * case type has nothing to anchor on and would emit a bare relative path
 * against a context node that does not exist there.
 */
function firstUnreadableCaseTerm(
	condition: Predicate,
	anchoredCaseType: string | undefined,
): string | undefined {
	let found: string | undefined;
	walkTerms(condition, (term) => {
		if (found !== undefined || term.kind !== "prop") return;
		if (term.caseType !== anchoredCaseType) found = `"${term.caseType}"`;
	});
	if (found !== undefined) return found;
	if (anchoredCaseType !== undefined) return undefined;
	walkPredicateExpressionNodes(condition, (node) => {
		if (found === undefined && node.kind === "count") found = "case";
	});
	walkPredicateNodes(condition, (node) => {
		if (
			found === undefined &&
			(node.kind === "exists" || node.kind === "missing")
		)
			found = "case";
	});
	return found;
}

/**
 * An author-supplied datum list REPLACES the automatic matching, so it
 * has to cover every selection the destination needs. HQ's own
 * regeneration raises `SuiteValidationError` and fails the entire build
 * when it does not — one bad link taking down the whole app — so the gate
 * refuses the document instead of letting the upload be the discovery
 * mechanism.
 *
 * Checked structurally rather than against derived datums: the only
 * selection Nova's vocabulary can require is the destination's own case,
 * so "does the destination load a case, and did you name it" is the whole
 * question.
 */
function datumErrors(
	doc: BlueprintDoc,
	link: FormLink,
	label: string,
	who: string,
	loc: FormLinkContext & Record<string, unknown>,
): ValidationError[] {
	const datums = link.datums;
	if (datums === undefined || datums.length === 0) return [];
	if (link.target.type !== "form") return [];
	const targetForm = doc.forms[link.target.formUuid];
	const targetMod = doc.modules[link.target.moduleUuid];
	if (targetForm === undefined || targetMod === undefined) return [];
	// Only a case-loading destination requires a selection; a registration
	// or survey destination needs nothing carried in.
	if (!CASE_LOADING_FORM_TYPES.has(targetForm.type)) return [];
	if (targetMod.caseType === undefined) return [];
	if (datums.some((datum) => datum.name === "case_id")) return [];
	return [
		validationError(
			"FORM_LINK_DATUM_INCOMPLETE",
			"form",
			`In ${who}, ${label} sets its own session values but does not say which case "${targetForm.name}" should open. Add a value named "case_id", or remove the custom values so the case is carried over automatically.`,
			loc,
		),
	];
}
