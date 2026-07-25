/**
 * End-of-form link projection — the one place a link's guard becomes wire
 * text, for BOTH delivery paths.
 *
 * Nova ships a form two ways, and until now they disagreed about links.
 * The local `.ccz` emitted one `<create if="Ci">` per link straight from
 * the authored condition; the HQ upload emitted `post_form_workflow` set
 * to the post-submit destination, which makes
 * `workflow.py::EndOfFormNavigationWorkflow.form_workflow_frames` return
 * the static frame and IGNORE `form_links` entirely. The same document
 * therefore linked on device and did not link at all after an HQ import —
 * silently, on the primary delivery path.
 *
 * Both paths now read this module. That works because HQ re-emits a
 * link's `xpath` verbatim (no `interpolate_xpath` anywhere in
 * `workflow.py`), so one guard string is correct in both suites. HQ then
 * derives its own fallback guard by negating the guards it was given;
 * since the exclusive guards partition the authored conditions
 * (⋁Gi ≡ ⋁Ci), its `¬G1 ∧ … ∧ ¬Gn` is the same condition as the
 * `¬C1 ∧ … ∧ ¬Cn` this module hands the local emitter.
 *
 * ## What a guard may read
 *
 * The stack `if` is evaluated in the SESSION evaluation context
 * (`formplayer .../services/MenuSessionRunnerService.java::executeAndRebuildSession`
 * takes `getEvaluationContext()`; `commcare-android
 * .../models/AndroidSessionWrapper.java::terminateSession` does the same
 * and nulls its initializer first so `casedb` is re-read). Two
 * consequences shape the whole design:
 *
 *   - the case's own writes from THIS submission are already visible, so
 *     "did they answer yes" is authored as "does the case now say yes";
 *   - the submitted form instance is NOT in scope on either runtime, so a
 *     guard can never read `/data/...` directly.
 *
 * The anchor differs by form type. A case-loading form reads the case it
 * loaded (`case_id`); a registration form reads the case it just created,
 * whose id the entry minted into `case_id_new_<type>_0`. Both are
 * concrete session variables, which is why relation walks and counts are
 * available here even though a case-list-screen display condition cannot
 * offer them.
 */

