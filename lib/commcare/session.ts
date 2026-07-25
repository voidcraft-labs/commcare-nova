/**
 * CommCare suite-entry derivation.
 *
 * Derives the per-form `<entry>` block compiled into `suite.xml`: the form
 * command + locale, any session datums the entry needs (currently the
 * single `case_id` for case-loading forms), and the post-submit `<stack>`
 * operations that decide where the user lands after `<submit/>`. Also
 * owns the post-submit destination ↔ HQ-workflow string mapping that
 * round-trips between the in-memory enum and the wire vocabulary HQ
 * expects.
 *
 * CommCare Core defines three stack-operation kinds — `<create>`,
 * `<push>`, `<clear>`. All three are typed for completeness; only
 * `<create>` is emitted. Simple post-submit destinations produce one
 * unconditional `<create>`; form-link-enabled forms produce one
 * `<create if="...">` per link plus a fallback `<create if="not(c1) and
 * not(c2)...">` that runs the `postSubmit` destination when no link
 * condition matches.
 *
 * `<entry>` and `<stack>` are CONSTRUCTED as `domhandler` element trees
 * (`buildEntryElement`, `buildStackElement`) and serialized once by the
 * caller. There is NO template-literal XML in this module: every
 * attribute value flows through `setAttribute` (the `attribs` object
 * literal); the serializer is the single, exclusive escaping authority.
 * Hand-escaping is intentionally absent — double-encoding (`&` →
 * `&amp;` → `&amp;amp;`) is the failure mode it would introduce.
 *
 * `renderEntryXml` / `renderStackXml` exist alongside the Element
 * builders as one-line serialization adapters for callers that consume
 * the rendered string (the surrounding test surface; `compileCcz`
 * itself calls `buildEntryElement` directly and splices the Element
 * into the suite tree).
 */

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS, text } from "@/lib/commcare/elementBuilders";
import type { FormType, PostSubmitDestination } from "@/lib/domain";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import {
	effectiveDisplayConditionForEmission,
	predicateReadsCaseData,
	substituteUnansweredSearchInputsInExpression,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import type { RelationEvaluationScopeContext } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import { validateCaseType } from "./identifierValidation";
import type { LookupWireNaming } from "./lookup/naming";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "./predicate";
import {
	emitExcludedOwnerNodesetFilter,
	emitNodesetFilter,
} from "./suite/case-list/nodesetFilter";
import {
	type FrameChild,
	frameChildrenForForm,
	frameChildrenForModule,
	frameDatumValue,
	frameForPostSubmit,
	matchFrameChildrenToManualValues,
	matchFrameChildrenToSource,
	type NavigationDatum,
	type NavigationFrame,
	type NavigationModule,
} from "./suite/navigation";
import type { FormActions, HqFormLink } from "./types";

// ── Session Datums ─────────────────────────────────────────────────────

/**
 * A datum required by a form entry's `<session>` block.
 *
 * Two shapes share this struct because CCHQ emits both as
 * `<datum>` elements in the same `<session>` block:
 *
 *   - **Nodeset datum** — case-loading forms (followup / close). Carries
 *     `nodeset` + `value` (the user picks a case from a list rendered
 *     against `nodeset`; `value="./@case_id"` extracts the chosen id).
 *     `instanceId` + `instanceSrc` declare which jr:// instance the
 *     nodeset reads from (typically `casedb`).
 *   - **Function datum** — case-creating forms (registration / subcase).
 *     Carries `function` (typically `uuid()`), which CommCare evaluates
 *     once at entry to mint a fresh id for the case the form will
 *     create. No nodeset, no value, no instance dependency.
 *
 * Mutually exclusive on the wire: a datum is one shape or the other.
 * The renderer (`renderEntryXml`) branches on whether `function` is set.
 */
export interface SessionDatum {
	id: string;
	/** Instance the nodeset reads from. Required for nodeset datums; omitted for function datums. */
	instanceId?: string;
	instanceSrc?: string;
	/** Required for nodeset datums; omitted for function datums. */
	nodeset?: string;
	/** Required for nodeset datums; omitted for function datums. */
	value?: string;
	/**
	 * The XPath function CommCare evaluates once at entry. Set for
	 * function datums (case-create's `uuid()`); omitted for nodeset
	 * datums. Sourced from CCHQ's `EntriesHelper.get_new_case_id_datums_meta`.
	 */
	function?: string;
	detailSelect?: string;
	detailConfirm?: string;
	autoselect?: boolean;
}

/** A secondary instance required by a form entry. */
export interface EntryInstance {
	id: string;
	src: string;
}

// ── Stack Operations ───────────────────────────────────────────────────
//
// CommCare Core (StackOperation.java) defines three operation types.
// After form submission, CommCare evaluates operations top-to-bottom:
//
//   1. Each operation's `if` condition is checked (null = always trigger).
//   2. For <create>: a new frame is pushed onto the stack.
//   3. For <push>: steps are added to the current frame.
//   4. For <clear>: frames are removed from the stack.
//   5. If a rewind occurs during <create>/<push>, remaining ops are SKIPPED.
//   6. Multiple <create> ops that all match ALL execute (not mutually exclusive).
//      They're popped in LIFO order during session resolution.
//
// Key difference between no <stack> and empty <create/>:
//   - No <stack>: form frame is popped, user returns to previous level
//   - <create/>: empty frame pushed, resolves to home (no command = no entry)
//   - <clear/>: stack is wiped, session ends, user goes home

/** A child element of a <create> or <push> operation. */
export type StackChild =
	| { type: "command"; value: string }
	| { type: "datum"; id: string; value: string };

/**
 * A single stack operation in suite.xml.
 *
 * Maps directly to CommCare Core's StackOperation class:
 *   OPERATION_CREATE (0) → op: 'create'
 *   OPERATION_PUSH (1)   → op: 'push'
 *   OPERATION_CLEAR (2)  → op: 'clear'
 */
export interface StackOperation {
	/** The operation type. */
	op: "create" | "push" | "clear";
	/** XPath condition — operation executes only when this is true. Omit = always. */
	ifClause?: string;
	/** Commands and datums. Must be empty for 'clear' operations. */
	children: StackChild[];
}

// ── Entry Definition ───────────────────────────────────────────────────

/**
 * Complete entry definition for an `<entry>` in suite.xml.
 *
 * Two entry shapes share this struct because CCHQ renders both as
 * top-level `<entry>` blocks the runtime dispatches through:
 *
 *   - **Form entry** — carries `formXmlns`, so `buildEntryElement`
 *     emits a `<form>` child naming the XForm the entry launches.
 *     Built by `deriveEntryDefinition`.
 *   - **Case-list-browse entry** — the `caseListOnly` module's
 *     standalone case-list command (CCHQ's `case_list.show=true`
 *     block at `entries.py`'s `if module.case_list.show:`). It loads
 *     a case into the case-list/-detail screens but launches no form,
 *     so `formXmlns` is omitted and `buildEntryElement` skips the
 *     `<form>` child. Built by `deriveCaseListEntryDefinition`.
 *
 * `formXmlns` is the sole discriminator between the two on the wire —
 * everything else (command, locale, instances, session datum) is
 * structurally identical.
 */
export interface EntryDefinition {
	/** The XForm xmlns the entry launches. Omitted for the case-list-browse entry, which loads a case but launches no form. */
	formXmlns?: string;
	commandId: string;
	localeId: string;
	instances: EntryInstance[];
	session?: { datums: SessionDatum[] };
	stack?: { operations: StackOperation[] };
}

// ── Derivation Functions ───────────────────────────────────────────────

const _SESSION_REF = "instance('commcaresession')/session/data";

/**
 * Build the case-loading datum's nodeset:
 * `instance('casedb')/casedb/case[@case_type='<type>'][@status='open']<filterFragment>`.
 *
 * The single source for this string across both case-loading entry
 * shapes — the form entry's `case_id` datum
 * (`deriveSessionDatums`) and the `caseListOnly` browse entry's
 * `case_id` datum (`deriveCaseListEntryDefinition`). Keeping it in one
 * place stops the two from drifting on the `[@case_type][@status]`
 * predicate order or the availability-filter append rule.
 *
 * Filter precedence (case-type / status first, list rule then owner exclusion)
 * matches CCHQ's canonical builder at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.
 */
function caseLoadingNodeset(
	caseType: string,
	caseListFilter: Predicate | undefined,
	excludedOwnerIds: ValueExpression | undefined,
	relationContext: RelationEvaluationScopeContext = {},
	lookupNaming?: LookupWireNaming,
): string {
	const filterFragment = emitNodesetFilter(
		caseListFilter,
		relationContext,
		lookupNaming,
	);
	const ownerFragment = emitExcludedOwnerNodesetFilter(
		excludedOwnerIds,
		relationContext,
		lookupNaming,
	);
	return `instance('casedb')/casedb/case[@case_type='${validateCaseType(caseType)}'][@status='open']${filterFragment}${ownerFragment}`;
}

/**
 * Accumulate the `<instance>` declarations a case-loading entry's body
 * holds, into `instances` (deduped via `seen`). Both case-loading entry
 * shapes — the form entry (`deriveEntryDefinition`) and the
 * `caseListOnly` browse entry (`deriveCaseListEntryDefinition`) — load
 * the same `m{N}_case_short` / `m{N}_case_long` details and reference the
 * same XPath surfaces, so they share this accumulation rather than
 * duplicating it.
 *
 * CCHQ's server-side suite post-process
 * (`commcare-hq/.../suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`)
 * walks every detail an entry references and adds the matching
 * `<instance>` declarations on the regenerated suite. Nova's local
 * `.ccz` emission has no equivalent post-pass, so this walks every
 * XPath surface the entry's body reaches:
 *
 *   - the case-list `filter` predicate and owner-exclusion expression (both
 *     live inside the case-loading datum's nodeset);
 *   - the `searchButtonDisplayCondition` predicate (lowers to the
 *     `<action relevant>` on the case-list detail's search-action
 *     element, evaluated in this entry's context);
 *   - each calculated expression actually emitted on Results/Details (or
 *     retained as an off-screen Results sort carrier).
 *
 * Accumulation ORDER is observable on the wire — list-filter instances,
 * owner-expression instances, then display-condition instances before
 * calc-column instances. The
 * caller seeds `casedb` from the datum first so the final order is
 * casedb → predicate instances → calc-column instances, matching the
 * form-entry shape byte-for-byte.
 */
function accumulateCaseLoadingInstances(
	caseListFilter: Predicate | undefined,
	excludedOwnerIds: ValueExpression | undefined,
	searchButtonDisplayCondition: Predicate | undefined,
	formDisplayCondition: Predicate | undefined,
	caseListColumnExpressions: readonly ValueExpression[] | undefined,
	instances: EntryInstance[],
	seen: Set<string>,
	lookupNaming?: LookupWireNaming,
): void {
	// Predicate-derived instances. Every predicate whose XPath fragment
	// lives inside an `<entry>`-scoped slot contributes its instance set
	// — the case-list filter (inside the datum's nodeset) and the
	// search-button display condition (on the detail's `<action relevant>`,
	// evaluated against the enclosing entry's instances). The Term-kind →
	// instance-id mapping is fixed in `instanceSourceFor`.
	//
	// The filter and owner-exclusion slots collect from the SAME
	// unanswered-Search substitution `nodesetFilter.ts` emits from, so a
	// Search-input ref never declares `search-input:results` on an entry
	// that would leave the instance unloaded (a declared-but-unloaded
	// instance is itself a runtime throw in Core's `XPathPathExpr.evalRaw`
	// the moment anything references it).
	if (caseListFilter !== undefined) {
		const unanswered =
			substituteUnansweredSearchInputsInPredicate(caseListFilter);
		for (const id of collectPredicateInstances(unanswered, lookupNaming)) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id) });
		}
	}

	// Owner exclusion is a scalar expression embedded in the same datum
	// nodeset as the always-on filter. It can reach session or relation
	// instances, so collect its dependencies before detail-level
	// display/calculated expressions in wire order.
	if (excludedOwnerIds !== undefined) {
		const unanswered =
			substituteUnansweredSearchInputsInExpression(excludedOwnerIds);
		for (const id of collectExpressionInstances(unanswered, lookupNaming)) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id) });
		}
	}

	if (searchButtonDisplayCondition !== undefined) {
		for (const id of collectPredicateInstances(
			searchButtonDisplayCondition,
			lookupNaming,
		)) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id) });
		}
	}

	// A form command's relevant expression is evaluated in the matching
	// entry's instance scope. Deep all-true conditions vanish from the wire,
	// so collect only the exact predicate that emission retains. A selected-
	// case property structurally emits through BOTH casedb and
	// commcaresession (the latter supplies session/data/case_id); the generic
	// AST collector sees the property but cannot see that injected anchor.
	const effectiveFormCondition =
		effectiveDisplayConditionForEmission(formDisplayCondition);
	if (effectiveFormCondition !== undefined) {
		const ids = collectPredicateInstances(effectiveFormCondition, lookupNaming);
		if (predicateReadsCaseData(effectiveFormCondition)) {
			ids.add("casedb");
			ids.add("commcaresession");
		}
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id) });
		}
	}

	// Calc-column expressions land on `m{N}_case_short` / `m{N}_case_long`.
	// CCHQ resolves the detail's XPath against the enclosing entry's
	// declarations — accumulate every instance the expression reaches so
	// the local `.ccz` carries the same declarations CCHQ's server-side
	// post-process would add on a regenerated suite.
	if (caseListColumnExpressions !== undefined) {
		for (const expression of caseListColumnExpressions) {
			for (const id of collectExpressionInstances(expression, lookupNaming)) {
				if (seen.has(id)) continue;
				seen.add(id);
				instances.push({ id, src: instanceSourceFor(id) });
			}
		}
	}
}

