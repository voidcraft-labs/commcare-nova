/**
 * Case-management scaffolding emission.
 *
 * `addCaseBlocks` mirrors CCHQ's server-side post-process
 * (`commcare-hq/.../app_manager/xform.py::XFormCaseBlock`) so the local CCZ
 * pipeline injects the `<case>` / `<subcase_n>` transaction blocks (plus the
 * matching `<bind>` and `<setvalue>` elements) that the mobile runtime needs
 * to read and write the case database. Every other case change rides the
 * source XForm through `caseOps.ts`, as a Save to Case block.
 *
 * The emitter CONSTRUCTS `domhandler` element trees (via the shared helpers
 * in `elementBuilders.ts`) and splices them into the form's parsed DOM, then
 * serializes the tree once with `serializeXml`. There is NO template-literal
 * XML in this module: every attribute and text value flows through `setAttribute`
 * (an `attribs` object literal) or a `Text` node, and the serializer is the
 * single, exclusive escaping authority. The earlier string-template emitter
 * leaked every interpolated XPath body, case-type name, and field path into the
 * output unescaped — the validator gates closed that gap reactively, but the
 * shared serializer handles escaping and element nesting. Wire regression
 * tests validate syntax before examining the emitted tree.
 *
 * The `<case>` element carries three attributes JavaRosa needs at submission
 * time — `case_id`, `date_modified`, `user_id` — plus the cx2 namespace. The
 * submission processor finds case blocks by namespace-qualified match, so a
 * `<case>` outside the cx2 namespace is treated as an inert data node, not a
 * case transaction. Mirrors `XFormCaseBlock.elem`'s `{cx2}case` namespaced
 * construction. The three attributes wire to:
 *
 *   - case-create: `case_id` setvalues at `xforms-ready` from the per-entry
 *     session datum `case_id_new_<casetype>_0` (a `function="uuid()"` datum
 *     `session.ts::deriveSessionDatums` emits). `date_modified` / `user_id`
 *     calculate off the always-on meta block at `/data/meta/timeEnd` /
 *     `/data/meta/userID`.
 *   - case-update: `case_id` calculates from the case-loading session datum
 *     `case_id`. Same meta-block bindings for the two timestamp attributes.
 *   - subcases: per-subcase session datum `case_id_new_<subcasetype>_<idx>`
 *     (index mirrors CCHQ's `Form.session_var_for_action` — starts at 1 when
 *     the form also opens a primary case). Repeat-context subcases use a
 *     literal `uuid()` calculate instead (no session datum is emitted for
 *     them, matching CCHQ's `delay_case_id` branch).
 */

