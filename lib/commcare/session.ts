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
 */

import type { Element } from "domhandler";
import {
	el,
	text,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import type {
	CaseTileGrouping,
	FormType,
	PostSubmitDestination,
} from "@/lib/domain";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type { ModuleExpressionContexts } from "./expressionContext";
import type { MatchedChild, ProjectedFormLinks } from "./formLinkProjection";
import { validateCaseType } from "./identifierValidation";
import type { LookupWireNaming } from "./lookup/naming";
import { subcaseSessionDatumId } from "./subcaseWire";
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
import { w } from "./xpath/wire/builders";
import {
	caseDbInstance,
	type InstanceDecl,
	InstanceSink,
	resultsInstance,
	selectedCasesInstance,
	sessionInstance,
} from "./xpath/wire/instances";
import type { WireExpr } from "./xpath/wire/tree";

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
 *     Its tree roots carry the declarations of the instances it reads.
 *   - **Function datum** — case-creating forms (registration / subcase).
 *     Carries `function` (typically `uuid()`), which CommCare evaluates
 *     once at entry to mint a fresh id for the case the form will
 *     create. No nodeset, no value, no instance dependency.
 *
 * Mutually exclusive on the wire: a datum is one shape or the other.
 * The renderer (`buildDatumElement`) branches on whether `function` is set.
 */
export interface SessionDatum {
	id: string;
	/** Entry-plan presence without a lowered selector. Never render on wire. */
	readonly projectionOnlySelection?: true;
	/** Required for nodeset datums; omitted for function datums. */
	nodeset?: WireExpr;
	/** Required for nodeset datums; omitted for function datums. */
	value?: WireExpr;
	/**
	 * The XPath function CommCare evaluates once at entry. Set for
	 * function datums (case-create's `uuid()`); omitted for nodeset
	 * datums. Sourced from CCHQ's `EntriesHelper.get_new_case_id_datums_meta`.
	 */
	function?: WireExpr;
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
	renderFunction?: (sessionRef: (datumId: string) => WireExpr) => WireExpr;
	/** A grouped companion regenerated through the matched manual datum tree. */
	renderFormLinkFunction?: (
		sessionRef: (datumId: string) => WireExpr,
	) => WireExpr;
	/** Structural regeneration hook used when HQ-style root-menu alignment
	 * renames a datum. Never rendered. */
	renderNodeset?: (parentSelection?: SessionDatum) => WireExpr;
	/** The immediately preceding selection in a parent-select chain. */
	parentSelection?: SessionDatum;
	/**
	 * Present on the `<query>` session child of a search-first module. The
	 * datum's `id` is the storage instance the search fills
	 * (`results:inline`), which is also the id HQ's end-of-form workflow
	 * gives the frame child it derives from it (`workflow.py::WorkflowQueryMeta`).
	 * No nodeset, value, or detail: the element is rendered as is.
	 */
	query?: SessionQuery | SessionQueryProjection;
}

/**
 * The search a search-first module runs inside its entries, immediately
 * before the case datum that reads its results (CCHQ's
 * `EntriesHelper.add_remote_query_datums`).
 */
export interface SessionQueryMetadata {
	readonly storageInstance: "results:inline";
	/** The module's case type, the query's first `<data key="case_type">`. */
	readonly caseType: string;
	/** Whether the worker answers anything. With no visible prompt the
	 *  search runs on its own (`default_search`), and HQ then treats the
	 *  query as a selecting step in frames (`WorkflowQueryMeta.requires_selection`). */
	readonly hasPrompts: boolean;
	readonly defaultSearch: boolean;
}

export interface SessionQueryProjection extends SessionQueryMetadata {
	readonly projectionOnly: true;
}

export interface SessionQuery extends SessionQueryMetadata {
	/** The rendered `<query>` element. */
	readonly element: Element;
	/** Instances the query body reads, declared on the surrounding entry. */
	readonly instances: readonly InstanceDecl[];
}

export function sessionDatumRequiresSelection(datum: SessionDatum): boolean {
	return datum.projectionOnlySelection === true || datum.nodeset !== undefined;
}

/** A secondary instance required by a form entry. */
export type EntryInstance = InstanceDecl;

/** A rendered claim `<post>` and the instances its XPath reads. */
export interface EntryPost {
	readonly element: Element;
	readonly instances: readonly InstanceDecl[];
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
	readonly ref: WireExpr;
	readonly nodeset?: WireExpr;
	readonly exclude?: WireExpr;
}

/** A child element of a <create> or <push> operation. */
export type StackChild =
	| { type: "command"; value: WireExpr }
	| { type: "datum"; id: string; value: WireExpr }
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
	ifClause?: WireExpr;
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
	instances: readonly EntryInstance[];
	session?: { datums: SessionDatum[] };
	/**
	 * Entry-time guards CommCare evaluates before the form opens. Present only
	 * for the worker's own case today: HQ pairs the computed `usercase_id`
	 * datum with `count(...) = 1` over the same selector
	 * (`EntriesHelper.add_usercase_id_assertion`), so a device whose restore
	 * carries no usercase is stopped at the door rather than submitting a write
	 * that lands nowhere.
	 */
	assertions?: Array<{ test: WireExpr; localeId: string }>;
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
	caseListFilter: Expression | undefined,
	excludedOwnerIds: Expression | undefined,
	expressions: ModuleExpressionContexts,
	lookupNaming?: LookupWireNaming,
): WireExpr {
	const filter = emitNodesetFilter(
		caseListFilter,
		expressions({ slot: "case_list_filter" }),
		lookupNaming,
	);
	const owners = emitExcludedOwnerNodesetFilter(
		excludedOwnerIds,
		expressions({ slot: "excluded_owner_ids" }),
		lookupNaming,
	);
	return w.instance(caseDbInstance(), [
		w.step("casedb"),
		w.step("case", [
			w.eq(w.context([w.attr("case_type")]), w.str(validateCaseType(caseType))),
			w.eq(w.context([w.attr("status")]), w.str("open")),
			...(filter === undefined ? [] : [filter]),
			...(owners === undefined ? [] : [owners]),
		]),
	]);
}