/**
 * Derive session datums required by a form entry.
 *
 * Emits up to one of each kind, in this order:
 *
 *   1. The `case_id` nodeset datum for case-loading forms (followup,
 *      close). Lets the user pick a case from the case list; `value`
 *      extracts the chosen id.
 *   2. A `case_id_new_<casetype>_0` function datum for case-create
 *      forms (registration). CommCare evaluates `uuid()` once at entry
 *      to mint a fresh id for the case the form will create.
 *   3. One `case_id_new_<subcasetype>_<idx>` function datum per active
 *      subcase action with no `repeat_context` (subcases in a repeat
 *      get their id minted per-iteration via a calculate bind rather
 *      than a session datum — handled by the XForm emitter).
 *
 * Index rule for subcases mirrors CCHQ's
 * `commcare-hq/corehq/apps/app_manager/models.py::Form.session_var_for_action`:
 * the index is the subcase's position in `actions.subcases`, plus 1
 * when the form also has an active `open_case` (so the primary
 * case-create is always `_0`).
 *
 * The optional `caseListFilter` is the module's
 * `caseListConfig.filter` predicate; when present, the wire layer
 * appends its bracketed XPath fragment to the nodeset after the
 * `[@case_type][@status]` predicates, narrowing the case set the
 * runtime selects from. Filter precedence (case-type / status
 * first, user filter last) matches CCHQ's canonical builder at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.
 *
 * `actions` is the form's `FormActions` (post-expansion). The function
 * inspects `actions.open_case.condition` and `actions.subcases` to
 * decide which case-create datums to emit. When `actions` is
 * undefined, only the case-loading datum is emitted — callers that
 * don't carry an expanded `FormActions` get the case-loading-only
 * shape.
 */