import { type ChildNode, Element } from "domhandler";
import { findOne, getChildren } from "domutils";
import type { FormActionCondition, FormActions } from "@/lib/commcare";
import {
	el,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import {
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import {
	newCaseIdDatumId,
	subcaseSessionDatumId,
} from "@/lib/commcare/session";
import { SESSION_USERCASE_ID } from "@/lib/commcare/usercaseWire";
import {
	appendChildren,
	ensureInstance,
	findDataElement,
	findModelElement,
	insertBeforeItext,
	parseXForm,
	prependChildren,
	serializeXForm,
} from "@/lib/commcare/xform/domSplice";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { w } from "../xpath/wire/builders";
import { InstanceSink, sessionInstance } from "../xpath/wire/instances";
import { caseById } from "../xpath/wire/rowScope";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";

/**
 * CommCare case-transaction XML namespace. Every `<case>` element on the wire
 * lives in this namespace — the submission processor finds case blocks by
 * namespace-qualified match, so a `<case>` outside this xmlns is treated as an
 * inert data node, not a case transaction. The xmlns declaration on `<case>`
 * propagates to its descendants by default-namespace inheritance, so
 * `<create>`, `<update>`, `<close>`, `<index>`, and the per-property children
 * all resolve into the case-transaction namespace without restatement.
 */
const CASE_TRANSACTION_XMLNS = "http://commcarehq.org/case/transaction/v2";

/**
 * HQ FormActions privately names the case-name update/preload key `name`;
 * the case transaction and casedb instance expose it as `case_name`.
 * Nova's domain never accepts `name` as a case-property destination — this
 * one-way projection exists only at the FormActions → XForm boundary.
 */
function formActionsPropertyToWire(property: string): string {
	return property === "name" ? "case_name" : property;
}

/**
 * HQ's order for a block's update children and their binds:
 * by wire property name, as `xform.py::XFormCaseBlock.add_case_updates` sorts
 * them. Python orders `str` keys by code point, and every wire property name
 * is ASCII (`lib/domain/casePropertyName.ts`), where code-unit order agrees.
 */
function byWireName(
	a: { validProp: string },
	b: { validProp: string },
): number {
	return a.validProp < b.validProp ? -1 : a.validProp > b.validProp ? 1 : 0;
}

/**
 * The structured payload `buildCaseBlocks` returns. Three siblings the caller
 * splices into the existing XForm DOM:
 *
 *   - `dataChildren` — the `<subcase_n>` elements, then the `<case>`, then
 *     the worker's record, spliced under the form's primary `<data>` node
 *     (or a repeat item) in HQ's order.
 *   - `binds` — the per-attribute and per-property `<bind>` elements appended
 *     to the form's `<model>`, alongside any other binds the main emitter
 *     produced.
 *   - `setvalues` — the `<setvalue>` elements (form-load case-id wires for
 *     non-repeat subcases, plus case-preload reads from `casedb`) appended to
 *     the form's `<model>`. Form-root scope because `xforms-ready` fires once
 *     at form load.
 *   - `requiredNamePaths` — the path every create's name action names
 *     (primary open + each subcase open), the question's trimmed sibling. The
 *     caller merges `required="true()"` onto that node's bind, as
 *     `XFormCaseBlock.add_create_block` does; it is inert on a calculated
 *     node, and the question's own requirement is the source's (`builder.ts`).
 *
 * `null` is returned when the form has no case-management actions to emit —
 * the caller short-circuits without touching the DOM.
 */
/**
 * One data-instance child the splice site needs to inject. `parentPath`
 * is the typed XPath of the element this child must be appended UNDER —
 * `/data` for the primary case and for non-repeat-context subcases; the
 * repeat element's path (e.g. `/data/children`) for repeat-context
 * subcases; or `/data/<X>/item` for `query_bound` repeats (the model-
 * iteration `<item>` template root). The walker in `addCaseBlocks`
 * resolves `parentPath` to a live DOM element and appends `element`
 * there.
 *
 * The pre-Step-9 emission collapsed both fields into a single
 * `Element[]` and the splice always appended under top-level `<data>`,
 * which is exactly the bug the typed-path foundation forecloses: when
 * the wrapper says one thing and the binds say another, the post-
 * injection XForm oracle catches it as `XFORM_DANGLING_BIND` and
 * `compileCcz` throws.
 */
interface CaseBlockChild {
	readonly parentPath: FormPath;
	readonly element: Element;
	/**
	 * Where the child stands among its parent's: a repeat's single subcase
	 * block is the first child of the repeat item, as HQ inserts it
	 * (`subcase_node.insert(0, ...)` in `xform.py::XForm._create_casexml`);
	 * every other block is appended.
	 */
	readonly position: "first" | "last";
}

interface CaseBlocksEmission {
	readonly dataChildren: ReadonlyArray<CaseBlockChild>;
	readonly binds: Element[];
	readonly setvalues: Element[];
	readonly requiredNamePaths?: string[];
}

/**
 * Construct the case-block DOM emission for a form's `FormActions`. Pure
 * builder — produces orphaned `Element` nodes the caller splices into a parent
 * tree. Returns `null` when none of the four action shapes (open / update /
 * close / subcase) is active, so the caller knows to skip the splice
 * entirely.
 *
 * Element / attribute insertion order matches CCHQ's canonical wire
 * shape: `<case>` carries `case_id`, `date_modified`, `user_id`,
 * `xmlns` in that exact order; `<bind>` elements list `nodeset` first,
 * then the kind-specific attributes (`type` before `calculate` on the
 * date_modified bind, `calculate` alone on user_id / case_id,
 * `relevant` alone on conditional binds). The serializer preserves
 * attribute insertion order, so the literal substrings the test suite
 * asserts (`<case case_id="" date_modified="" user_id="" xmlns="...">`)
 * survive.
 */
function buildCaseBlocks(
	actions: FormActions,
	caseType: string | undefined,
	selectedCaseIdRef: WireExpr,
	context: WireElementContext,
): CaseBlocksEmission | null {
	const openCase = actions.open_case;
	const updateCase = actions.update_case;
	const closeCase = actions.close_case;
	const subcases = actions.subcases;
	const openMode = openCase.condition.type;
	// `isCreate` covers both the always-create (registration) and the
	// conditional-create patterns. CCHQ treats both as active opens — the
	// `if`-typed condition lowers to a `<bind relevant>` on the <case> element
	// so JavaRosa only stamps the case-create on the wire when the condition
	// evaluates true.
	const isCreate = openMode === "always" || openMode === "if";
	const isUpdate = updateCase.condition.type === "always";
	// Single read of the close condition's discriminator — reused below when
	// deciding whether to emit a `relevant` bind.
	const closeMode = closeCase.condition.type;
	const isClose = closeMode === "always" || closeMode === "if";
	const hasSubcases = subcases.length > 0;
	// The worker's own record. Independent of every branch below: HQ emits it
	// from `XForm._add_usercase`, gated only on `usercase_update` being active
	// with a non-empty update map, so a form whose ONLY write is to the worker
	// record still emits a block.
	const usercaseAction = actions.usercase_update;
	const hasUsercaseUpdate =
		usercaseAction.condition.type === "always" &&
		Object.keys(usercaseAction.update).length > 0;

	if (
		!isCreate &&
		!isUpdate &&
		!isClose &&
		!hasSubcases &&
		!hasUsercaseUpdate
	) {
		return null;
	}

	// Per-emission accumulators. `caseChildren` is the children list of the
	// primary `<case>` element (create / update / close grandchildren); `binds`
	// + `setvalues` accumulate the per-action model-level emissions.
	const caseChildren: Element[] = [];
	const binds: Element[] = [];
	const setvalues: Element[] = [];
	// The paths every create's name action names on this form — the primary
	// open plus every subcase open. Surfaced so the caller stamps
	// `required="true()"` onto each one's bind, as HQ's build does.
	const requiredNamePaths: string[] = [];

	// Typed reference to the primary `<case>` element under `<data>`. Every
	// `/data/case/...` path the primary-case branches emit is built off this
	// one anchor, so a typo in the segment chain is a compile error rather
	// than a silent string-template divergence.
	const primaryCasePath = FormPath.root().child("case");
	// Meta-block paths the case-attribute calculates read out of. The values
	// reference the always-on meta block populated by `xform/metaBlock.ts`.
	const metaTimeEnd = FormPath.root().child("meta").child("timeEnd").toWire();
	const metaUserID = FormPath.root().child("meta").child("userID").toWire();

	// Lazy, because a form whose only write is to the worker's record has no
	// case type of its own and never reaches a branch that needs one. Eager
	// validation would refuse that form for lacking something it does not use.
	const primaryCaseType = (): string => {
		if (caseType === undefined || caseType === "") {
			throw new Error(
				"buildCaseBlocks reached a primary-case branch with no case type. " +
					"open/update/close and subcases all require the module's case type; " +
					"check the caller's FormActions against the module it came from.",
			);
		}
		return validateCaseType(caseType);
	};

	if (isCreate) {
		// `<create>` children mirror CCHQ's fixture order (case_name, owner_id,
		// case_type) — semantically the case-transaction processor reads by
		// element name, but matching the canonical shape keeps diffs against the
		// Vellum fixtures clean.
		caseChildren.push(
			el("create", {}, [
				el("case_name", {}),
				el("owner_id", {}),
				el("case_type", {}),
			]),
		);
		const primaryCreatePath = primaryCasePath.child("create");
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: primaryCreatePath.child("case_type").toWire(),
						calculate: w.str(primaryCaseType()),
					},
				},
				context,
			),
		);
		const namePath =
			openCase.name_update?.question_path ||
			FormPath.root().child("name").toXPath();
		const validatedNamePath = validateXFormPath(namePath);
		// The action names the question's trimmed sibling, so the leaf binds
		// it as it stands, as HQ's build does.
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: primaryCreatePath.child("case_name").toWire(),
						calculate: FormPath.parse(validatedNamePath).toWire(),
					},
				},
				context,
			),
		);
		// `XFormCaseBlock.add_create_block` adds `required="true()"` to the
		// bind of the path the name action names, here the trimmed sibling,
		// where it is inert; the local archive stamps it alike. The question's
		// own requirement is the source's (`builder.ts`).
		requiredNamePaths.push(validatedNamePath);
		// owner_id reads from the always-on meta block (which is itself seeded
		// from session/context at form load). Matching CCHQ's canonical shape —
		// `instance('commcaresession')/session/context/userid` resolves
		// equivalently but the fixture-shape calculate is what CCHQ Vellum emits
		// and what the Vellum round-trip preserves.
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: primaryCreatePath.child("owner_id").toWire(),
						calculate: metaUserID,
					},
				},
				context,
			),
		);
		// Wire the form's `/data/case/@case_id` to the session datum
		// `deriveSessionDatums` emits for this same `open_case` action.
		// `xforms-ready` fires once at form load — the form-side and the
		// session-side both pull their value from the same `uuid()`.
		setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: "xforms-ready" },
					xpath: {
						ref: primaryCasePath.attr("case_id").toWire(),
						value: w.instance(sessionInstance(), [
							w.step("session"),
							w.step("data"),
							w.step(newCaseIdDatumId(primaryCaseType())),
						]),
					},
				},
				context,
			),
		);
		// Conditional-open forms get a `<bind relevant>` on the case element.
		// Same operator dispatch as the close condition below.
		if (openMode === "if" && openCase.condition.question) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: primaryCasePath.toWire(),
							relevant: conditionToRelevantXPath(openCase.condition),
						},
					},
					context,
				),
			);
		}
	} else if (isUpdate || isClose || hasSubcases) {
		// Case-update / case-close: no `<create>` block, but the case_id still
		// wires to the case-loading session datum so the case-update block on
		// the wire knows which case it's editing.
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: primaryCasePath.attr("case_id").toWire(),
						calculate: selectedCaseIdRef,
					},
				},
				context,
			),
		);
	}

	// The update map's keys split as HQ's build splits them
	// (`xform.py::XForm._add_case_updates`, `util.py::split_path`): a key with
	// no `/` writes the form's own case; `parent/p` or `parent/host/p` writes
	// the case those indices reach, from a block of its own under
	// `<parents>`.
	const ownUpdates: (readonly [string, UpdateMapping])[] = [];
	const updatesByAncestor = new Map<
		string,
		(readonly [string, UpdateMapping])[]
	>();
	if (isUpdate) {
		for (const [key, mapping] of Object.entries(updateCase.update)) {
			const steps = key.split("/");
			const property = steps.pop() ?? key;
			const ancestor = steps.join("/");
			if (ancestor === "") ownUpdates.push([property, mapping]);
			else
				updatesByAncestor.set(ancestor, [
					...(updatesByAncestor.get(ancestor) ?? []),
					[property, mapping],
				]);
		}
	}
	let parentsElement: Element | undefined;
	if (updatesByAncestor.size > 0) {
		// Each case above the form's own takes a block under
		// `/data/parents/<index>/…/case`, its id the index chain read from the
		// case database (`xform.py::get_case_parent_id_xpath`), in the order
		// of its index path, as `XForm._add_case_updates` writes them. HQ
		// builds each chain afresh, so two paths that share a first index
		// stand in two elements of that name.
		const parentsPath = FormPath.root().child("parents");
		const chains: Element[] = [];
		for (const [ancestor, updates] of [...updatesByAncestor].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			const steps = ancestor.split("/");
			let nodePath = parentsPath;
			let id = selectedCaseIdRef;
			for (const step of steps) {
				nodePath = nodePath.child(step);
				id = w.append(caseById(id, "casedb"), [
					w.step("index"),
					w.step(validatePropertyName(step)),
				]);
			}
			const casePath = nodePath.child("case");
			binds.push(
				...caseMetaBinds(casePath, context),
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.attr("case_id").toWire(),
							calculate: id,
						},
					},
					context,
				),
			);
			let chain = buildCaseElement([
				updateBlock(casePath, updates, binds, context),
			]);
			for (const step of [...steps].reverse()) chain = el(step, {}, [chain]);
			chains.push(chain);
		}
		parentsElement = el("parents", {}, chains);
	}
	if (ownUpdates.length > 0) {
		// `<update>` stands exactly when the update map holds an entry: HQ's
		// `XForm._add_case_updates` reaches `XFormCaseBlock.update_block` only
		// for a non-empty map, so a follow-up that writes nothing carries the
		// bare block that touches its case.
		//
		// Every write is an `<update>` child. HQ's build makes an update
		// whose question path is an upload question an `<attachment>`
		// (`xform.py::XFormCaseBlock.add_case_updates`, `::is_attachment`),
		// and no action names one: a capture's write names its link sibling
		// (`casePlacementPlan.ts`).
		caseChildren.push(updateBlock(primaryCasePath, ownUpdates, binds, context));
	}

	if (isClose) {
		caseChildren.push(el("close", {}));
		// Conditional close requires a `relevant` expression on the `<close/>`
		// bind; "selected" operators produce `selected(path, answer)` while the
		// default equality operator produces `path = 'answer'`.
		if (closeMode === "if" && closeCase.condition.question) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: primaryCasePath.child("close").toWire(),
							relevant: conditionToRelevantXPath(closeCase.condition),
						},
					},
					context,
				),
			);
		}
	}

	// A child-create-only followup still needs its selected parent block:
	// every child index reads /data/case/@case_id. HQ bind_case_id likewise
	// materializes this empty transaction even without parent property writes.
	// The block is spliced after the subcase blocks and before the worker's
	// record, the order `XForm._create_casexml` and `_add_usercase` leave the
	// data node in; Core applies blocks in document order.
	const dataChildren: CaseBlockChild[] = [];
	if (parentsElement !== undefined)
		dataChildren.push({
			parentPath: FormPath.root(),
			element: parentsElement,
			position: "last",
		});
	const hasPrimaryBlock = isCreate || isUpdate || isClose || hasSubcases;
	if (hasPrimaryBlock) {
		// `<case>` attribute binds read out of the always-on /data/meta block
		// (populated by setvalues from session/context at form load + on every
		// revalidate for timeEnd). The meta block ships with every Nova-emitted
		// form, so these references resolve.
		binds.push(
			xel(
				"bind",
				{
					attributes: { type: "xsd:dateTime" },
					xpath: {
						nodeset: primaryCasePath.attr("date_modified").toWire(),
						calculate: metaTimeEnd,
					},
				},
				context,
			),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: primaryCasePath.attr("user_id").toWire(),
						calculate: metaUserID,
					},
				},
				context,
			),
		);
	}

	// Pre-pass: count active subcases per repeat_context. Mirrors CCHQ's
	// `Form.actions.count_subcases_per_repeat_context` Counter. Used below
	// to pick the `nest` branch — when multiple subcases share one repeat,
	// each gets its own `<subcase_N>` wrapper; when a single subcase lives
	// inside a repeat, the `<case>` element splices DIRECTLY into the
	// repeat (the `subcase-repeat.xml` shape) with no wrapper.
	//
	// Counts only ACTIVE subcases (condition is always/if) — inactive ones
	// don't emit anyway, so they don't tip the nest decision.
	const subcasesPerRepeatCtx = new Map<string, number>();
	for (const sc of subcases) {
		if (sc.condition.type !== "always" && sc.condition.type !== "if") continue;
		const ctx = sc.repeat_context ?? "";
		if (!ctx) continue;
		subcasesPerRepeatCtx.set(ctx, (subcasesPerRepeatCtx.get(ctx) ?? 0) + 1);
	}

	// Subcases — each child-case creation gets a dedicated element named
	// `subcase_{n}` (or, when it's the sole subcase in a repeat, the
	// `<case>` element directly inside the repeat with no wrapper).
	for (let sIdx = 0; sIdx < subcases.length; sIdx++) {
		const sc = subcases[sIdx];
		if (sc.condition.type !== "always" && sc.condition.type !== "if") {
			continue;
		}

		// `repeat_context` arrives as the wire-format XPath string emitted by
		// `formActions.ts::buildFormActions` (e.g. `/data/children` for
		// user_controlled / count_bound, `/data/children/item` for
		// query_bound). Empty string means "no repeat scope" — splice the
		// wrapper under <data>.
		const repeatCtxPath = sc.repeat_context
			? FormPath.parse(sc.repeat_context)
			: null;
		// `nest` decision: mirrors CCHQ's
		// `nest = repeat_context_count[subcase.repeat_context] > 1` in
		// `xform.py::_create_casexml`. Non-repeat-context subcases always
		// nest under `<subcase_N>` (existing shape). For repeat-context
		// subcases, a single subcase per repeat splices `<case>` directly
		// into the repeat element; multiple subcases per repeat each get
		// their own `<subcase_N>` wrapper inside the repeat.
		const nest =
			!repeatCtxPath ||
			(subcasesPerRepeatCtx.get(sc.repeat_context ?? "") ?? 0) > 1;
		const elName = `subcase_${sIdx}`;
		// `basePath` is where bind nodesets anchor. With a `<subcase_N>`
		// wrapper, binds anchor at `<repeatCtx>/<subcase_N>` (or
		// `/data/<subcase_N>` for non-repeat-context). Without a wrapper
		// (nest=false), binds anchor at the repeat element itself
		// (`<repeatCtx>`).
		const basePath = nest
			? (repeatCtxPath ?? FormPath.root()).child(elName)
			: // nest=false implies repeatCtxPath is non-null (the only way
				// nest comes out false is when subcasesPerRepeatCtx counts a
				// single subcase under a real repeat_context).
				(repeatCtxPath as FormPath);
		const subcaseCasePath = basePath.child("case");
		const validatedSubcaseType = validateCaseType(sc.case_type);
		const subcaseDatumId = subcaseSessionDatumId(sc, sIdx, isCreate);

		const scChildren: Element[] = [];
		// Subcase `<create>` mirrors the primary case's child order (case_name,
		// owner_id, case_type) for fixture parity.
		scChildren.push(
			el("create", {}, [
				el("case_name", {}),
				el("owner_id", {}),
				el("case_type", {}),
			]),
		);
		const subcaseCreatePath = subcaseCasePath.child("create");
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: subcaseCreatePath.child("case_type").toWire(),
						calculate: w.str(validatedSubcaseType),
					},
				},
				context,
			),
		);
		const namePath = validateXFormPath(
			sc.name_update?.question_path || basePath.child("name").toXPath(),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: subcaseCreatePath.child("case_name").toWire(),
						calculate: FormPath.parse(namePath).toWire(),
					},
				},
				context,
			),
		);
		// `add_create_block` runs the same `required="true()"` stamp on the
		// subcase's name action path. Surface the path for the merge.
		requiredNamePaths.push(namePath);
		// Owner-id binds to the submitting user. The basic module Nova uploads
		// always autosets the owner via `autoset_owner_id_for_subcase`
		// (`'owner_id' not in case_properties`, relationship-independent), so
		// CCHQ's regenerated form carries this userID bind on EVERY subcase —
		// child and extension alike. (The unowned-extension sentinel is an
		// advanced-module-only shape Nova never emits.) The `extension`
		// relationship is carried solely on the `<index>` below.
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: subcaseCreatePath.child("owner_id").toWire(),
						calculate: metaUserID,
					},
				},
				context,
			),
		);

		// Wire the subcase's `@case_id`. When the subcase lives in a repeat,
		// setvalues won't fire per-iteration AND the session datum isn't emitted
		// for repeat-context subcases (CCHQ skips them in
		// `EntriesHelper.get_new_case_id_datums_meta`); each iteration mints its
		// own id via a bare `uuid()` calculate. Mirrors CCHQ's
		// `delay_case_id=True` branch in `XFormCaseBlock.add_create_block`,
		// which routes `case_id='uuid()'` through `add_setvalue_or_bind` to emit
		// a calculate bind.
		const subcaseCaseIdAttr = subcaseCasePath.attr("case_id").toWire();
		if (repeatCtxPath) {
			binds.push(
				xel(
					"bind",
					{ xpath: { nodeset: subcaseCaseIdAttr, calculate: w.call("uuid") } },
					context,
				),
			);
		} else {
			setvalues.push(
				xel(
					"setvalue",
					{
						attributes: { event: "xforms-ready" },
						xpath: {
							ref: subcaseCaseIdAttr,
							value: w.instance(sessionInstance(), [
								w.step("session"),
								w.step("data"),
								w.step(subcaseDatumId),
							]),
						},
					},
					context,
				),
			);
		}

		// Subcase case-attribute binds — same shape as the primary case.
		binds.push(
			xel(
				"bind",
				{
					attributes: { type: "xsd:dateTime" },
					xpath: {
						nodeset: subcaseCasePath.attr("date_modified").toWire(),
						calculate: metaTimeEnd,
					},
				},
				context,
			),
		);
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: subcaseCasePath.attr("user_id").toWire(),
						calculate: metaUserID,
					},
				},
				context,
			),
		);

		// Conditional subcase create — `<bind relevant>` on the subcase case
		// element.
		if (sc.condition.type === "if" && sc.condition.question) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: subcaseCasePath.toWire(),
							relevant: conditionToRelevantXPath(sc.condition),
						},
					},
					context,
				),
			);
		}

		// Subcase child-element order on the wire is `create / update / index`
		// (canonical: `subcase-parent-ref.xml` and `multiple_subcase_repeat.xml`).
		// `<create>` was pushed at the top of this iteration; `<update>` is
		// pushed here unconditionally (CCHQ's memoized-update side-effect);
		// `<index>` follows. The receiver iterates children order-agnostic but
		// matching the wire order keeps byte-level parity with the canonical
		// fixtures and forecloses any future order-sensitive CCHQ-side check.

		// Always emit `<update/>` on the subcase wrapper — CCHQ does the
		// same on every subcase regardless of case_properties count (via
		// `XFormCaseBlock.update_block`'s memoized side-effect). Matching
		// preserves byte-level parity with `multiple_subcase_repeat.xml`.
		// Every row's bind nests under `<case>`
		// (`<subcase_n>/case/update/<prop>`), with the guard every update row
		// carries.
		scChildren.push(
			updateBlock(
				subcaseCasePath,
				Object.entries(sc.case_properties),
				binds,
				context,
			),
		);

		// Subcase close-on-submit. CCHQ's basic-module path orders the subcase
		// transaction children create / update / close / index — `add_close_block`
		// runs before `add_index_ref` (`xform.py::XForm.add_form_actions`), so the
		// `<close>` precedes the `<index>` pushed below. A subcase's
		// `close_condition` is a close operation of the case it creates that
		// shares its basic place (`placement.ts`, `casePlacementPlan.ts`).
		// Mirrors CCHQ's `add_close_block`.
		const scCloseMode = sc.close_condition.type;
		if (scCloseMode === "always" || scCloseMode === "if") {
			scChildren.push(el("close", {}));
			if (scCloseMode === "if" && sc.close_condition.question) {
				binds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: subcaseCasePath.child("close").toWire(),
								relevant: conditionToRelevantXPath(sc.close_condition),
							},
						},
						context,
					),
				);
			}
		}

		// Index edge back to the parent case — last child per CCHQ's wire order
		// (create / update / close / index). `xform.py::add_index_ref` and the
		// fixtures `subcase-parent-ref.xml` + `multiple_subcase_repeat.xml`
		// omit the `relationship` attribute when the relationship is the
		// default `child`; only `extension` and `question` carry the
		// attribute. The bind below reads the parent's case_id off the form's
		// own `<case>` element rather than the session datum directly, so the
		// same shape works whether the parent was opened by this form
		// (registration-with-subcase) or loaded by it
		// (followup-with-subcase) — `/data/case/@case_id` is itself bound to
		// the right session var earlier in this function.
		const subcaseRel = sc.relationship || "child";
		const parentAttribs: Record<string, string> = {
			case_type: primaryCaseType(),
		};
		if (subcaseRel !== "child") parentAttribs.relationship = subcaseRel;
		scChildren.push(el("index", {}, [el("parent", parentAttribs)]));
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: subcaseCasePath.child("index").child("parent").toWire(),
						calculate: primaryCasePath.attr("case_id").toWire(),
					},
				},
				context,
			),
		);

		// The subcase's `<case>` carries the same three attributes as the
		// primary case (case_id, date_modified, user_id) plus the
		// case-transaction xmlns. Two emission shapes per the `nest`
		// decision above:
		//
		//   - nest=true: `<subcase_N>` wrapper holds the case element.
		//     parentPath is the repeat element (or `<data>` for
		//     non-repeat-context subcases). Mirrors CCHQ's
		//     `multiple_subcase_repeat.xml` and the existing
		//     non-repeat-context wire shape.
		//
		//   - nest=false: the case element splices DIRECTLY into the
		//     repeat element with no wrapper. parentPath IS the repeat
		//     element. Mirrors CCHQ's `subcase-repeat.xml` for the
		//     single-subcase-per-repeat case.
		const caseElement = buildCaseElement(scChildren);
		if (nest) {
			const parentPath = repeatCtxPath ?? FormPath.root();
			dataChildren.push({
				parentPath,
				element: el(elName, {}, [caseElement]),
				position: "last",
			});
		} else {
			// `nest=false` only happens when `repeatCtxPath` is set (the
			// single-subcase-per-real-repeat branch). The case splices
			// directly into the repeat element, as its first child.
			dataChildren.push({
				parentPath: repeatCtxPath as FormPath,
				element: caseElement,
				position: "first",
			});
		}
	}

	if (hasPrimaryBlock) {
		dataChildren.push({
			parentPath: FormPath.root(),
			element: buildCaseElement(caseChildren),
			position: "last",
		});
	}

	// The worker's own record, mirroring `XForm._add_usercase` exactly: a
	// `commcare_usercase` wrapper under `<data>` holding one case block built
	// from `XFormCaseBlock(self, 'commcare_usercase/')`, with `add_case_updates`
	// and NOTHING else — no `<create>`, because HQ never creates a usercase from
	// a form, and no `<close>`.
	//
	// The wrapper is emitted as its own data child rather than spliced into an
	// existing element: nothing in the authored form produces a
	// `commcare_usercase` node, so there is no parent to resolve.
	if (hasUsercaseUpdate) {
		const usercaseCasePath = FormPath.root()
			.child("commcare_usercase")
			.child("case");
		// `_add_usercase_bind`: a bind with a calculate, not a setvalue. The
		// datum is computed at entry (`requires_selection=False`), so the value
		// is already in the session when the form opens and stays put.
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: usercaseCasePath.attr("case_id").toWire(),
						calculate: SESSION_USERCASE_ID,
					},
				},
				context,
			),
			// `XFormCaseBlock.elem`'s own two binds, which every case block gets.
			...caseMetaBinds(usercaseCasePath, context),
		);
		const update = updateBlock(
			usercaseCasePath,
			Object.entries(usercaseAction.update),
			binds,
			context,
		);
		dataChildren.push({
			position: "last",
			parentPath: FormPath.root(),
			element: el("commcare_usercase", {}, [buildCaseElement([update])]),
		});
	}

	return {
		dataChildren,
		binds,
		setvalues,
		...(requiredNamePaths.length > 0 && { requiredNamePaths }),
	};
}

