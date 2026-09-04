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
import type {
	CaseTileGrouping,
	FormType,
	PostSubmitDestination,
} from "@/lib/domain";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import {
	effectiveDisplayConditionForEmission,
	predicateReadsCaseData,
	substituteUnansweredSearchInputsInExpression,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import type { RelationEvaluationScopeContext } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import type { SearchInputInstanceId } from "@/lib/domain/predicate/typeChecker";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import type { MatchedChild, ProjectedFormLinks } from "./formLinkProjection";
import { validateCaseType } from "./identifierValidation";
import type { LookupWireNaming } from "./lookup/naming";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "./predicate/instances";
import {
	emitExcludedOwnerNodesetFilter,
	emitNodesetFilter,
} from "./suite/case-list/nodesetFilter";
import type { FormActions } from "./types";
import {
	USERCASE_DATUM_ID,
	USERCASE_ID_FUNCTION,
	USERCASE_MISSING_ASSERT_TEST,
	USERCASE_MISSING_LOCALE_ID,
} from "./usercaseWire";
import { collectInstanceRefs } from "./xform/instanceRefs";

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
	/**
	 * The instances a COMPUTED datum's `function` reads.
	 *
	 * A nodeset datum names its one instance in `instanceId`; a function can
	 * reach several, and CommCare resolves them against the enclosing entry's
	 * declarations. Stated here rather than recovered from the expression,
	 * because reading XPath structure back out of a string is exactly the
	 * parsing this codebase does not do — the site that composes the function
	 * already knows what it reached.
	 */
	instanceIds?: readonly string[];
	detailSelect?: string;
	detailConfirm?: string;
	/**
	 * Detail kept on screen for the whole of the entry it belongs to —
	 * CommCare's persistent case tile. Web Apps renders it in the sticky
	 * `#persistent-case-tile` region above the form
	 * (`commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::PersistentCaseTileView`),
	 * suppressed only inside HQ's own App Preview pane, which Nova does
	 * not target. Nova sets it to the module's short detail exactly when
	 * the case list carries a tile layout that asks to persist.
	 */
	detailPersistent?: string;
	autoselect?: boolean;
	/**
	 * Present for CommCare's collection-valued `<instance-datum>` selector.
	 * Its id is also the selected-entities instance id exposed to the XForm.
	 */
	maxSelectValue?: number;
	/**
	 * The case type this datum selects (`case_id`) or creates
	 * (`case_id_new_<type>_N`, the worker's own `commcare-user`). Not
	 * rendered: it is what HQ's end-of-form workflow reads back off the
	 * emitted datum (`workflow.py::WorkflowDatumMeta.case_type`) to match a
	 * link target's datums against the source entry's, and
	 * `formLinkProjection.ts` reads it here instead of re-deriving it from
	 * the nodeset string.
	 */
	caseType?: string;
	/**
	 * For a function datum whose function reads other session values:
	 * re-renders `function` with every `session/data/<id>` reference
	 * supplied by the caller. Not rendered directly; the entry emits
	 * `function`. `formLinkProjection.ts` uses it to follow HQ's
	 * `_replace_session_references_in_stack` without reading XPath out of a
	 * string.
	 */
	renderFunction?: (sessionRef: (datumId: string) => string) => string;
	/** Structural regeneration hook used when HQ-style root-menu alignment
	 * renames a datum. Never rendered. */
	renderNodeset?: (parentSelection?: SessionDatum) => string;
	/** The immediately preceding selection in a parent-select chain. */
	parentSelection?: SessionDatum;
	/**
	 * Present on the `<query>` session child of a search-first module. The
	 * datum's `id` is the storage instance the search fills
	 * (`results:inline`), which is also the id HQ's end-of-form workflow
	 * gives the frame child it derives from it (`workflow.py::WorkflowQueryMeta`).
	 * No nodeset, value, or detail: the element is rendered as is.
	 */
	query?: SessionQuery;
}

/**
 * The search a search-first module runs inside its entries, immediately
 * before the case datum that reads its results (CCHQ's
 * `EntriesHelper.add_remote_query_datums`).
 */
export interface SessionQuery {
	/** The rendered `<query>` element. */
	readonly element: Element;
	readonly storageInstance: "results:inline";
	/** The module's case type, the query's first `<data key="case_type">`. */
	readonly caseType: string;
	/** Whether the worker answers anything. With no visible prompt the
	 *  search runs on its own (`default_search`), and HQ then treats the
	 *  query as a selecting step in frames (`WorkflowQueryMeta.requires_selection`). */
	readonly hasPrompts: boolean;
	readonly defaultSearch: boolean;
	/** Instances the query body reads, declared on the surrounding entry. */
	readonly instances: readonly string[];
}

/** A secondary instance required by a form entry. */
export interface EntryInstance {
	id: string;
	src: string;
}