/**
 * One entry datum with the navigation metadata the wire shape omits.
 *
 * CommCare's own suite carries neither the datum's case type nor whether
 * the worker picks it, so HQ recovers both by regex over the emitted
 * nodeset (`WorkflowDatumMeta.case_type`) and by patching in what the form
 * knows (`WorkflowHelper._add_missing_case_types`). Nova already holds
 * both facts at derivation, so it keeps them beside the datum instead of
 * re-reading them out of a string — the same reason every expression slot
 * stores an AST rather than text.
 *
 * Deriving the pair together is what stops the wire datum and the
 * navigation datum from drifting: a form's entry and every frame that
 * navigates to it read one list.
 */
export interface FormDatumMeta {
	readonly datum: SessionDatum;
	readonly navigation: NavigationDatum;
}

export function deriveFormDatums(
	formType: FormType,
	moduleIndex: number,
	caseType?: string,
	caseListFilter?: Predicate,
	actions?: FormActions,
	excludedOwnerIds?: ValueExpression,
	relationContext: RelationEvaluationScopeContext = {},
	lookupNaming?: LookupWireNaming,
): FormDatumMeta[] {
	const datums: FormDatumMeta[] = [];

	// (1) Case-loading datum for followup / close.
	if (CASE_LOADING_FORM_TYPES.has(formType) && caseType) {
		datums.push({
			datum: {
				id: "case_id",
				instanceId: "casedb",
				instanceSrc: "jr://instance/casedb",
				nodeset: caseLoadingNodeset(
					caseType,
					caseListFilter,
					excludedOwnerIds,
					relationContext,
					lookupNaming,
				),
				value: "./@case_id",
				detailSelect: `m${moduleIndex}_case_short`,
			},
			navigation: { id: "case_id", caseType, requiresSelection: true },
		});
	}

	if (!actions) return datums;

	// (2) Case-create datum for an active `open_case` action. CCHQ
	// emits this whenever `'open_case' in form.active_actions()`, which
	// in Nova's FormActions shape is condition.type in {always, if}.
	const opensCase =
		actions.open_case.condition.type === "always" ||
		actions.open_case.condition.type === "if";
	const opensSubcaseIndexOffset = opensCase ? 1 : 0;
	if (opensCase && caseType) {
		const id = `case_id_new_${validateCaseType(caseType)}_0`;
		datums.push({
			datum: { id, function: "uuid()" },
			// The case type is what lets a link from this form carry the case it
			// just created into a follow-up: the target's `case_id` matches this
			// datum on type, not on name.
			navigation: {
				id,
				caseType,
				requiresSelection: false,
				function: "uuid()",
			},
		});
	}

	// (3) Per-subcase datums. Skip subcases whose action is inactive or
	// that live in a repeat — CCHQ also skips repeat-context subcases
	// for session emission and uses a per-iteration calculate bind on
	// the form side. The wire-layer datum index counts ALL active
	// subcases (including any repeat-context ones), then this function
	// only EMITS for the non-repeat-context ones — matching the
	// `Form.session_var_for_action` numbering at the CCHQ side.
	for (let i = 0; i < actions.subcases.length; i++) {
		const sc = actions.subcases[i];
		if (sc.condition.type !== "always" && sc.condition.type !== "if") {
			continue;
		}
		if (sc.repeat_context) continue;
		const id = `case_id_new_${validateCaseType(sc.case_type)}_${i + opensSubcaseIndexOffset}`;
		datums.push({
			datum: { id, function: "uuid()" },
			navigation: {
				id,
				caseType: sc.case_type,
				requiresSelection: false,
				function: "uuid()",
			},
		});
	}

	return datums;
}