/** One row of a basic action's update map, as `FormActions` holds it. */
type UpdateMapping = {
	readonly question_path: string;
	readonly update_mode: string;
};

/** The `@date_modified` and `@user_id` binds every case block carries
 *  (`XFormCaseBlock.elem`). */
function caseMetaBinds(
	casePath: FormPath,
	context: WireElementContext,
): Element[] {
	return [
		xel(
			"bind",
			{
				attributes: { type: "xsd:dateTime" },
				xpath: {
					nodeset: casePath.attr("date_modified").toWire(),
					calculate: FormPath.root().child("meta").child("timeEnd").toWire(),
				},
			},
			context,
		),
		xel(
			"bind",
			{
				xpath: {
					nodeset: casePath.attr("user_id").toWire(),
					calculate: FormPath.root().child("meta").child("userID").toWire(),
				},
			},
			context,
		),
	];
}

/**
 * A block's `<update>` and each row's bind, in HQ's order
 * (`xform.py::XFormCaseBlock.add_case_updates`): rows by wire name, each
 * calculated from the path its action names and present only while that
 * path is (`count(path) > 0`), since a question the worker never reached
 * has no node, and an unguarded row would overwrite the case's value with
 * blank. A row saved only when the answer changed (`update_mode: edit`)
 * also compares the answer with the case's value when the form opened,
 * `instance('casedb')/casedb/case[@case_id = <the block's id>]/<property>`,
 * the comparison HQ's build adds under `SAVE_ONLY_EDITED_FORM_FIELDS`.
 */