export function inlineSearchNodeset(
	caseType: string,
	caseListFilter: Expression | undefined,
	expressions: ModuleExpressionContexts,
	lookupNaming?: LookupWireNaming,
): WireExpr {
	const filter = emitNodesetFilter(
		caseListFilter,
		expressions({ slot: "case_list_filter" }),
		lookupNaming,
	);
	return w.instance(resultsInstance("results:inline"), [
		w.step("results"),
		w.step("case", [
			w.eq(w.context([w.attr("case_type")]), w.str(validateCaseType(caseType))),
			w.eq(w.context([w.attr("status")]), w.str("open")),
			...(filter === undefined ? [] : [filter]),
			EXCLUDE_RELATED_CASES_FILTER,
		]),
	]);
}

export const INLINE_SEARCH_RESULTS_INSTANCE = "results:inline";
export const INLINE_SEARCH_RESULTS_SRC = "jr://instance/remote/results:inline";
export const EXCLUDE_RELATED_CASES_FILTER = w.not(
	w.eq(w.context([w.step("commcare_is_related_case")]), w.call("true")),
);

function sessionRef(datumId: string): WireExpr {
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(datumId),
	]);
}
function selectedValues(datumId: string): WireExpr {
	return w.instance(selectedCasesInstance(datumId), [
		w.step("results"),
		w.step("value"),
	]);
}

/** Build one selectable case datum. Nested-menu projection uses this for
 * every step in a parent-select chain, while the flat helper below keeps the
 * historical single-`case_id` default. */