/** The wire-facing projection of `deriveFormDatums` — the `<session>` block. */
export function deriveSessionDatums(
	formType: FormType,
	moduleIndex: number,
	caseType?: string,
	caseListFilter?: Predicate,
	actions?: FormActions,
	excludedOwnerIds?: ValueExpression,
	relationContext: RelationEvaluationScopeContext = {},
	lookupNaming?: LookupWireNaming,
): SessionDatum[] {
	return deriveFormDatums(
		formType,
		moduleIndex,
		caseType,
		caseListFilter,
		actions,
		excludedOwnerIds,
		relationContext,
		lookupNaming,
	).map((meta) => meta.datum);
}

/** Lower one navigation frame's steps to `<create>` children. */
function frameStackChildren(children: readonly FrameChild[]): StackChild[] {
	return children.map((child) =>
		child.kind === "command"
			? { type: "command", value: `'${child.commandId}'` }
			: { type: "datum", id: child.datum.id, value: frameDatumValue(child) },
	);
}

/**
 * Lower a navigation frame to a stack operation, or nothing when the
 * frame has no steps and no reason to exist.
 *
 * The empty-frame rule is HQ's `StackFrameMeta.to_frame`: a childless
 * frame is dropped unless `allow_empty_frame` is set, which only the
 * `root` workflow sets. The distinction is real on the wire — an empty
 * `<create/>` pushes a frame with no command and resolves to the app
 * home, while emitting nothing leaves the runtime's own end-of-form
 * return in charge.
 */
function frameOperation(
	frame: NavigationFrame | undefined,
	guard: string | undefined,
): StackOperation | undefined {
	if (frame === undefined) return undefined;
	if (frame.children.length === 0 && !frame.allowEmpty) return undefined;
	return {
		op: "create",
		...(guard !== undefined && guard.length > 0 && { ifClause: guard }),
		children: frameStackChildren(frame.children),
	};
}

/**
 * The `<stack>` for a form with no links: one frame for its post-submit
 * destination, or none at all.
 *
 * `app_home` deliberately produces NO operation. HQ's
 * `_get_static_stack_frame` has no `WORKFLOW_DEFAULT` arm, so an HQ build
 * emits no `<stack>` and the runtime's built-in return applies. Nova used
 * to emit an empty `<create/>` in the fallback position, which reaches
 * the same screen by a different mechanism and made the two delivery
 * paths differ for one document.
 */