function updateBlock(
	casePath: FormPath,
	updates: readonly (readonly [string, UpdateMapping])[],
	binds: Element[],
	context: WireElementContext,
): Element {
	const rows = updates
		.map(([property, mapping]) => ({
			validProp: validatePropertyName(formActionsPropertyToWire(property)),
			resolvedQPath: validateXFormPath(
				mapping.question_path || FormPath.root().child(property).toXPath(),
			),
			edit: mapping.update_mode === "edit",
		}))
		.sort(byWireName);
	const updatePath = casePath.child("update");
	for (const { validProp, resolvedQPath, edit } of rows) {
		const source = FormPath.parse(resolvedQPath).toWire();
		const present = w.gt(w.call("count", [source]), w.num(0));
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: updatePath.child(validProp).toWire(),
						calculate: source,
						relevant: edit
							? w.and(
									present,
									w.ne(
										w.append(
											caseById(casePath.attr("case_id").toWire(), "casedb"),
											[w.step(validProp)],
										),
										source,
									),
								)
							: present,
					},
				},
				context,
			),
		);
	}
	return el(
		"update",
		{},
		rows.map((row) => el(row.validProp, {})),
	);
}

/**
 * Build one cx2-namespaced `<case>` element wrapping its create / update /
 * close / index grandchildren. Attribute order matches the canonical fixture
 * (`case_id`, `date_modified`, `user_id`, `xmlns`) so the byte-level wire
 * output stays diffable against CCHQ's `XFormCaseBlock.elem` emission and the
 * test suite's literal substring assertions.
 */