/** A rendered claim `<post>` and the instances its XPath reads. */
export interface EntryPost {
	readonly element: Element;
	readonly instances: readonly string[];
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
//      They're popped in LIFO order during session resolution — which is why
//      Nova's after-submit links never share a true `if`: the projection at
//      `formLinkProjection.ts` gives each link an exclusive guard, so "the
//      first true link wins" holds by construction rather than by runtime.
//
// Key difference between no <stack> and empty <create/>:
//   - No <stack>: form frame is popped, user returns to previous level
//   - <create/>: empty frame pushed, resolves to home (no command = no entry)
//   - <clear/>: stack is wiped, session ends, user goes home

/** One `<data>` of a stack `<query>` child. */
export interface StackQueryData {
	readonly key: string;
	readonly ref: string;
	readonly nodeset?: string;
	readonly exclude?: string;
}

/** A child element of a <create> or <push> operation. */
export type StackChild =
	| { type: "command"; value: string }
	| { type: "datum"; id: string; value: string }
	/** A frame step that fetches cases into a search-first module's
	 *  results instance before the datum that selects one (HQ
	 *  `WorkflowQueryMeta.to_stack_datum`). */
	| {
			type: "query";
			id: string;
			value: string;
			data: readonly StackQueryData[];
	  };

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
	/**
	 * The claim `<post>` of a search-first module's case-requiring entry:
	 * fires when the worker picks a result the device does not yet hold
	 * (`EntriesHelper.add_post_to_entry`). Sits between `<form>` and
	 * `<command>` on the wire.
	 */
	post?: EntryPost;
	commandId: string;
	localeId: string;
	instances: EntryInstance[];
	session?: { datums: SessionDatum[] };
	/**
	 * Entry-time guards CommCare evaluates before the form opens. Present only
	 * for the worker's own case today: HQ pairs the computed `usercase_id`
	 * datum with `count(...) = 1` over the same selector
	 * (`EntriesHelper.add_usercase_id_assertion`), so a device whose restore
	 * carries no usercase is stopped at the door rather than submitting a write
	 * that lands nowhere.
	 */
	assertions?: Array<{ test: string; localeId: string }>;
	stack?: { operations: StackOperation[] };
}