export function derivePostSubmitStack(
	postSubmit: PostSubmitDestination,
	mod: NavigationModule,
	formIndex: number,
): StackOperation[] {
	const operation = frameOperation(
		frameForPostSubmit(postSubmit, mod, formIndex),
		undefined,
	);
	return operation === undefined ? [] : [operation];
}

/** The fallback frame a link-bearing form falls through to, if any. */
export interface FormLinkFallback {
	readonly guard: string;
	readonly destination: PostSubmitDestination;
}

/**
 * Everything an entry needs to emit end-of-form navigation, gathered into
 * one slot rather than three more positional parameters.
 *
 * `navigation` is the whole app's frame vocabulary, because a link may
 * target any module — including one the compiler has not reached yet.
 * `linkGuardPredicates` are the guards as typed ASTs, kept beside their
 * emitted text so the entry can declare the instances they read; the
 * emitted strings alone would need re-parsing to answer that.
 */
export interface EndOfFormEntryContext {
	readonly navigation?: NavigationContext;
	readonly fallback?: FormLinkFallback;
	readonly linkGuardPredicates?: readonly Predicate[];
}

/** Every module's frame vocabulary, indexed by emitted menu position. */
export interface NavigationContext {
	readonly modules: readonly NavigationModule[];
}

/**
 * The `<stack>` for a form that carries end-of-form links.
 *
 * One frame per link, each guarded by the EXCLUSIVE condition
 * `lib/domain/formLinkProjection.ts` derived, then the fallback frame
 * when one is still reachable. Those guards arrive pre-emitted, from the
 * same projection the HQ JSON carries — that sharing is the whole point,
 * because the guard is the only thing standing between "the first
 * matching link wins" and the runtime's actual behavior of pushing every
 * matching frame and popping them in reverse.
 *
 * Each frame carries the target's DATUMS, not only its commands. A frame
 * is replayed step by step and stops at the first datum it still needs,
 * so a command-only frame drops the worker on the target's case list to
 * re-pick the case he was already working; matching the target's datums
 * against this form's session variables is what carries it forward.
 */
export function deriveFormLinkStack(
	links: readonly HqFormLink[],
	fallback: FormLinkFallback | undefined,
	targetModules: readonly NavigationModule[],
	sourceModule: NavigationModule,
	sourceFormIndex: number,
	sourceDatums: readonly NavigationDatum[],
): StackOperation[] {
	const ops: StackOperation[] = [];

	for (const link of links) {
		const mod = targetModules[link.target.moduleIndex];
		if (mod === undefined) continue;
		const children =
			link.target.type === "form"
				? frameChildrenForForm(mod, link.target.formIndex)
				: frameChildrenForModule(mod, { includeUserSelections: false });
		/* An author-supplied datum list replaces source matching entirely,
		 * exactly as `_get_datums_matched_to_manual_values` does. A list that
		 * leaves a required selection uncovered is refused at the commit gate
		 * (`FORM_LINK_DATUM_INCOMPLETE`) because HQ's regeneration raises and
		 * fails the whole build; skipping it keeps this emitter total for the
		 * validation loop's own compile. */
		let resolved: readonly FrameChild[] | undefined;
		if (link.datums === undefined) {
			resolved = matchFrameChildrenToSource(children, sourceDatums);
		} else {
			const manual = matchFrameChildrenToManualValues(children, link.datums);
			resolved = manual.ok ? manual.children : undefined;
		}
		if (resolved === undefined) continue;
		const operation = frameOperation(
			{ children: resolved, allowEmpty: false },
			link.condition,
		);
		if (operation !== undefined) ops.push(operation);
	}

	if (fallback !== undefined) {
		const operation = frameOperation(
			frameForPostSubmit(fallback.destination, sourceModule, sourceFormIndex),
			fallback.guard,
		);
		if (operation !== undefined) ops.push(operation);
	}

	return ops;
}

/**
 * Build a complete EntryDefinition for a form.
 *
 * The compiler resolves the form's module/form indices + case type +
 * indexed form_links from their uuids before calling this —
 * `deriveEntryDefinition` only deals with the suite-level index world
 * and never touches the doc.
 *
 * `formLinks` takes priority over `postSubmit` when non-empty: the stack
 * becomes one conditional `<create>` per link plus a fallback that fires
 * the `postSubmit` destination when no condition matches. An empty (or
 * omitted) `formLinks` falls back to the simple `postSubmit` derivation.
 *
 * `caseListFilter` is the module's `caseListConfig.filter` predicate;
 * the wire layer routes it through `deriveSessionDatums` so the
 * resulting case-loading datum's nodeset narrows to the authored
 * filter's match set. The filter is meaningful only on case-loading
 * form types — `deriveSessionDatums` ignores it for registration /
 * survey forms because they emit no case-loading datum at all.
 *
 * `excludedOwnerIds` is the module's owner-availability expression. It
 * narrows every case-loading nodeset independently of whether the module has
 * an effective remote Search action.
 *
 * `searchButtonDisplayCondition` is the module's
 * `caseSearchConfig.searchButtonDisplayCondition` predicate. It
 * lowers to the `<action relevant>` attribute on the case-list
 * detail's search-action element, which evaluates in the enclosing
 * `<entry>` context — so every instance the predicate references
 * needs an `<instance>` declaration here alongside the filter's
 * instances.
 *
 * `formDisplayCondition` is the form command's menu visibility predicate.
 * Nova canonically puts its session dependencies on the direct matching entry;
 * the emitted menu topology has no same-id nested menu that could make Core
 * select another entry first. A selected-case read contributes both the
 * `casedb` row source and `commcaresession`'s `case_id` anchor.
 *
 * `caseListColumnExpressions` carries each calculated expression
 * the module's case-list short / long detail actually emits. CCHQ's runtime
 * resolves a detail's `instance(...)` references against the
 * enclosing entry's declarations (the entry's `<datum
 * detail-select="m{N}_case_short" ... >` ties the two together);
 * CCHQ's server-side `InstancesHelper.add_entry_instances` walks
 * `detail.get_all_xpaths()` for every detail the entry references
 * and adds the missing declarations on the regenerated suite. Nova's
 * local `.ccz` emission has no equivalent post-process, so the
 * accumulator walks each calc expression's term set here.
 */