function buildCaseElement(children: Element[]): Element {
	return el(
		"case",
		{
			case_id: "",
			date_modified: "",
			user_id: "",
			xmlns: CASE_TRANSACTION_XMLNS,
		},
		children,
	);
}

/**
 * Build a JavaRosa `relevant` XPath fragment from a `FormActionCondition`.
 * Used for conditional case opens (`<bind nodeset="/data/case" relevant>`),
 * conditional case closes (`<bind nodeset="/data/case/close" relevant>`), and
 * conditional subcase opens.
 *
 * Three shapes per the question's operator, as `xform.py::XForm.
 * action_relevance` writes them:
 *   - `boolean_true` → `<qPath>` — the question's own truth.
 *   - `selected`  → `selected(<qPath>, '<answer>')` — for multi-select items
 *     where the answer is a token within the value list.
 *   - everything else → `<qPath> = '<answer>'` — equality compare.
 *
 * The answer is a wire string node, so the shared serializer handles every
 * quote character and preserves the answer's literal value.
 * The schema declares `answer` as `z.string()` — free-form by design — so the
 * emitter must be total against every printable character.
 */
function conditionToRelevantXPath(condition: FormActionCondition): WireExpr {
	const qPath = FormPath.parse(
		validateXFormPath(condition.question ?? ""),
	).toWire();
	if (condition.operator === "boolean_true") return qPath;
	const answer = w.str(condition.answer ?? "");
	return condition.operator === "selected"
		? w.call("selected", [qPath, answer])
		: w.eq(qPath, answer);
}