import { emitCaseListFilter } from "@/lib/commcare/predicate";
import { ROOT_ON_DEVICE_CASE_ANCHOR } from "@/lib/commcare/predicate/relationPresenceEmitter";
import {
	newCaseSessionId,
	SESSION_CASE_ID,
	sessionCaseAnchorBindings,
} from "@/lib/commcare/predicate/sessionCaseAnchor";
import type {
	BlueprintDoc,
	Form,
	FormType,
	PostSubmitDestination,
	Uuid,
} from "@/lib/domain";
import {
	CASE_LOADING_FORM_TYPES,
	defaultPostSubmit,
	printXPath,
	projectFormLinks,
	xpathPrintContext,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { XPathExpression } from "@/lib/domain/xpath";
import { validateCaseType } from "../identifierValidation";
import type { LookupWireNaming } from "../lookup/naming";
import type { HqFormLink } from "../types";

/**
 * The session case an end-of-form guard reads, or `undefined` when the
 * form has none. A survey form, or any form in a module with no case
 * type, gets no anchor and the validator refuses case reads there.
 */
export interface EndOfFormCaseAnchor {
	readonly caseIdExpression: string;
	readonly caseType: string;
}

export function endOfFormCaseAnchor(
	formType: FormType,
	moduleCaseType: string | undefined,
): EndOfFormCaseAnchor | undefined {
	if (moduleCaseType === undefined || moduleCaseType.length === 0) {
		return undefined;
	}
	if (CASE_LOADING_FORM_TYPES.has(formType)) {
		return { caseIdExpression: SESSION_CASE_ID, caseType: moduleCaseType };
	}
	if (formType === "registration") {
		return {
			caseIdExpression: newCaseSessionId(validateCaseType(moduleCaseType)),
			caseType: moduleCaseType,
		};
	}
	return undefined;
}

/**
 * Lower one guard to the wire.
 *
 * Absent in, absent out: an unconditional link emits NO `if` attribute.
 * That distinction is load-bearing rather than cosmetic —
 * `commcare-core .../xml/StackOpParser.java` hands the raw attribute to
 * `StackOperation`, whose constructor parses any non-null value, and
 * `XPathParseTool.parseXPath("")` throws, so `if=""` fails the whole
 * suite parse rather than the one frame.
 */
export function emitEndOfFormGuard(
	guard: Predicate | undefined,
	anchor: EndOfFormCaseAnchor | undefined,
	lookupNaming?: LookupWireNaming,
): string | undefined {
	if (guard === undefined) return undefined;
	return emitCaseListFilter(
		guard,
		"casedb",
		{ ...(anchor !== undefined && { currentCaseType: anchor.caseType }) },
		ROOT_ON_DEVICE_CASE_ANCHOR,
		{
			...(anchor !== undefined &&
				sessionCaseAnchorBindings(anchor.caseIdExpression, anchor.caseType)),
			...(lookupNaming !== undefined && { lookup: { naming: lookupNaming } }),
		},
	);
}

/** The complete end-of-form navigation both delivery paths emit. */
export interface EndOfFormWireProjection {
	/** Links in canonical order, each carrying its exclusive guard. */
	readonly links: HqFormLink[];
	/**
	 * Where to go when no guard holds, or `undefined` when nothing falls
	 * back — either a terminal unconditional link already covers every
	 * case, or there is no conditional link to complement.
	 */
	readonly fallback:
		| { readonly guard: string; readonly destination: PostSubmitDestination }
		| undefined;
	/**
	 * The same guards as typed ASTs. The local suite entry declares the
	 * instances a guard reads, and answering "which instances" from the
	 * emitted string would mean parsing it back.
	 */
	readonly guardPredicates: readonly Predicate[];
}

/**
 * Resolve a form's links to wire shape: guards emitted, targets resolved
 * from uuids to the 0-based menu indices HQ addresses by.
 *
 * A link whose target uuid does not resolve is DROPPED rather than
 * emitted against a wrong index. `FORM_LINK_TARGET_NOT_FOUND` refuses
 * that document long before any production export, so dropping is what
 * keeps this a total function for the validation loop's own compile.
 */
export function projectFormLinksForWire(
	doc: BlueprintDoc,
	form: Form,
	moduleCaseType: string | undefined,
	sortedModuleUuids: readonly Uuid[],
	sortedFormOrder: Readonly<Record<string, readonly Uuid[]>>,
	lookupNaming?: LookupWireNaming,
): EndOfFormWireProjection {
	const anchor = endOfFormCaseAnchor(form.type, moduleCaseType);
	const projection = projectFormLinks(form);
	const links: HqFormLink[] = [];
	const guardPredicates: Predicate[] = [];

	for (const projected of projection.links) {
		const target = projected.link.target;
		if (projected.guard !== undefined) guardPredicates.push(projected.guard);
		const moduleIndex = sortedModuleUuids.indexOf(target.moduleUuid);
		if (moduleIndex < 0) continue;
		const guard = emitEndOfFormGuard(projected.guard, anchor, lookupNaming);
		const datums = projected.link.datums?.map((datum) => ({
			name: datum.name,
			xpath: printFormLinkDatum(doc, datum.xpath),
		}));
		if (target.type === "form") {
			const formIndex = (sortedFormOrder[target.moduleUuid] ?? []).indexOf(
				target.formUuid,
			);
			if (formIndex < 0) continue;
			links.push({
				...(guard !== undefined && { condition: guard }),
				target: { type: "form", moduleIndex, formIndex },
				...(datums !== undefined && { datums }),
			});
			continue;
		}
		links.push({
			...(guard !== undefined && { condition: guard }),
			target: { type: "module", moduleIndex },
			...(datums !== undefined && { datums }),
		});
	}

	const fallbackGuard = emitEndOfFormGuard(
		projection.fallbackGuard,
		anchor,
		lookupNaming,
	);
	return {
		links,
		fallback:
			fallbackGuard === undefined
				? undefined
				: {
						guard: fallbackGuard,
						destination: form.postSubmit ?? defaultPostSubmit(form.type),
					},
		guardPredicates,
	};
}

/**
 * A link datum's override stays authored XPath rather than a Predicate:
 * it names a session variable to carry forward, which is a statement
 * about the session and not a description of a case, so the typed
 * vocabulary has nothing to say about it.
 */
function printFormLinkDatum(doc: BlueprintDoc, xpath: XPathExpression): string {
	return printXPath(xpath, xpathPrintContext(doc));
}