export function deriveEntryDefinition(
	formXmlns: string,
	moduleIndex: number,
	formIndex: number,
	formType: FormType,
	postSubmit: PostSubmitDestination,
	caseType?: string,
	formLinks?: HqFormLink[],
	caseListFilter?: Predicate,
	searchButtonDisplayCondition?: Predicate,
	caseListColumnExpressions?: readonly ValueExpression[],
	actions?: FormActions,
	excludedOwnerIds?: ValueExpression,
	relationContext: RelationEvaluationScopeContext = {},
	formDisplayCondition?: Predicate,
	lookupNaming?: LookupWireNaming,
	endOfForm: EndOfFormEntryContext = {},
): EntryDefinition {
	const commandId = `m${moduleIndex}-f${formIndex}`;
	const localeId = `forms.m${moduleIndex}f${formIndex}`;
	const { navigation, fallback, linkGuardPredicates } = endOfForm;

	const datumMetas = deriveFormDatums(
		formType,
		moduleIndex,
		caseType,
		caseListFilter,
		actions,
		excludedOwnerIds,
		relationContext,
		lookupNaming,
	);
	const datums = datumMetas.map((meta) => meta.datum);
	const instances: EntryInstance[] = [];
	const seen = new Set<string>();

	if (datums.length > 0) {
		for (const d of datums) {
			// Function datums (case-create's uuid()) don't read any instance;
			// only nodeset datums declare an instance dependency.
			if (!d.instanceId) continue;
			if (!seen.has(d.instanceId)) {
				seen.add(d.instanceId);
				instances.push({ id: d.instanceId, src: d.instanceSrc ?? "" });
			}
		}
	}

	// Accumulate the `<instance>` declarations the entry's body reaches —
	// the case-list filter, search-button condition, form-command condition,
	// and each runtime-relevant calc-column expression. Shared with the
	// `caseListOnly` browse entry so the two case-loading shapes can't drift on
	// which instances they declare. Runs after the datum's `casedb` seed above
	// so the final order is casedb → predicate instances → calc-column
	// instances.
	accumulateCaseLoadingInstances(
		caseListFilter,
		excludedOwnerIds,
		searchButtonDisplayCondition,
		formDisplayCondition,
		caseListColumnExpressions,
		instances,
		seen,
		lookupNaming,
	);

	// Every link guard evaluates in THIS entry's instance scope, so the
	// instances it reads must be declared here. A stack `if` naming an
	// undeclared instance is a runtime throw in Core's `XPathPathExpr.evalRaw`
	// the moment the form is submitted — and `casedb` is not otherwise
	// declared on a registration entry, which is exactly where a guard reading
	// the case the form just created lands.
	for (const guard of linkGuardPredicates ?? []) {
		const ids = collectPredicateInstances(guard, lookupNaming);
		if (predicateReadsCaseData(guard)) {
			ids.add("casedb");
			ids.add("commcaresession");
		}
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id) });
		}
	}

	// Stack operations. A link-bearing form emits one guarded frame per link
	// plus the fallback when one is still reachable; otherwise the form's own
	// post-submit destination decides, and `app_home` deliberately emits
	// nothing at all.
	const sourceModule = navigation?.modules[moduleIndex];
	const operations =
		formLinks && formLinks.length > 0 && navigation && sourceModule
			? deriveFormLinkStack(
					formLinks,
					fallback,
					navigation.modules,
					sourceModule,
					formIndex,
					datumMetas.map((meta) => meta.navigation),
				)
			: sourceModule
				? derivePostSubmitStack(postSubmit, sourceModule, formIndex)
				: [];

	return {
		formXmlns,
		commandId,
		localeId,
		instances,
		...(datums.length > 0 && { session: { datums } }),
		...(operations.length > 0 && { stack: { operations } }),
	};
}