/**
 * Splice case-management XML into an XForm string based on the form's
 * `FormActions`. Inserts a `<case>` element (with `<create>`, `<update>`,
 * `<close>` as applicable), zero or more `<subcase_n>` elements, the matching
 * `<bind>` rules wiring each case field to its XForm data path, and
 * `<setvalue>` elements seeding the case_id at form load.
 *
 * Round-trip parse + splice + serialize via the shared `xform/domSplice.ts`
 * helpers — `serializeXml` is the single XML-escaping authority there, so
 * every interpolated XPath body / case-type / field path goes through one
 * structural pass with no hand-escaping. The post-injection XForm oracle
 * reparses what this returns (`validator/xformDataModel.ts::buildXFormDataModel`)
 * under the same parse options, so the byte-level round-trip is the contract on
 * both sides.
 *
 * Early-returns the input string untouched when no case-block work is needed,
 * skipping the parse / serialize round-trip.
 */
export function addCaseBlocks(
	xform: string,
	actions: FormActions,
	caseType: string | undefined,
	selectedCaseIdRef: WireExpr = w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step("case_id"),
	]),
	defaultCaseManagement = true,
): string {
	const opensCase =
		actions.open_case.condition.type === "always" ||
		actions.open_case.condition.type === "if";
	const effectiveActions =
		defaultCaseManagement || opensCase
			? actions
			: {
					...actions,
					update_case: {
						...actions.update_case,
						condition: {
							...actions.update_case.condition,
							type: "never" as const,
						},
					},
					close_case: {
						...actions.close_case,
						condition: {
							...actions.close_case.condition,
							type: "never" as const,
						},
					},
					case_preload: {
						...actions.case_preload,
						condition: {
							...actions.case_preload.condition,
							type: "never" as const,
						},
					},
					subcases: [],
				};
	const instances = new InstanceSink();
	const context: WireElementContext = {
		mode: { target: "xform", constraint: false },
		instances,
	};
	const emission = buildCaseBlocks(
		effectiveActions,
		caseType,
		selectedCaseIdRef,
		context,
	);
	if (emission === null) return xform;

	const doc = parseXForm(xform);
	const dataEl = findDataElement(doc, "addCaseBlocks");

	// Group dataChildren by their splice parent's serialized XPath and walk
	// each parent once, prepending the children that stand first and
	// appending the rest. Per-parent batching keeps the splice helpers'
	// `relinkSiblings` invariant clean (the linked-list `prev`/`next`
	// pointers DOM-serializer walks in parallel with the children array stay
	// consistent because each parent's children array is re-linked once per
	// batch).
	const spliceGroups = new Map<
		string,
		{ parent: Element; first: Element[]; last: Element[] }
	>();
	for (const child of emission.dataChildren) {
		const key = child.parentPath.toXPath();
		let group = spliceGroups.get(key);
		if (!group) {
			// Only walk the DOM for a parent we haven't resolved yet — multiple
			// subcases sharing one repeat_context (the nest=true shape) all map
			// to the same splice parent, so the walk runs once per distinct
			// parent, not once per child.
			group = {
				parent: resolveSpliceParent(dataEl, child.parentPath),
				first: [],
				last: [],
			};
			spliceGroups.set(key, group);
		}
		group[child.position].push(child.element);
	}
	for (const { parent, first, last } of spliceGroups.values()) {
		if (first.length > 0) prependChildren(parent, first);
		if (last.length > 0) appendChildren(parent, last);
	}

	// Splice binds + setvalues into `<model>`. The model's canonical child
	// order is instance / secondary instances / binds / setvalues / itext, so
	// when an `<itext>` is present (always, for Nova-emitted forms) we insert
	// just before it; otherwise we append. Both `<bind>` and `<setvalue>`
	// groups go in together so they remain adjacent on the wire.
	const modelEl = findModelElement(doc, "addCaseBlocks");
	for (const { id, src } of instances.declarations())
		ensureInstance(modelEl, id, src);

	const inserted: ChildNode[] = [...emission.binds, ...emission.setvalues];
	insertBeforeItext(modelEl, inserted);

	// Stamp `required="true()"` on the path each create's name action names,
	// as `XFormCaseBlock.add_create_block` does for the primary case AND every
	// subcase. `buildXForm` already emitted that node's bind, so we merge the
	// attribute onto it rather than appending a duplicate — matching CCHQ's
	// `add_bind` merge-on-conflict, and JavaRosa's own bind merge. A missing
	// bind is a compiler-bug invariant (every node gets one), so append
	// defensively.
	for (const namePath of emission.requiredNamePaths ?? []) {
		mergeRequiredOntoBind(modelEl, namePath, context);
	}

	return serializeXForm(doc);
}