export function deriveCaseSelectionDatum(args: {
	readonly id: string;
	readonly caseType: string;
	readonly moduleIndex: number;
	readonly caseListFilter?: Expression;
	readonly excludedOwnerIds?: Expression;
	readonly expressions: ModuleExpressionContexts;
	readonly lookupNaming?: LookupWireNaming;
	readonly persistentDetailId?: string;
	readonly parentSelection?: SessionDatum;
	readonly detailConfirm?: boolean;
	readonly maxSelectValue?: number;
	/** Where the selectable cases come from: the device's casedb, or the
	 *  results of a search-first module's own search. */
	readonly caseSource?: "casedb" | "results:inline";
	/** The owner frame algorithm needs identity and presence, not XPath. */
	readonly entryMetadataOnly?: boolean;
}): SessionDatum {
	const selection = {
		id: args.id,
		caseType: args.caseType,
		...(args.maxSelectValue !== undefined && {
			maxSelectValue: args.maxSelectValue,
		}),
	};
	if (args.entryMetadataOnly)
		return { ...selection, projectionOnlySelection: true };
	const inline = args.caseSource === "results:inline";
	const base = inline
		? inlineSearchNodeset(
				args.caseType,
				args.caseListFilter,
				args.expressions,
				args.lookupNaming,
			)
		: caseLoadingNodeset(
				args.caseType,
				args.caseListFilter,
				args.excludedOwnerIds,
				args.expressions,
				args.lookupNaming,
			);
	const renderNodeset = (parentSelection?: SessionDatum): WireExpr => {
		if (parentSelection === undefined) return base;
		if (base.k !== "path")
			throw new Error("A case selector must remain a generated path.");
		const parentIndexes = (predicates: readonly WireExpr[] = []) =>
			w.context([
				w.step("index"),
				w.wildcard([
					w.not(w.eq(w.context([w.attr("relationship")]), w.str("extension"))),
					...predicates,
				]),
			]);
		const parentFilter =
			parentSelection.maxSelectValue === undefined
				? w.eq(parentIndexes(), sessionRef(parentSelection.id))
				: w.gt(
						w.call("count", [
							parentIndexes([
								w.call("selected", [
									w.call("join", [
										w.str(" "),
										selectedValues(parentSelection.id),
									]),
									w.context([w.self()]),
								]),
							]),
						]),
						w.num(0),
					);
		return w.path(
			base.root,
			base.steps.map((step, index) =>
				index === base.steps.length - 1
					? { ...step, predicates: [...step.predicates, parentFilter] }
					: step,
			),
		);
	};
	return {
		...selection,
		nodeset: renderNodeset(args.parentSelection),
		renderNodeset,
		value: w.context([w.self(), w.attr("case_id")]),
		detailSelect: `m${args.moduleIndex}_case_short`,
		...(args.detailConfirm === true && {
			detailConfirm: `m${args.moduleIndex}_case_long`,
		}),
		...(args.persistentDetailId !== undefined && {
			detailPersistent: args.persistentDetailId,
		}),
	};
}

/**
 * The id of the function datum a registration form's entry mints its new
 * case's id into: `case_id_new_<type>_0`, the spelling HQ's suite gives the
 * form's own create (`models/forms.py::Form.session_var_for_action`). The
 * entry's datum and every in-form read of the new case's id come from this
 * one function, so the two cannot name different datums.
 */