/**
 * Build the `EntryDefinition` for a `caseListOnly` module's standalone
 * case-list-browse command.
 *
 * CCHQ emits this entry from the `if module.case_list.show:` block at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py`
 * whenever a module's case list is shown without an attached form — the
 * exact shape Nova's `expander.ts` stamps as `case_list.show = true` for
 * `caseListOnly` modules. The rendered fixture is
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/call-center.xml`:
 * an `<entry>` with NO `<form>`, a `<command id="m{N}-case-list">`, the
 * `casedb` instance, and a single `case_id` session datum that browses
 * the case list. The command id / locale id follow CCHQ's
 * `id_strings.case_list_command` (`m{N}-case-list`) /
 * `id_strings.case_list_locale` (`case_lists.m{N}`).
 *
 * The datum always carries `detail-select` (`m{N}_case_short`, Results).
 * `detail-confirm` (`m{N}_case_long`, Details) is conditional: it appears
 * only when the author put information on Details, so a pure browse entry
 * never sends the worker to an empty confirmation screen.
 *
 * `formXmlns` is omitted so `buildEntryElement` skips the `<form>`
 * child. The instance accumulation mirrors `deriveEntryDefinition`
 * exactly (the browse entry loads the same `m{N}_case_short` /
 * `m{N}_case_long` details the form entry does), so the local `.ccz`
 * carries the same `<instance>` declarations CCHQ's server-side
 * post-process would add on a regenerated suite.
 *
 * `searchButtonDisplayCondition` is accumulated because a `caseListOnly`
 * module may still carry a `caseSearchConfig` (the combo is a valid,
 * silent authoring state — `caseSearchConfigRequiresCaseType` only
 * rejects a missing case type). When present, the case-list short
 * detail's `<action relevant>` evaluates in this entry's context, so
 * every instance the condition references needs a declaration here. With
 * no forms in the module, this browse entry is the SOLE loader of
 * `m{N}_case_short`, so it is the only place those instances can land.
 */
export function deriveCaseListEntryDefinition(
	moduleIndex: number,
	caseType: string,
	caseListFilter?: Predicate,
	searchButtonDisplayCondition?: Predicate,
	caseListColumnExpressions?: readonly ValueExpression[],
	hasDetailScreen = true,
	excludedOwnerIds?: ValueExpression,
	relationContext: RelationEvaluationScopeContext = {},
	lookupNaming?: LookupWireNaming,
): EntryDefinition {
	// The browse datum: loads a case from the list into both the list
	// (detail-select) and detail (detail-confirm) screens. Shares the
	// nodeset builder with the form entry's `case_id` datum so the two
	// can't drift on the case-type / status / filter predicate order.
	const datum: SessionDatum = {
		id: "case_id",
		instanceId: "casedb",
		instanceSrc: "jr://instance/casedb",
		nodeset: caseLoadingNodeset(
			caseType,
			caseListFilter,
			excludedOwnerIds,
			relationContext,
			lookupNaming,
		),
		value: "./@case_id",
		detailSelect: `m${moduleIndex}_case_short`,
		...(hasDetailScreen && {
			detailConfirm: `m${moduleIndex}_case_long`,
		}),
	};

	// Seed `casedb` from the datum, then accumulate every body-reachable
	// instance in the same order as the form entry (casedb → predicate
	// instances → calc-column instances).
	const instances: EntryInstance[] = [];
	const seen = new Set<string>();
	if (datum.instanceId !== undefined) {
		seen.add(datum.instanceId);
		instances.push({ id: datum.instanceId, src: datum.instanceSrc ?? "" });
	}
	accumulateCaseLoadingInstances(
		caseListFilter,
		excludedOwnerIds,
		searchButtonDisplayCondition,
		undefined,
		caseListColumnExpressions,
		instances,
		seen,
		lookupNaming,
	);

	return {
		// `formXmlns` omitted — the browse entry launches no form.
		commandId: `m${moduleIndex}-case-list`,
		localeId: `case_lists.m${moduleIndex}`,
		instances,
		session: { datums: [datum] },
	};
}

// ── DOM Construction ────────────────────────────────────────────────────

/**
 * Build the `<datum>` element for one session datum. Two shapes —
 * function vs nodeset — dispatched on whether `d.function` is set.
 * CCHQ emits both inside the same `<session>` block, so the dispatch
 * lives at this single element-building site.
 *
 * Attribute insertion order matches CCHQ's canonical wire shape:
 * function datum is `id, function`; nodeset datum is `id, nodeset,
 * value, detail-select?, detail-confirm?`.
 */
function buildDatumElement(d: SessionDatum): Element {
	if (d.function !== undefined) {
		// Function datum — CommCare evaluates the function once at entry;
		// there is no nodeset, value, or detail to wire up.
		return el("datum", { id: d.id, function: d.function });
	}
	// Nodeset datum — case-loading shape. Optional `detail-select` /
	// `detail-confirm` attributes are appended only when defined so an
	// unset detail does not emit `detail-select=""` (CCHQ's canonical
	// shape: omit the attribute when no detail is wired).
	const attribs: Record<string, string> = {
		id: d.id,
		nodeset: d.nodeset ?? "",
		value: d.value ?? "",
	};
	if (d.detailSelect !== undefined) attribs["detail-select"] = d.detailSelect;
	if (d.detailConfirm !== undefined)
		attribs["detail-confirm"] = d.detailConfirm;
	return el("datum", attribs);
}

/**
 * Build one stack operation Element. Three shapes per `op.op`:
 *
 *   - `clear` — `<clear if="..."?/>`. Empty children by validator contract.
 *   - `create` / `push` with empty children — `<create if="..."?/>` (self-
 *     closing, semantically equivalent to a frame push with no work).
 *   - `create` / `push` with children — wraps `<command value="..."/>` /
 *     `<datum id="..." value="..."/>` grandchildren.
 *
 * `if` attribute is added only when `ifClause` is set so an unconditional
 * operation serializes without an `if=""` placeholder.
 */