// ── Derivation Functions ───────────────────────────────────────────────

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
export function caseLoadingNodeset(
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
 * The case datum's nodeset when the cases come from a search-first
 * module's own search rather than the device's casedb: CCHQ's
 * `EntriesHelper.get_datum_meta_module` reads `instance('results:inline')/results/case`
 * and appends `EXCLUDE_RELATED_CASES_FILTER` after the list rule. No
 * owner fragment: the query already sends `commcare_blacklisted_owner_ids`,
 * so the server never returns those cases.
 */
export function inlineSearchNodeset(
	caseType: string,
	caseListFilter: Predicate | undefined,
	relationContext: RelationEvaluationScopeContext = {},
	lookupNaming?: LookupWireNaming,
): string {
	const filterFragment = emitNodesetFilter(
		caseListFilter,
		relationContext,
		lookupNaming,
	);
	return `instance('${INLINE_SEARCH_RESULTS_INSTANCE}')/results/case[@case_type='${validateCaseType(caseType)}'][@status='open']${filterFragment}${EXCLUDE_RELATED_CASES_FILTER}`;
}

/** CCHQ's `RESULTS_INSTANCE_INLINE` and its `jr://` source. */
export const INLINE_SEARCH_RESULTS_INSTANCE = "results:inline";
export const INLINE_SEARCH_RESULTS_SRC = "jr://instance/remote/results:inline";
/** CCHQ's `EXCLUDE_RELATED_CASES_FILTER`, verbatim. */
export const EXCLUDE_RELATED_CASES_FILTER =
	"[not(commcare_is_related_case=true())]";

/** Build one selectable case datum. Nested-menu projection uses this for
 * every step in a parent-select chain, while the flat helper below keeps the
 * historical single-`case_id` default. */
export function deriveCaseSelectionDatum(args: {
	readonly id: string;
	readonly caseType: string;
	readonly moduleIndex: number;
	readonly caseListFilter?: Predicate;
	readonly excludedOwnerIds?: ValueExpression;
	readonly relationContext?: RelationEvaluationScopeContext;
	readonly lookupNaming?: LookupWireNaming;
	readonly persistentDetailId?: string;
	readonly parentSelection?: SessionDatum;
	readonly detailConfirm?: boolean;
	readonly maxSelectValue?: number;
	/** Where the selectable cases come from: the device's casedb, or the
	 *  results of a search-first module's own search. */
	readonly caseSource?: "casedb" | "results:inline";
}): SessionDatum {
	const inline = args.caseSource === "results:inline";
	const secondaryInstances = new Set<string>();
	if (args.caseListFilter !== undefined) {
		const unanswered = substituteUnansweredSearchInputsInPredicate(
			args.caseListFilter,
		);
		for (const id of collectPredicateInstances(unanswered, args.lookupNaming)) {
			if (id !== "casedb") secondaryInstances.add(id);
		}
	}
	if (args.excludedOwnerIds !== undefined && !inline) {
		const unanswered = substituteUnansweredSearchInputsInExpression(
			args.excludedOwnerIds,
		);
		for (const id of collectExpressionInstances(
			unanswered,
			args.lookupNaming,
		)) {
			if (id !== "casedb") secondaryInstances.add(id);
		}
	}
	if (
		args.parentSelection !== undefined &&
		args.parentSelection.maxSelectValue === undefined
	)
		secondaryInstances.add("commcaresession");
	const base = inline
		? inlineSearchNodeset(
				args.caseType,
				args.caseListFilter,
				args.relationContext,
				args.lookupNaming,
			)
		: caseLoadingNodeset(
				args.caseType,
				args.caseListFilter,
				args.excludedOwnerIds,
				args.relationContext,
				args.lookupNaming,
			);
	const renderNodeset = (parentSelection?: SessionDatum): string => {
		const parentFilter =
			parentSelection === undefined
				? ""
				: parentSelection.maxSelectValue === undefined
					? `[index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/${parentSelection.id}]`
					: `[index/*[not(@relationship='extension')]=instance('${parentSelection.id}')/results/value]`;
		return `${base}${parentFilter}`;
	};
	return {
		id: args.id,
		instanceId: inline ? INLINE_SEARCH_RESULTS_INSTANCE : "casedb",
		instanceSrc: inline ? INLINE_SEARCH_RESULTS_SRC : "jr://instance/casedb",
		...(secondaryInstances.size > 0 && {
			instanceIds: [...secondaryInstances],
		}),
		nodeset: renderNodeset(args.parentSelection),
		renderNodeset,
		value: "./@case_id",
		detailSelect: `m${args.moduleIndex}_case_short`,
		...(args.detailConfirm === true && {
			detailConfirm: `m${args.moduleIndex}_case_long`,
		}),
		...(args.persistentDetailId !== undefined && {
			detailPersistent: args.persistentDetailId,
		}),
		...(args.maxSelectValue !== undefined && {
			maxSelectValue: args.maxSelectValue,
		}),
		caseType: args.caseType,
	};
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
	searchInputInstanceId?: SearchInputInstanceId,
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
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
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
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
		}
	}

	if (searchButtonDisplayCondition !== undefined) {
		for (const id of collectPredicateInstances(
			searchButtonDisplayCondition,
			lookupNaming,
			"suite",
			searchInputInstanceId,
		)) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
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
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
		}
	}

	// Calc-column expressions land on `m{N}_case_short` / `m{N}_case_long`.
	// CCHQ resolves the detail's XPath against the enclosing entry's
	// declarations — accumulate every instance the expression reaches so
	// the local `.ccz` carries the same declarations CCHQ's server-side
	// post-process would add on a regenerated suite.
	if (caseListColumnExpressions !== undefined) {
		for (const expression of caseListColumnExpressions) {
			for (const id of collectExpressionInstances(
				expression,
				lookupNaming,
				"suite",
				searchInputInstanceId,
			)) {
				if (seen.has(id)) continue;
				seen.add(id);
				instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
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
 * Filter precedence (case-type / status first, user filter last) matches
 * CCHQ's canonical builder at
 * `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`.
 */
export interface SessionDatumsInput {
	readonly formType: FormType;
	readonly moduleIndex: number;
	readonly caseType?: string;
	/**
	 * The module's `caseListConfig.filter`. When present the wire layer
	 * appends its bracketed fragment to the nodeset after the
	 * `[@case_type][@status]` predicates, narrowing the case set the runtime
	 * selects from. Meaningful only on case-loading form types: a
	 * registration or survey form emits no case-loading datum to narrow.
	 */
	readonly caseListFilter?: Predicate;
	/**
	 * The form's `FormActions`, post-expansion. `open_case.condition` and
	 * `subcases` decide which case-create datums are emitted. Omitted, only
	 * the case-loading datum is emitted — the shape a caller carrying no
	 * expanded actions gets.
	 */
	readonly actions?: FormActions;
	/**
	 * The module's owner-availability expression. It narrows every
	 * case-loading nodeset whether or not the module has an effective remote
	 * Search action.
	 */
	readonly excludedOwnerIds?: ValueExpression;
	readonly relationContext?: RelationEvaluationScopeContext;
	readonly lookupNaming?: LookupWireNaming;
	readonly persistentDetailId?: string;
	readonly tileGrouping?: CaseTileGrouping;
	/** Pre-projected selectable datums. Nested child menus use this to carry
	 * their parent-select chain and root-menu datum alignment. */
	readonly caseSelectionDatums?: readonly SessionDatum[];
}

export function deriveSessionDatums(args: SessionDatumsInput): SessionDatum[] {
	const {
		formType,
		moduleIndex,
		caseType,
		caseListFilter,
		actions,
		excludedOwnerIds,
		relationContext = {},
		lookupNaming,
		persistentDetailId,
		tileGrouping,
		caseSelectionDatums,
	} = args;
	const datums: SessionDatum[] = [];

	// (1) Case-loading datum for followup / close.
	if (caseSelectionDatums !== undefined) {
		datums.push(...caseSelectionDatums);
	} else if (CASE_LOADING_FORM_TYPES.has(formType) && caseType) {
		datums.push(
			...[
				deriveCaseSelectionDatum({
					id: "case_id",
					caseType,
					moduleIndex,
					caseListFilter,
					excludedOwnerIds,
					relationContext,
					lookupNaming,
					persistentDetailId,
				}),
			],
		);
	}

	// (0) The worker's own case, appended LAST, matching HQ: the datum list is
	// built for the form and `get_extra_case_id_datums` extends it afterwards
	// (`entries.py:521`), which is the order `usercase_entry.xml` shows —
	// `case_id` then `usercase_id`.
	//
	// Declared here as a closure so it stays adjacent to its reason and still
	// runs after the case datums below.
	const appendUsercaseDatum = (): void => {
		// `util.py::actions_use_usercase`, minus the preload half: Nova's
		// `usercase_preload` is a stated fence at `neverCondition()`, since
		// `#user/` already compiles to the same `casedb` join.
		const update = actions?.usercase_update;
		// Optional despite the type: `deriveSessionDatums` is reached from
		// tests and callers that hand it a partial action set, and a missing
		// slot means the same thing an inactive one does.
		if (update?.condition.type !== "always") return;
		if (Object.keys(update.update).length === 0) return;
		datums.push({
			id: USERCASE_DATUM_ID,
			function: USERCASE_ID_FUNCTION,
			// The selector joins `casedb` against the session's own user id, so
			// the entry declares both. This is load-bearing on a form whose ONLY
			// write is to the worker's record: it has no case-loading datum, so
			// nothing else would declare `casedb`, and a missing declaration
			// resolves to nothing at runtime with no build-time error
			// (`CommCareInstanceInitializer::loadFixtureRoot`).
			instanceIds: ["casedb", "commcaresession"],
			caseType: "commcare-user",
		});
	};

	if (actions) {
		// (2) Case-create datum for an active `open_case` action. CCHQ
		// emits this whenever `'open_case' in form.active_actions()`, which
		// in Nova's FormActions shape is condition.type in {always, if}.
		const opensCase =
			actions.open_case.condition.type === "always" ||
			actions.open_case.condition.type === "if";
		const opensSubcaseIndexOffset = opensCase ? 1 : 0;
		if (opensCase && caseType) {
			datums.push({
				id: `case_id_new_${validateCaseType(caseType)}_0`,
				function: "uuid()",
				caseType,
			});
		}

		// (3) Per-subcase datums. Skip subcases whose action is inactive or
		// that live in a repeat — CCHQ also skips repeat-context subcases
		// for session emission and uses a per-iteration calculate bind on
		// the form side. The wire-layer datum index counts ALL active
		// subcases (including any repeat-context ones), then this function
		// only EMITS for the non-repeat-context ones — matching the
		// `Form.session_var_for_action` numbering at the CCHQ side.
		//
		// HQ also emits this scalar `uuid()` datum on a multi-select form even
		// though Nova's authored XForm creates one child per selected parent with
		// its own `uuid()` calculate. It therefore remains an inert parity datum:
		// no case block consumes it, and the absolute multi-select validator
		// refuses a direct form link that would mistake it for one created child.
		for (let i = 0; i < actions.subcases.length; i++) {
			const sc = actions.subcases[i];
			if (sc.condition.type !== "always" && sc.condition.type !== "if") {
				continue;
			}
			if (sc.repeat_context) continue;
			datums.push({
				id: `case_id_new_${validateCaseType(sc.case_type)}_${i + opensSubcaseIndexOffset}`,
				function: "uuid()",
				caseType: sc.case_type,
			});
		}
	}

	// (4) The grouped-tile companion datum. CCHQ emits it from
	// `commcare-hq/.../suite_xml/sections/entries.py::EntriesHelper.get_extra_case_id_datums`,
	// last and only when there IS a form with a case-selection datum
	// (`::get_case_datums_basic_module` takes `case_datum = datums[-1] if
	// datums else None`, then guards the whole call on `if form:`), so a
	// registration form's entry and the standalone case-list browse entry
	// never carry it. Nova mirrors both gates: the identifier is present
	// only for a grouped tile, and the case-loading datum above is what
	// proves this entry selects a case.
	//
	// The predicate is a plain `@case_id` match against the selected case
	// and deliberately NOT the case-list nodeset's type / status / filter
	// fragment — the datum resolves the ONE selected case's index target,
	// so re-narrowing the candidate set would be a different question.
	// `join(' ', distinct-values(...))` looks redundant for a single case
	// and is not: it is the shape the multi-select variant reuses when it
	// swaps the datum class to `<instance-datum>`, so keeping it verbatim
	// makes that a second predicate arm rather than a reshape.
	appendUsercaseDatum();

	const caseSelectDatum = [...datums]
		.reverse()
		.find(
			(datum) => datum.nodeset !== undefined && datum.caseType === caseType,
		);
	if (tileGrouping !== undefined && caseSelectDatum !== undefined) {
		const renderFunction = (
			sessionRef: (datumId: string) => string,
		): string => {
			const predicate =
				caseSelectDatum.maxSelectValue === undefined
					? `@case_id = ${sessionRef(caseSelectDatum.id)}`
					: `selected(join(' ', instance('${caseSelectDatum.id}')/results/value), @case_id)`;
			return `join(' ', distinct-values(instance('casedb')/casedb/case[${predicate}]/index/${tileGrouping.identifier}))`;
		};
		datums.push({
			id: `${caseSelectDatum.id}_parent_ids`,
			function: renderFunction(
				(datumId) => `instance('commcaresession')/session/data/${datumId}`,
			),
			renderFunction,
		});
	}

	return datums;
}

/** A projected frame child as the suite's `<create>` child. */
export function toStackChild(child: MatchedChild): StackChild {
	switch (child.type) {
		case "command":
			return { type: "command", value: `'${child.id}'` };
		case "datum":
			return { type: "datum", id: child.id, value: child.value };
		case "query":
			return {
				type: "query",
				id: child.id,
				value: child.value,
				data: child.data,
			};
	}
}

/**
 * Derive stack operations for simple post-submit destinations, mirroring
 * HQ's `workflow.py::EndOfFormNavigationWorkflow::_get_static_stack_frame`
 * for the three workflows Nova authors:
 *
 * | Destination | Operation                                                      |
 * |-------------|----------------------------------------------------------------|
 * | `app_home`  | nothing (HQ `default`: no frame; the form frame pops to home)  |
 * | `module`    | `<create><command value="'m{idx}'"/></create>`                  |
 * | `previous`  | `<create>` carrying `previousFrame` (HQ `previous_screen`)      |
 *
 * `previousFrame` is the source entry's own frame children with the last
 * child and every trailing computed datum popped — derived by
 * `formLinkProjection.ts::previousFrameChildren`, never guessed here from
 * the form type. A childless `previous` frame (HQ drops a childless frame
 * unless the workflow is `root`, which Nova does not author) emits nothing.
 */
export function derivePostSubmitStack(
	postSubmit: PostSubmitDestination,
	moduleIndex: number,
	previousFrame: readonly MatchedChild[],
	moduleFrame: readonly MatchedChild[] = [
		{ type: "command", id: `m${moduleIndex}` },
	],
): StackOperation[] {
	switch (postSubmit) {
		case "app_home":
			return [];
		case "module":
			return [
				{
					op: "create",
					children: moduleFrame.map(toStackChild),
				},
			];
		case "previous":
			return previousFrame.length === 0
				? []
				: [{ op: "create", children: previousFrame.map(toStackChild) }];
	}
}

/**
 * Derive stack operations for a form that carries after-submit links.
 *
 * One `<create>` per link, guarded by the projection's EXCLUSIVE guard
 * (`formLinkProjection.ts::planFormLinkGuards`), so exactly one frame fires
 * whatever the runtime does with several true `if`s: the first true link
 * wins by construction. Each frame's children are the target's frame
 * children after datum matching (HQ's `get_frame_children` +
 * `_get_datums_matched_to_source` / `…_to_manual_values`).
 *
 * The fallback frame is appended only when the projection says the last
 * link is conditional (`fallback.kind === "guarded"`): its `if` is the
 * conjunction of the negated emitted guards, byte for byte what HQ derives
 * from the `xpath`s Nova sends it, and its body is the `postSubmit`
 * destination's frame. A terminal unconditional link is the exhaustive else
 * and suppresses it; `app_home` emits no frame (HQ `default`).
 */
export function deriveFormLinkStack(
	projected: ProjectedFormLinks,
	fallback: PostSubmitDestination,
	sourceModuleIndex: number,
	previousFrame: readonly MatchedChild[],
	moduleFrame?: readonly MatchedChild[],
): StackOperation[] {
	const ops: StackOperation[] = projected.links.map((link) => ({
		op: "create",
		...(link.guard !== undefined && { ifClause: link.guard }),
		children: link.children.map(toStackChild),
	}));
	if (projected.fallback.kind === "guarded") {
		const guard = projected.fallback.guard;
		for (const op of derivePostSubmitStack(
			fallback,
			sourceModuleIndex,
			previousFrame,
			moduleFrame,
		)) {
			ops.push({ ...op, ifClause: guard });
		}
	}
	return ops;
}

/**
 * Build a complete EntryDefinition for a form.
 *
 * The compiler resolves the form's module/form indices, its case type,
 * its projected after-submit links, and its `previous` frame before
 * calling this — `deriveEntryDefinition` only deals with the suite-level
 * index world and never touches the doc.
 *
 */
export interface EntryDefinitionInput extends SessionDatumsInput {
	readonly formXmlns: string;
	readonly formIndex: number;
	readonly postSubmit: PostSubmitDestination;
	/**
	 * The form's projected after-submit links (`formLinkProjection.ts::
	 * projectFormLinks`). Present, the stack is one exclusive `<create>` per
	 * link plus the fallback frame the projection calls for; absent, the
	 * stack is the simple `postSubmit` derivation.
	 */
	readonly formLinks?: ProjectedFormLinks;
	/**
	 * The source entry's `previous` frame (`formLinkProjection.ts::
	 * previousFrameChildren`), read whenever `postSubmit` (or the links'
	 * fallback) is `previous`. Omitted, a `previous` destination emits no
	 * frame: the caller that wants HQ's `previous_screen` bytes derives it.
	 */
	readonly previousFrame?: readonly MatchedChild[];
	/** Parent-aware frame for the owning module. Flat modules omit it. */
	readonly moduleFrame?: readonly MatchedChild[];
	/** Fully projected session, including root-menu alignment. */
	readonly projectedSessionDatums?: readonly SessionDatum[];
	/**
	 * The module's `caseSearchConfig.searchButtonDisplayCondition`. It lowers
	 * to the `<action relevant>` attribute on the case-list detail's
	 * search-action element, which evaluates in the enclosing `<entry>`
	 * context — so every instance it references needs a declaration here,
	 * alongside the filter's.
	 */
	readonly searchButtonDisplayCondition?: Predicate;
	/**
	 * Each calculated expression the module's case-list short / long detail
	 * actually emits. CCHQ's runtime resolves a detail's `instance(...)`
	 * references against the enclosing entry's declarations, and its
	 * server-side `InstancesHelper.add_entry_instances` walks
	 * `detail.get_all_xpaths()` to add the missing ones on a regenerated
	 * suite. Nova's local `.ccz` has no equivalent post-process, so the
	 * accumulator walks each calc expression's term set here.
	 */
	readonly caseListColumnExpressions?: readonly ValueExpression[];
	/**
	 * The form command's menu visibility predicate. Nova canonically puts its
	 * session dependencies on the direct matching entry; the emitted menu
	 * topology has no same-id nested menu that could make Core select another
	 * entry first. A selected-case read contributes both the `casedb` row
	 * source and `commcaresession`'s `case_id` anchor.
	 */
	readonly formDisplayCondition?: Predicate;
	/** The claim post of a search-first module's case-requiring entry. */
	readonly post?: EntryPost;
	/**
	 * HQ's case-list-form return frame (`CaseListFormWorkflow`): the one
	 * `<create if="…return_to = 'm{N}'">` a no-matches registration form's
	 * entry carries after its own workflow frames, so submitting returns to
	 * the host module's Results. Built by
	 * `formLinkProjection.ts::caseListFormReturnFrame`.
	 */
	readonly returnFrame?: {
		readonly ifClause: string;
		readonly children: readonly MatchedChild[];
	};
}

export function deriveEntryDefinition(
	args: EntryDefinitionInput,
): EntryDefinition {
	const {
		formXmlns,
		moduleIndex,
		formIndex,
		postSubmit,
		formLinks,
		previousFrame = [],
		moduleFrame,
		projectedSessionDatums,
		caseListFilter,
		searchButtonDisplayCondition,
		caseListColumnExpressions,
		excludedOwnerIds,
		formDisplayCondition,
		lookupNaming,
	} = args;
	const commandId = `m${moduleIndex}-f${formIndex}`;
	const localeId = `forms.m${moduleIndex}f${formIndex}`;

	// Every datum field is already on `args`, so this forwards the whole
	// object rather than re-listing ten arguments in order. That re-listing
	// was the one place a positional slip could compile and still be wrong.
	const datums =
		projectedSessionDatums === undefined
			? deriveSessionDatums(args)
			: [...projectedSessionDatums];
	const instances: EntryInstance[] = [];
	const seen = new Set<string>();

	if (datums.length > 0) {
		for (const d of datums) {
			// A nodeset datum reads exactly one instance and names it in
			// `instanceId`. A function datum reads none (case-create's `uuid()`)
			// or several, and says so in `instanceIds`. A query reads what its
			// data and prompts reach.
			if (d.instanceId && !seen.has(d.instanceId)) {
				seen.add(d.instanceId);
				instances.push({ id: d.instanceId, src: d.instanceSrc ?? "" });
			}
			for (const id of d.query?.instances ?? []) {
				if (seen.has(id)) continue;
				seen.add(id);
				instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
			}
			if (d.maxSelectValue !== undefined && !seen.has(d.id)) {
				seen.add(d.id);
				instances.push({
					id: d.id,
					src: instanceSourceFor(d.id, lookupNaming),
				});
			}
			for (const id of d.instanceIds ?? []) {
				if (seen.has(id)) continue;
				seen.add(id);
				instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
			}
		}
	}

	for (const id of args.post?.instances ?? []) {
		if (seen.has(id)) continue;
		seen.add(id);
		instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
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
		args.relationContext?.searchInputInstanceId,
	);

	// Post-form stack guards, frame datum values, and manual datum XPath all
	// evaluate in this entry scope (a registration entry declares no `casedb`
	// of its own, and a guard reading the just-created case needs it). The
	// strings are already wire XPath, so collect literal instance() roots
	// structurally and declare the matching sources.
	for (const link of formLinks?.links ?? []) {
		const expressions = [
			...(link.guard === undefined ? [] : [link.guard]),
			...link.children.flatMap(stackChildExpressions),
			...link.datums.map((datum) => datum.xpath),
		];
		for (const expression of expressions) {
			for (const id of collectInstanceRefs(expression)) {
				if (seen.has(id)) continue;
				seen.add(id);
				instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
			}
		}
	}
	if (formLinks?.fallback.kind === "guarded") {
		for (const id of collectInstanceRefs(formLinks.fallback.guard)) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
		}
	}
	// The `previous` frame's datum values evaluate here as well (as the
	// post-submit destination, or as the fallback the projection guards), and
	// they read `instance('commcaresession')` even on an entry whose own
	// datums declare only `casedb`. HQ's `InstancesHelper` post-process walks
	// every stack frame; Nova's local suite declares them at the source.
	if (postSubmit === "previous") {
		for (const child of previousFrame) {
			for (const expression of stackChildExpressions(child)) {
				for (const id of collectInstanceRefs(expression)) {
					if (seen.has(id)) continue;
					seen.add(id);
					instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
				}
			}
		}
	}

	// The stack: one exclusive `<create>` per link plus the projection's
	// fallback when the form carries links, else the simple `postSubmit`
	// frame. `app_home` (HQ `default`) contributes no frame either way, so a
	// form with no links and `app_home` emits no `<stack>` at all — CommCare
	// pops the form frame and lands home.
	const operations = [
		...(formLinks !== undefined
			? deriveFormLinkStack(
					formLinks,
					postSubmit,
					moduleIndex,
					previousFrame,
					moduleFrame,
				)
			: derivePostSubmitStack(
					postSubmit,
					moduleIndex,
					previousFrame,
					moduleFrame,
				)),
		// End-of-form frames win over the case-list-form frame, so it is
		// last (`WorkflowHelper.add_form_workflow` appends
		// `case_list_forms_frames` after the workflow's own).
		...(args.returnFrame === undefined
			? []
			: [
					{
						op: "create" as const,
						ifClause: args.returnFrame.ifClause,
						children: args.returnFrame.children.map(toStackChild),
					},
				]),
	];
	for (const operation of operations) {
		for (const child of operation.children) {
			for (const expression of stackChildExpressions(child)) {
				for (const id of collectInstanceRefs(expression)) {
					if (seen.has(id)) continue;
					seen.add(id);
					instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
				}
			}
		}
	}

	return {
		formXmlns,
		...(args.post !== undefined && { post: args.post }),
		commandId,
		localeId,
		instances,
		...(datums.length > 0 && { session: { datums } }),
		// Gated on the DATUM, not on the actions — `entries.py:544` reads
		// `any_usercase_datums(all_datums)`, so the assertion cannot appear
		// without the datum it guards, whatever the actions later say.
		...(datums.some((datum) => datum.id === USERCASE_DATUM_ID) && {
			assertions: [
				{
					test: USERCASE_MISSING_ASSERT_TEST,
					localeId: USERCASE_MISSING_LOCALE_ID,
				},
			],
		}),
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
	persistentDetailId?: string,
	projectedDatums?: readonly SessionDatum[],
): EntryDefinition {
	// The browse datum: loads a case from the list into both the list
	// (detail-select) and detail (detail-confirm) screens. Shares the
	// nodeset builder with the form entry's `case_id` datum so the two
	// can't drift on the case-type / status / filter predicate order.
	const datums =
		projectedDatums === undefined
			? [
					deriveCaseSelectionDatum({
						id: "case_id",
						caseType,
						moduleIndex,
						caseListFilter,
						excludedOwnerIds,
						relationContext,
						lookupNaming,
						persistentDetailId,
						detailConfirm: hasDetailScreen,
					}),
				]
			: [...projectedDatums];

	// Seed `casedb` from the datum, then accumulate every body-reachable
	// instance in the same order as the form entry (casedb → predicate
	// instances → calc-column instances).
	const instances: EntryInstance[] = [];
	const seen = new Set<string>();
	for (const datum of datums) {
		if (datum.instanceId !== undefined && !seen.has(datum.instanceId)) {
			seen.add(datum.instanceId);
			instances.push({ id: datum.instanceId, src: datum.instanceSrc ?? "" });
		}
		for (const id of datum.query?.instances ?? []) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
		}
		if (datum.maxSelectValue !== undefined && !seen.has(datum.id)) {
			seen.add(datum.id);
			instances.push({
				id: datum.id,
				src: instanceSourceFor(datum.id, lookupNaming),
			});
		}
		for (const id of datum.instanceIds ?? []) {
			if (seen.has(id)) continue;
			seen.add(id);
			instances.push({ id, src: instanceSourceFor(id, lookupNaming) });
		}
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
		relationContext.searchInputInstanceId,
	);

	return {
		// `formXmlns` omitted — the browse entry launches no form.
		commandId: `m${moduleIndex}-case-list`,
		localeId: `case_lists.m${moduleIndex}`,
		instances,
		session: { datums },
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
	if (d.query !== undefined) return d.query.element;
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
	if (d.detailPersistent !== undefined)
		attribs["detail-persistent"] = d.detailPersistent;
	if (d.maxSelectValue !== undefined)
		attribs["max-select-value"] = String(d.maxSelectValue);
	return el(
		d.maxSelectValue === undefined ? "datum" : "instance-datum",
		attribs,
	);
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

	const children: Element[] = op.children.map(buildStackChildElement);
	return el(op.op, attribs, children);
}

function buildStackChildElement(child: StackChild): Element {
	switch (child.type) {
		case "command":
			return el("command", { value: child.value });
		case "datum":
			return el("datum", { id: child.id, value: child.value });
		case "query":
			// Attribute order `id, value` on `<query>` and `key, ref, nodeset,
			// exclude` on `<data>` follows `xml_models.py::StackQuery` /
			// `QueryData` so the bytes diff cleanly against HQ's frame.
			return el(
				"query",
				{ id: child.id, value: child.value },
				child.data.map((data) =>
					el("data", {
						key: data.key,
						ref: data.ref,
						...(data.nodeset !== undefined && { nodeset: data.nodeset }),
						...(data.exclude !== undefined && { exclude: data.exclude }),
					}),
				),
			);
	}
}

/** The XPath a stack child carries, for instance accumulation. */
function stackChildExpressions(
	child: StackChild | MatchedChild,
): readonly string[] {
	switch (child.type) {
		case "command":
			return [];
		case "datum":
			return [child.value];
		case "query":
			return child.data.flatMap((data) => [
				data.ref,
				...(data.nodeset === undefined ? [] : [data.nodeset]),
				...(data.exclude === undefined ? [] : [data.exclude]),
			]);
	}
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

	// `<post>` precedes `<command>` (`xml_models.py::Entry.ORDER`).
	if (entry.post !== undefined) {
		children.push(entry.post.element);
	}

	children.push(
		el("command", { id: entry.commandId }, [
			commandDisplay ?? el("text", {}, [el("locale", { id: entry.localeId })]),
		]),
	);

	// HQ's regenerated suite sorts every entry's instances by id
	// (`post_process/instances.py::InstancesHelper.require_instances`);
	// emitting them in the same order keeps the local `.ccz` diffable.
	for (const inst of sortInstancesById(entry.instances)) {
		children.push(el("instance", { id: inst.id, src: inst.src }));
	}

	if (entry.session) {
		children.push(
			el("session", {}, entry.session.datums.map(buildDatumElement)),
		);
	}

	// `<assertions>` sits BETWEEN `<session>` and `<stack>`. `suite_xml/
	// xml_models.py::Entry`'s `ORDER` names only `form, post, command,
	// instance, datums` and leaves the rest to field-declaration order, so the
	// binding statement of that order is the whole-suite fixture
	// `tests/data/case_list_form/case-list-form-suite-usercase.xml`, which is
	// the one oracle carrying both blocks at once.
	if (entry.assertions !== undefined && entry.assertions.length > 0) {
		children.push(
			el(
				"assertions",
				{},
				entry.assertions.map((assertion) =>
					el("assert", { test: assertion.test }, [
						el("text", {}, [el("locale", { id: assertion.localeId })]),
					]),
				),
			),
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

/** Python's plain string sort: by code unit, never locale-aware. */
function sortInstancesById(
	instances: readonly EntryInstance[],
): EntryInstance[] {
	return [...instances].sort((left, right) =>
		left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
	);
}

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

const NOVA_TO_HQ: Record<PostSubmitDestination, string> = {
	app_home: "default",
	module: "module",
	previous: "previous_screen",
};

export function toHqWorkflow(postSubmit: PostSubmitDestination): string {
	return NOVA_TO_HQ[postSubmit];
}