export function newCaseIdDatumId(caseType: string): string {
	return `case_id_new_${validateCaseType(caseType)}_0`;
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
 *   3. One `case_id_new_<subcasetype>_<idx>` function datum per
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
	readonly caseListFilter?: Expression;
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
	readonly excludedOwnerIds?: Expression;
	readonly expressions: ModuleExpressionContexts;
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
		expressions,
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
					expressions,
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
		if (opensCase && caseType) {
			datums.push({
				id: newCaseIdDatumId(caseType),
				function: w.call("uuid"),
				caseType,
			});
		}

		// (3) HQ's get_new_case_id_datums_meta includes every non-repeat
		// subcase, even condition=never. Extension actions use that metadata
		// while their active transactions live in the source XForm. Filtering
		// inactive actions here would strand source ID seeds and form links.
		//
		// HQ also emits this scalar `uuid()` datum on a multi-select form even
		// though Nova's authored XForm creates one child per selected parent with
		// its own `uuid()` calculate. It therefore remains an inert parity datum:
		// no case block consumes it, and the absolute multi-select validator
		// refuses a direct form link that would mistake it for one created child.
		for (let i = 0; i < actions.subcases.length; i++) {
			const sc = actions.subcases[i];
			if (sc.repeat_context) continue;
			datums.push({
				id: subcaseSessionDatumId(sc, i, opensCase),
				function: w.call("uuid"),
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
			(datum) =>
				sessionDatumRequiresSelection(datum) && datum.caseType === caseType,
		);
	if (tileGrouping !== undefined && caseSelectDatum !== undefined) {
		const renderFunction = (
			sessionRef: (datumId: string) => WireExpr,
		): WireExpr => {
			const predicate =
				caseSelectDatum.maxSelectValue === undefined
					? w.eq(w.context([w.attr("case_id")]), sessionRef(caseSelectDatum.id))
					: w.call("selected", [
							w.call("join", [w.str(" "), selectedValues(caseSelectDatum.id)]),
							w.context([w.attr("case_id")]),
						]);
			return w.call("join", [
				w.str(" "),
				w.call("distinct-values", [
					w.instance(caseDbInstance(), [
						w.step("casedb"),
						w.step("case", [predicate]),
						w.step("index"),
						w.step(tileGrouping.identifier),
					]),
				]),
			]);
		};
		datums.push({
			id: `${caseSelectDatum.id}_parent_ids`,
			function: renderFunction(sessionRef),
			renderFunction,
			renderFormLinkFunction: renderFunction,
		});
	}

	return datums;
}

/** A projected frame child as the suite's `<create>` child. */
export function toStackChild(child: MatchedChild): StackChild {
	switch (child.type) {
		case "command":
			return { type: "command", value: w.str(child.id) };
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
 * HQ's `workflow.py::EndOfFormNavigationWorkflow::_get_static_stack_frame`:
 *
 * | Destination  | HQ workflow       | Operation                                         |
 * |--------------|-------------------|---------------------------------------------------|
 * | `app_home`   | `default`         | nothing (no frame; the form frame pops to home)    |
 * | `firstMenu`  | `root`            | one `<create/>` with no children                   |
 * | `module`     | `module`          | `<create>` carrying `moduleFrame`                  |
 * | `parentMenu` | `parent_module`   | `<create>` carrying `parentFrame`                  |
 * | `previous`   | `previous_screen` | `<create>` carrying `previousFrame`                |
 *
 * `previousFrame` is the source entry's own frame children with the last
 * child and every trailing computed datum popped, derived by
 * `formLinkProjection.ts::previousFrameChildren`, never guessed here from
 * the form type. `parentFrame` is the parent module's frame with its
 * selections (`formLinkProjection.ts::parentMenuDestinationFrameChildren`).
 * HQ writes an empty frame for `root` alone (`allow_empty_frame`) and drops
 * every other childless frame, so a childless `previous` or `parentMenu`
 * emits nothing.
 */
export function derivePostSubmitStack(
	postSubmit: PostSubmitDestination,
	moduleIndex: number,
	previousFrame: readonly MatchedChild[],
	moduleFrame: readonly MatchedChild[] = [
		{ type: "command", id: `m${moduleIndex}` },
	],
	parentFrame: readonly MatchedChild[] = [],
): StackOperation[] {
	const frame = (children: readonly MatchedChild[]): StackOperation[] =>
		children.length === 0
			? []
			: [{ op: "create", children: children.map(toStackChild) }];
	switch (postSubmit) {
		case "app_home":
			return [];
		case "firstMenu":
			return [{ op: "create", children: [] }];
		case "module":
			return [{ op: "create", children: moduleFrame.map(toStackChild) }];
		case "parentMenu":
			return frame(parentFrame);
		case "previous":
			return frame(previousFrame);
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
	parentFrame?: readonly MatchedChild[],
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
			parentFrame,
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
	/**
	 * The parent module's frame with its selections, read whenever
	 * `postSubmit` (or the links' fallback) is `parentMenu`. Omitted, a
	 * `parentMenu` destination emits no frame.
	 */
	readonly parentFrame?: readonly MatchedChild[];
	/** Fully projected session, including root-menu alignment. */
	readonly projectedSessionDatums?: readonly SessionDatum[];
	/** Dependencies from the exact rendered details and menu command this entry evaluates. */
	readonly additionalInstances?: readonly InstanceDecl[];
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
		readonly ifClause: WireExpr;
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
		parentFrame,
		projectedSessionDatums,
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
	// The stack: one exclusive `<create>` per link plus the projection's
	// fallback when the form carries links, else the simple `postSubmit`
	// frame. `app_home` (HQ `default`) contributes no frame either way, so a
	// form with no links and `app_home` emits no `<stack>` at all — CommCare
	// pops the form frame and lands home.
	const operations: StackOperation[] = [
		...(formLinks !== undefined
			? deriveFormLinkStack(
					formLinks,
					postSubmit,
					moduleIndex,
					previousFrame,
					moduleFrame,
					parentFrame,
				)
			: derivePostSubmitStack(
					postSubmit,
					moduleIndex,
					previousFrame,
					moduleFrame,
					parentFrame,
				)),
		// The compiler supplies this only for the implicit no-matches return.
		// A no-matches form's explicit `firstMenu` writes its one empty frame
		// above and no return, matching HQ WorkflowHelper._get_stack_frames
		// precedence.
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
	const assertions = datums.some((datum) => datum.id === USERCASE_DATUM_ID)
		? [
				{
					test: USERCASE_MISSING_ASSERT_TEST,
					localeId: USERCASE_MISSING_LOCALE_ID,
				},
			]
		: undefined;
	const instances = entryInstances(
		datums,
		operations,
		assertions ?? [],
		args.additionalInstances ?? [],
		args.post,
	);

	return {
		formXmlns,
		...(args.post !== undefined && { post: args.post }),
		commandId,
		localeId,
		instances,
		...(datums.length > 0 && { session: { datums } }),
		...(assertions === undefined ? {} : { assertions }),
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
 * The caller supplies the exact declarations returned by the rendered
 * details this entry loads. Their action, sort, and column reads therefore
 * share this entry's scope without a second walk of the authored document.
 */
export function deriveCaseListEntryDefinition(
	moduleIndex: number,
	caseType: string,
	caseListFilter: Expression | undefined,
	hasDetailScreen = true,
	excludedOwnerIds: Expression | undefined,
	expressions: ModuleExpressionContexts,
	lookupNaming?: LookupWireNaming,
	persistentDetailId?: string,
	projectedDatums?: readonly SessionDatum[],
	additionalInstances: readonly InstanceDecl[] = [],
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
						expressions,
						lookupNaming,
						persistentDetailId,
						detailConfirm: hasDetailScreen,
					}),
				]
			: [...projectedDatums];

	const instances = entryInstances(datums, [], [], additionalInstances);

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
function assertEmittableSessionDatum(
	d: SessionDatum,
): asserts d is SessionDatum & { query?: SessionQuery } {
	if (
		d.projectionOnlySelection ||
		(d.query !== undefined && "projectionOnly" in d.query)
	)
		throw new Error(
			"Entry-plan metadata cannot be rendered as a session datum.",
		);
}

function wireContext(instances: InstanceSink): WireElementContext {
	return {
		mode: { target: "suite" },
		instances,
	};
}

function buildDatumElement(
	d: SessionDatum,
	context: WireElementContext,
): Element {
	assertEmittableSessionDatum(d);
	if (d.query !== undefined) {
		context.instances.add(d.query.instances);
		return d.query.element;
	}
	if (d.function !== undefined)
		return xel(
			"datum",
			{ attributes: { id: d.id }, xpath: { function: d.function } },
			context,
		);
	if (d.nodeset === undefined || d.value === undefined)
		throw new Error(
			"A selectable session datum needs its nodeset and selected value before emission.",
		);
	return xel(
		d.maxSelectValue === undefined ? "datum" : "instance-datum",
		{
			attributes: {
				id: d.id,
				...(d.detailSelect === undefined
					? {}
					: { "detail-select": d.detailSelect }),
				...(d.detailConfirm === undefined
					? {}
					: { "detail-confirm": d.detailConfirm }),
				...(d.detailPersistent === undefined
					? {}
					: { "detail-persistent": d.detailPersistent }),
				...(d.maxSelectValue === undefined
					? {}
					: { "max-select-value": String(d.maxSelectValue) }),
			},
			xpath: { nodeset: d.nodeset, value: d.value },
		},
		context,
	);
}

function buildStackOperationElement(
	op: StackOperation,
	context: WireElementContext,
): Element {
	return xel(
		op.op,
		{
			...(op.ifClause === undefined ? {} : { xpath: { if: op.ifClause } }),
		},
		context,
		op.op === "clear"
			? []
			: op.children.map((child) => buildStackChildElement(child, context)),
	);
}

function buildStackChildElement(
	child: StackChild,
	context: WireElementContext,
): Element {
	switch (child.type) {
		case "command":
			return xel("command", { xpath: { value: child.value } }, context);
		case "datum":
			return xel(
				"datum",
				{
					attributes: { id: child.id },
					xpath: { value: child.value },
				},
				context,
			);
		case "query":
			return el(
				"query",
				{ id: child.id, value: child.value },
				child.data.map((data) =>
					xel(
						"data",
						{
							attributes: { key: data.key },
							xpath: {
								ref: data.ref,
								...(data.nodeset === undefined
									? {}
									: { nodeset: data.nodeset }),
								...(data.exclude === undefined
									? {}
									: { exclude: data.exclude }),
							},
						},
						context,
					),
				),
			);
	}
}

/** Dependencies are the output of printing the same trees the entry renders. */
function entryInstances(
	datums: readonly SessionDatum[],
	operations: readonly StackOperation[],
	assertions: readonly { test: WireExpr; localeId: string }[],
	additional: readonly InstanceDecl[],
	post?: EntryPost,
): readonly InstanceDecl[] {
	const sink = new InstanceSink(additional);
	const context = wireContext(sink);
	for (const datum of datums) buildDatumElement(datum, context);
	for (const operation of operations)
		buildStackOperationElement(operation, context);
	for (const assertion of assertions)
		xel("assert", { xpath: { test: assertion.test } }, context);
	sink.add(post?.instances ?? []);
	return sink.declarations();
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
	context: WireElementContext = wireContext(new InstanceSink()),
): Element | null {
	if (operations.length === 0) return null;
	return el(
		"stack",
		{},
		operations.map((operation) =>
			buildStackOperationElement(operation, context),
		),
	);
}

/**
 * Build an `<entry>` Element from a derived entry definition. The orchestrator
 * (`compiler.ts`) splices the returned Element into the suite.xml tree and
 * serializes the entire suite once via `serializeXml`.
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
 * media locales when it does. When omitted,
 * the command falls back to a bare `<text><locale/></text>` synthesized
 * from `entry.localeId`.
 */
export function buildEntryElement(
	entry: EntryDefinition,
	commandDisplay?: Element,
): Element {
	const sink = new InstanceSink(entry.instances);
	const context = wireContext(sink);
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

	const instanceIndex = children.length;

	if (entry.session) {
		children.push(
			el(
				"session",
				{},
				entry.session.datums.map((datum) => buildDatumElement(datum, context)),
			),
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
					xel("assert", { xpath: { test: assertion.test } }, context, [
						el("text", {}, [el("locale", { id: assertion.localeId })]),
					]),
				),
			),
		);
	}

	if (entry.stack) {
		const stackEl = buildStackElement(entry.stack.operations, context);
		if (stackEl !== null) children.push(stackEl);
	}

	sink.add(entry.post?.instances ?? []);
	children.splice(
		instanceIndex,
		0,
		...sink
			.declarations()
			.map((instance) =>
				el("instance", { id: instance.id, src: instance.src }),
			),
	);
	return el("entry", {}, children);
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
	firstMenu: "root",
	module: "module",
	parentMenu: "parent_module",
	previous: "previous_screen",
};

export function toHqWorkflow(postSubmit: PostSubmitDestination): string {
	return NOVA_TO_HQ[postSubmit];
}