function buildStackOperationElement(op: StackOperation): Element {
	const attribs: Record<string, string> = {};
	if (op.ifClause) attribs.if = op.ifClause;

	if (op.op === "clear" || op.children.length === 0) {
		return el(op.op, attribs);
	}

	const children: Element[] = op.children.map((child) =>
		child.type === "command"
			? el("command", { value: child.value })
			: el("datum", { id: child.id, value: child.value }),
	);
	return el(op.op, attribs, children);
}

/**
 * Build a `<stack>` Element from an operation list, or return `null` for
 * an empty list so the caller can omit the element entirely. The caller
 * matters: CommCare's default-no-stack-ops navigation pops the form frame
 * (returning the user to the previous level), which is exactly what
 * `derivePostSubmitStack` already short-circuits to for the `app_home`
 * destination — so `null` lets the empty-ops case round-trip to "no
 * `<stack>` on the wire" rather than "empty `<stack>` on the wire."
 */
export function buildStackElement(
	operations: StackOperation[],
): Element | null {
	if (operations.length === 0) return null;
	return el("stack", {}, operations.map(buildStackOperationElement));
}

/**
 * Build an `<entry>` Element from a derived entry definition. The orchestrator
 * (`compiler.ts`) splices the returned Element into the suite.xml tree and
 * serializes the entire suite once via `dom-serializer`.
 *
 * Element order inside `<entry>` matches CCHQ's canonical fixture order:
 * optional `<form>`, `<command>` (with nested `<text><locale/></text>`),
 * zero or more `<instance>` elements, optional `<session>`, optional
 * `<stack>`. The serializer preserves child insertion order, so the
 * constructed tree's shape is the on-wire shape.
 *
 * The `<form>` child is emitted only when `entry.formXmlns` is set. A
 * form entry always carries it; the `caseListOnly` case-list-browse
 * entry omits it (CCHQ's `case_list.show` block at `entries.py` builds
 * an `<entry>` with no `<form>`, per the `call-center.xml` fixture) —
 * the entry loads a case but launches no form.
 *
 * `commandDisplay` is the command's display child. The compiler passes the
 * form's nav node — a bare `<text><locale/></text>` when the form has no
 * menu media, or a `<display>` wrapping the text + `<text form="image|audio">`
 * media locales when it does. When omitted (the string-render test surface),
 * the command falls back to a bare `<text><locale/></text>` synthesized
 * from `entry.localeId`.
 */
export function buildEntryElement(
	entry: EntryDefinition,
	commandDisplay?: Element,
): Element {
	const children: Element[] = [];

	// `<form>` carries the form's xmlns as text content. The serializer
	// XML-escapes the text once at render time, so a future xmlns
	// containing `&` (etc.) round-trips correctly without any local
	// escaping. Omitted for the case-list-browse entry, which has no
	// form to launch — CCHQ's `case_list.show` entry carries no `<form>`.
	if (entry.formXmlns !== undefined) {
		children.push(el("form", {}, [text(entry.formXmlns)]));
	}

	children.push(
		el("command", { id: entry.commandId }, [
			commandDisplay ?? el("text", {}, [el("locale", { id: entry.localeId })]),
		]),
	);

	for (const inst of entry.instances) {
		children.push(el("instance", { id: inst.id, src: inst.src }));
	}

	if (entry.session) {
		children.push(
			el("session", {}, entry.session.datums.map(buildDatumElement)),
		);
	}

	if (entry.stack) {
		const stackEl = buildStackElement(entry.stack.operations);
		if (stackEl !== null) children.push(stackEl);
	}

	return el("entry", {}, children);
}

// ── String Adapters ─────────────────────────────────────────────────────
//
// `renderEntryXml` / `renderStackXml` serialize the constructed Element
// trees so callers that consume the rendered XML as a string (the test
// surface) see the same bytes `compileCcz` splices into the assembled
// suite tree. The compiler itself calls `buildEntryElement` /
// `buildStackElement` directly.

/** Render an EntryDefinition to a suite.xml `<entry>` string. */
export function renderEntryXml(entry: EntryDefinition): string {
	return render(buildEntryElement(entry), RENDER_OPTS);
}

/** Render stack operations to a suite.xml `<stack>` string. */
export function renderStackXml(operations: StackOperation[]): string {
	const stackEl = buildStackElement(operations);
	return stackEl === null ? "" : render(stackEl, RENDER_OPTS);
}

// ── HQ Workflow Mapping ────────────────────────────────────────────────
//
// One-way: domain `PostSubmitDestination` → HQ wire `post_form_workflow`
// string. The reverse direction (parsing the wire value back to a
// domain enum) isn't needed because the compile pipeline reads
// post-submit straight from the doc; the wire shape is write-only from
// Nova's perspective. Eliminating the reverse mapping also removes a
// fidelity trap: `app_home` and an absent-destination both encode to
// `"default"` on the wire, so the reverse lookup was lossy.

/**
 * HQ's `WORKFLOW_FORM` — the only value under which
 * `EndOfFormNavigationWorkflow.form_workflow_frames` reads `form_links`.
 * It has no Nova counterpart because Nova's `postSubmit` describes the
 * FALLBACK: whether links exist is a property of the link list.
 */
export const HQ_WORKFLOW_FORM = "form";

const NOVA_TO_HQ: Record<PostSubmitDestination, string> = {
	app_home: "default",
	root: "root",
	module: "module",
	parent_module: "parent_module",
	previous: "previous_screen",
};

export function toHqWorkflow(postSubmit: PostSubmitDestination): string {
	return NOVA_TO_HQ[postSubmit];
}