/**
 * Walk the parsed XForm DOM from `<data>` along a `FormPath` to find the
 * element that becomes the splice parent for a case-block wrapper.
 *
 * Mirrors CCHQ's `self.instance_node.find('/{x}'.join(repeat_context.split('/'))[1:])`
 * at `commcare-hq/.../app_manager/xform.py::XForm._create_casexml`. Walks
 * one element step at a time using `findOne` against the children of the
 * previous step, so the result is the exact DOM node `appendChildren`
 * must receive.
 *
 * Throws on a missing intermediate — a malformed input that the upstream
 * emitter guarantees never produces (every `repeat_context` resolves to a
 * field id that `xform/builder.ts::buildContainer` emitted as a data
 * element before this runs, and `query_bound` repeats nest the children
 * under `<item>` which the builder also emits). A throw here is a compiler
 * bug, not a fixable authoring state — the error message points at the
 * upstream emit site to look at.
 */
function resolveSpliceParent(dataEl: Element, path: FormPath): Element {
	const segments = path.segments();
	// First segment is always `{ kind: "element", name: "data" }` — the
	// parsed DOM's `<data>` element IS that segment, so skip it. Walking
	// `segments.slice(1)` gives us the descent steps from `<data>` onwards.
	let cursor: Element = dataEl;
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.kind !== "element") {
			throw new Error(
				`addCaseBlocks splice path "${path.toXPath()}" includes an attribute step (@${segment.name}). ` +
					`Splice targets name an element to append the case wrapper UNDER; ` +
					`confirm buildFormActions emitted an element-only FormPath for this repeat_context.`,
			);
		}
		const next = findOne(
			(e) => e.name === segment.name,
			cursor.children,
			false,
		);
		if (next === null) {
			throw new Error(
				`addCaseBlocks could not resolve splice path "${path.toXPath()}": ` +
					`the step "${segment.name}" doesn't exist as a child of <${cursor.name}>. ` +
					`Splice paths come from repeat_context values that xform/builder.ts::buildContainer ` +
					`emits as data-instance elements; check the repeat field's emit site for the missing element.`,
			);
		}
		cursor = next;
	}
	return cursor;
}

/**
 * Stamp `required="true()"` onto the `<model>`-level `<bind>` whose nodeset is
 * `namePath`, merging the attribute onto the field's existing bind rather than
 * appending a duplicate (CCHQ's `add_bind` merge-on-conflict). Binds are direct
 * children of `<model>`, so the search is direct-child only — matching CCHQ's
 * direct-child `get_bind` and avoiding the `<instance>`/`<data>` subtree. A
 * missing bind is a compiler-bug invariant (every node gets one), so a fresh
 * bind is appended defensively.
 */
function mergeRequiredOntoBind(
	model: Element,
	namePath: string,
	context: WireElementContext,
): void {
	const existing = getChildren(model).find(
		(child): child is Element =>
			child instanceof Element &&
			child.name === "bind" &&
			child.attribs.nodeset === namePath,
	);
	if (existing) {
		existing.attribs.required = serializeWire(w.call("true"), {
			target: "xform",
			constraint: false,
		}).text;
		return;
	}
	insertBeforeItext(model, [
		xel(
			"bind",
			{
				xpath: {
					nodeset: FormPath.parse(namePath).toWire(),
					required: w.call("true"),
				},
			},
			context,
		),
	]);
}
