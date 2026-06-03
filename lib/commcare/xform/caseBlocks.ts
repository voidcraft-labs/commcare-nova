/**
 * Case-management scaffolding emission.
 *
 * `addCaseBlocks` mirrors CCHQ's server-side post-process
 * (`commcare-hq/.../app_manager/xform.py::XFormCaseBlock`) so the local CCZ
 * pipeline injects the `<case>` / `<subcase_n>` transaction blocks (plus the
 * matching `<bind>` and `<setvalue>` elements) that the mobile runtime needs
 * to read and write the case database. The shape of the emission is the only
 * place the form's `FormActions` cross into XForm wire syntax.
 *
 * The emitter CONSTRUCTS `domhandler` element trees (via the shared helpers
 * in `elementBuilders.ts`) and splices them into the form's parsed DOM, then
 * serializes the tree once with `dom-serializer`. There is NO template-literal
 * XML in this module: every attribute and text value flows through `setAttribute`
 * (an `attribs` object literal) or a `Text` node, and the serializer is the
 * single, exclusive escaping authority. The earlier string-template emitter
 * leaked every interpolated XPath body, case-type name, and field path into the
 * output unescaped — the validator gates closed that gap reactively, but the
 * structural fix is to make malformed bytes unrepresentable by construction.
 * See `lib/commcare/xform/builder.ts`'s file-level comment for the same totality
 * argument applied to the main emitter.
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
import { el } from "@/lib/commcare/elementBuilders";
import {
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import {
	appendChildren,
	ensureInstance,
	findDataElement,
	findModelElement,
	insertBeforeItext,
	parseXForm,
	serializeXForm,
} from "@/lib/commcare/xform/domSplice";
import { FormPath } from "@/lib/commcare/xform/formPath";

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
 * The structured payload `buildCaseBlocks` returns. Three siblings the caller
 * splices into the existing XForm DOM:
 *
 *   - `dataChildren` — the `<case>` and (zero or more) `<subcase_n>` elements
 *     appended under the form's primary `<data>` instance node.
 *   - `binds` — the per-attribute and per-property `<bind>` elements appended
 *     to the form's `<model>`, alongside any other binds the main emitter
 *     produced.
 *   - `setvalues` — the `<setvalue>` elements (form-load case-id wires for
 *     non-repeat subcases, plus case-preload reads from `casedb`) appended to
 *     the form's `<model>`. Form-root scope because `xforms-ready` fires once
 *     at form load.
 *   - `requiredNamePaths` — the `/data/...` paths of every question that
 *     supplies a case name (primary open + each subcase open). The caller
 *     merges `required="true()"` onto each field's existing bind (CommCare
 *     forces every opened case's name question required, primary and subcase
 *     alike; mirrors `XFormCaseBlock.add_create_block`).
 *   - `needsCasedbInstance` — true when a preload setvalue reads from `casedb`.
 *     The caller declares the `casedb` secondary instance if the form doesn't
 *     already carry it (`buildXForm`'s instance scan only sees field-level
 *     XPath, not these post-injection setvalues). Mirrors `add_case_preloads`'
 *     `add_casedb()` call.
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
}

interface CaseBlocksEmission {
	readonly dataChildren: ReadonlyArray<CaseBlockChild>;
	readonly binds: Element[];
	readonly setvalues: Element[];
	readonly requiredNamePaths?: string[];
	readonly needsCasedbInstance?: boolean;
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
	caseType: string,
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
	// Case-preload (followup/close forms): one casedb-read `<setvalue>` per
	// preloaded property. Independent of the primary `<case>` block — preload
	// targets the form's own question nodes. Included in the early-return guard
	// so a (degenerate) preload-only form still emits its setvalues.
	const preloadAction = actions.case_preload;
	const hasPreload =
		preloadAction.condition.type === "always" &&
		Object.keys(preloadAction.preload).length > 0;

	if (!isCreate && !isUpdate && !isClose && !hasSubcases && !hasPreload) {
		return null;
	}

	// Per-emission accumulators. `caseChildren` is the children list of the
	// primary `<case>` element (create / update / close grandchildren); `binds`
	// + `setvalues` accumulate the per-action model-level emissions.
	const caseChildren: Element[] = [];
	const binds: Element[] = [];
	const setvalues: Element[] = [];
	// Paths of the questions that supply a case name on this form — the
	// primary open plus every subcase open. Surfaced so the caller stamps
	// `required="true()"` onto each field's bind (CommCare forces every
	// opened case's name question required).
	const requiredNamePaths: string[] = [];

	// Typed reference to the primary `<case>` element under `<data>`. Every
	// `/data/case/...` path the primary-case branches emit is built off this
	// one anchor, so a typo in the segment chain is a compile error rather
	// than a silent string-template divergence.
	const primaryCasePath = FormPath.root().child("case");
	// Meta-block paths the case-attribute calculates read out of. The values
	// reference the always-on meta block populated by `xform/metaBlock.ts`.
	const metaTimeEnd = FormPath.root().child("meta").child("timeEnd").toXPath();
	const metaUserID = FormPath.root().child("meta").child("userID").toXPath();

	// Index rule mirrors `commcare-hq/.../app_manager/models.py::Form
	// .session_var_for_action`: subcase indices start at 1 when an `open_case`
	// is active (so the primary is always `_0`), else 0.
	const subcaseIndexOffset = isCreate ? 1 : 0;
	const validatedCaseType = validateCaseType(caseType);

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
			el("bind", {
				nodeset: primaryCreatePath.child("case_type").toXPath(),
				calculate: `'${validatedCaseType}'`,
			}),
		);
		const namePath =
			openCase.name_update?.question_path ||
			FormPath.root().child("name").toXPath();
		const validatedNamePath = validateXFormPath(namePath);
		binds.push(
			el("bind", {
				nodeset: primaryCreatePath.child("case_name").toXPath(),
				calculate: validatedNamePath,
			}),
		);
		// CommCare forces the case-name question required so a case can never be
		// created nameless — `XFormCaseBlock.add_create_block` adds
		// `required="true()"` to the source field's bind. Surface the path; the
		// caller merges the attribute onto that field's existing bind.
		requiredNamePaths.push(validatedNamePath);
		// owner_id reads from the always-on meta block (which is itself seeded
		// from session/context at form load). Matching CCHQ's canonical shape —
		// `instance('commcaresession')/session/context/userid` resolves
		// equivalently but the fixture-shape calculate is what CCHQ Vellum emits
		// and what the Vellum round-trip preserves.
		binds.push(
			el("bind", {
				nodeset: primaryCreatePath.child("owner_id").toXPath(),
				calculate: metaUserID,
			}),
		);
		// Wire the form's `/data/case/@case_id` to the session datum
		// `deriveSessionDatums` emits for this same `open_case` action.
		// `xforms-ready` fires once at form load — the form-side and the
		// session-side both pull their value from the same `uuid()`.
		setvalues.push(
			el("setvalue", {
				ref: primaryCasePath.attr("case_id").toXPath(),
				event: "xforms-ready",
				value: `instance('commcaresession')/session/data/case_id_new_${validatedCaseType}_0`,
			}),
		);
		// Conditional-open forms get a `<bind relevant>` on the case element.
		// Same operator dispatch as the close condition below.
		if (openMode === "if" && openCase.condition.question) {
			binds.push(
				el("bind", {
					nodeset: primaryCasePath.toXPath(),
					relevant: conditionToRelevantXPath(openCase.condition),
				}),
			);
		}
	} else if (isUpdate || isClose) {
		// Case-update / case-close: no `<create>` block, but the case_id still
		// wires to the case-loading session datum so the case-update block on
		// the wire knows which case it's editing.
		binds.push(
			el("bind", {
				nodeset: primaryCasePath.attr("case_id").toXPath(),
				calculate: "instance('commcaresession')/session/data/case_id",
			}),
		);
	}

	if (isUpdate && updateCase.update) {
		// Always emit `<update/>` on the wire — CCHQ does the same via
		// `XFormCaseBlock.update_block`'s memoized side-effect, and we
		// match for byte-level parity so any future CCHQ-side check on
		// the element's presence agrees on every Nova-emitted form.
		const props = Object.keys(updateCase.update);
		caseChildren.push(
			el(
				"update",
				{},
				props.map((p) => el(validatePropertyName(p), {})),
			),
		);
		const primaryUpdatePath = primaryCasePath.child("update");
		for (const [prop, mapping] of Object.entries(updateCase.update)) {
			const validProp = validatePropertyName(prop);
			const qPath =
				mapping.question_path || FormPath.root().child(prop).toXPath();
			const resolvedQPath = validateXFormPath(qPath);
			// `relevant="count(<qPath>) > 0"` skips the case-update bind
			// when the source question's data node is absent at submission
			// time — the JavaRosa semantic when a `<bind relevant="...">`
			// is false. Without this guard, a conditionally-hidden field
			// (`relevant="age > 60"` on a `weight` question, say) would
			// still fire its case-update with an empty calculate result
			// at submission, overwriting the case's existing property
			// value. CCHQ's `XFormCaseBlock.add_case_updates` carries the
			// same guard; matching here preserves case data through
			// conditional-question flows.
			binds.push(
				el("bind", {
					nodeset: primaryUpdatePath.child(validProp).toXPath(),
					calculate: resolvedQPath,
					relevant: `count(${resolvedQPath}) > 0`,
				}),
			);
		}
	}

	if (isClose) {
		caseChildren.push(el("close", {}));
		// Conditional close requires a `relevant` expression on the `<close/>`
		// bind; "selected" operators produce `selected(path, answer)` while the
		// default equality operator produces `path = 'answer'`.
		if (closeMode === "if" && closeCase.condition.question) {
			binds.push(
				el("bind", {
					nodeset: primaryCasePath.child("close").toXPath(),
					relevant: conditionToRelevantXPath(closeCase.condition),
				}),
			);
		}
	}

	// Case-preload: seed each preloaded question from the loaded case at form
	// load. `preload` maps the question's `/data/...` path → the case property
	// to read. The value XPath is the canonical case-loading shape — look up
	// the case selected for this entry (`session/data/case_id`) in `casedb`
	// and read the property. Mirrors `XForm.add_case_preloads`. These setvalues
	// are spliced in AFTER `buildXForm`'s instance scan, so `addCaseBlocks`
	// declares the `casedb` instance itself via `needsCasedbInstance` →
	// `ensureCasedbInstance`. `<setvalue>` because the read happens once, at load.
	if (hasPreload) {
		for (const [questionPath, caseProperty] of Object.entries(
			preloadAction.preload,
		)) {
			setvalues.push(
				el("setvalue", {
					ref: validateXFormPath(questionPath),
					event: "xforms-ready",
					value: `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/${validatePropertyName(
						caseProperty,
					)}`,
				}),
			);
		}
	}

	// Whether the primary case element appears at all. When the form has only
	// subcases (no open/update/close on the parent), no `<case>` is appended
	// under `<data>` and no attribute binds (date_modified, user_id) emit.
	const dataChildren: CaseBlockChild[] = [];
	if (isCreate || isUpdate || isClose) {
		dataChildren.push({
			parentPath: FormPath.root(),
			element: buildCaseElement(caseChildren),
		});
		// `<case>` attribute binds read out of the always-on /data/meta block
		// (populated by setvalues from session/context at form load + on every
		// revalidate for timeEnd). The meta block ships with every Nova-emitted
		// form, so these references resolve.
		binds.push(
			el("bind", {
				nodeset: primaryCasePath.attr("date_modified").toXPath(),
				type: "xsd:dateTime",
				calculate: metaTimeEnd,
			}),
		);
		binds.push(
			el("bind", {
				nodeset: primaryCasePath.attr("user_id").toXPath(),
				calculate: metaUserID,
			}),
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
		const subcaseDatumId = `case_id_new_${validatedSubcaseType}_${sIdx + subcaseIndexOffset}`;

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
			el("bind", {
				nodeset: subcaseCreatePath.child("case_type").toXPath(),
				calculate: `'${validatedSubcaseType}'`,
			}),
		);
		const namePath = validateXFormPath(
			sc.name_update?.question_path || basePath.child("name").toXPath(),
		);
		binds.push(
			el("bind", {
				nodeset: subcaseCreatePath.child("case_name").toXPath(),
				calculate: namePath,
			}),
		);
		// CommCare forces every opened case's name question required, subcases
		// included — `add_create_block` runs the same `required="true()"` stamp
		// for the basic-module subcase path. Surface the path for the merge.
		requiredNamePaths.push(namePath);
		// Owner-id binds to the submitting user. The basic module Nova uploads
		// always autosets the owner via `autoset_owner_id_for_subcase`
		// (`'owner_id' not in case_properties`, relationship-independent), so
		// CCHQ's regenerated form carries this userID bind on EVERY subcase —
		// child and extension alike. (The unowned-extension sentinel is an
		// advanced-module-only shape Nova never emits.) The `extension`
		// relationship is carried solely on the `<index>` below.
		binds.push(
			el("bind", {
				nodeset: subcaseCreatePath.child("owner_id").toXPath(),
				calculate: metaUserID,
			}),
		);

		// Wire the subcase's `@case_id`. When the subcase lives in a repeat,
		// setvalues won't fire per-iteration AND the session datum isn't emitted
		// for repeat-context subcases (CCHQ skips them in
		// `EntriesHelper.get_new_case_id_datums_meta`); each iteration mints its
		// own id via a bare `uuid()` calculate. Mirrors CCHQ's
		// `delay_case_id=True` branch in `XFormCaseBlock.add_create_block`,
		// which routes `case_id='uuid()'` through `add_setvalue_or_bind` to emit
		// a calculate bind.
		const subcaseCaseIdAttr = subcaseCasePath.attr("case_id").toXPath();
		if (repeatCtxPath) {
			binds.push(
				el("bind", {
					nodeset: subcaseCaseIdAttr,
					calculate: "uuid()",
				}),
			);
		} else {
			setvalues.push(
				el("setvalue", {
					ref: subcaseCaseIdAttr,
					event: "xforms-ready",
					value: `instance('commcaresession')/session/data/${subcaseDatumId}`,
				}),
			);
		}

		// Subcase case-attribute binds — same shape as the primary case.
		binds.push(
			el("bind", {
				nodeset: subcaseCasePath.attr("date_modified").toXPath(),
				type: "xsd:dateTime",
				calculate: metaTimeEnd,
			}),
		);
		binds.push(
			el("bind", {
				nodeset: subcaseCasePath.attr("user_id").toXPath(),
				calculate: metaUserID,
			}),
		);

		// Conditional subcase create — `<bind relevant>` on the subcase case
		// element.
		if (sc.condition.type === "if" && sc.condition.question) {
			binds.push(
				el("bind", {
					nodeset: subcaseCasePath.toXPath(),
					relevant: conditionToRelevantXPath(sc.condition),
				}),
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
		// preserves byte-level parity with `multiple_subcase_repeat.xml`
		// + future CCHQ-side checks.
		const props = Object.entries(sc.case_properties);
		scChildren.push(
			el(
				"update",
				{},
				props.map(([p]) => el(validatePropertyName(p), {})),
			),
		);
		const subcaseUpdatePath = subcaseCasePath.child("update");
		for (const [prop, mapping] of props) {
			const validProp = validatePropertyName(prop);
			const qPath =
				mapping.question_path || FormPath.root().child(prop).toXPath();
			const resolvedQPath = validateXFormPath(qPath);
			// Subcase update binds nest the property under `<case>` — the
			// path is `<subcase_n>/case/update/<prop>`, NOT
			// `<subcase_n>/update/<prop>`. The case element is what wraps
			// the entire case-transaction shape (create / index / update /
			// close); the bind nodeset must match the actual element path
			// or `XFORM_DANGLING_BIND` fires post-injection. The
			// `relevant="count(<qPath>) > 0"` guard is the same
			// preserves-existing-property-on-hidden-question guard the
			// primary case-update path carries.
			binds.push(
				el("bind", {
					nodeset: subcaseUpdatePath.child(validProp).toXPath(),
					calculate: resolvedQPath,
					relevant: `count(${resolvedQPath}) > 0`,
				}),
			);
		}

		// Subcase close-on-submit. CCHQ's basic-module path orders the subcase
		// transaction children create / update / close / index — `add_close_block`
		// runs before `add_index_ref` (`xform.py::XForm.add_form_actions`), so the
		// `<close>` precedes the `<index>` pushed below. No authoring surface
		// populates an active `close_condition` today (`buildFormActions`
		// hardcodes a `never` condition for every subcase), so this branch is
		// dormant in production — it exists so the moment a subcase-close
		// authoring surface lands, both this emitter and the HQ-JSON projection
		// render the `<close>` transaction from the same `FormActions` field, in
		// the right wire position. Mirrors CCHQ's `add_close_block`.
		const scCloseMode = sc.close_condition.type;
		if (scCloseMode === "always" || scCloseMode === "if") {
			scChildren.push(el("close", {}));
			if (scCloseMode === "if" && sc.close_condition.question) {
				binds.push(
					el("bind", {
						nodeset: subcaseCasePath.child("close").toXPath(),
						relevant: conditionToRelevantXPath(sc.close_condition),
					}),
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
			case_type: validatedCaseType,
		};
		if (subcaseRel !== "child") parentAttribs.relationship = subcaseRel;
		scChildren.push(el("index", {}, [el("parent", parentAttribs)]));
		binds.push(
			el("bind", {
				nodeset: subcaseCasePath.child("index").child("parent").toXPath(),
				calculate: primaryCasePath.attr("case_id").toXPath(),
			}),
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
			});
		} else {
			// `nest=false` only happens when `repeatCtxPath` is set (the
			// single-subcase-per-real-repeat branch). The case splices
			// directly into the repeat element.
			dataChildren.push({
				parentPath: repeatCtxPath as FormPath,
				element: caseElement,
			});
		}
	}

	return {
		dataChildren,
		binds,
		setvalues,
		...(requiredNamePaths.length > 0 && { requiredNamePaths }),
		...(hasPreload && { needsCasedbInstance: true }),
	};
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
 * Two shapes per the question's operator:
 *   - `selected`  → `selected(<qPath>, '<answer>')` — for multi-select items
 *     where the answer is a token within the value list.
 *   - everything else → `<qPath> = '<answer>'` — equality compare.
 *
 * The answer flows through `xpathStringLiteral` so the emitted literal is
 * always a valid XPath string, regardless of which quote characters the
 * author used in the condition's `answer` field (e.g. names containing `'`).
 * The schema declares `answer` as `z.string()` — free-form by design — so the
 * emitter must be total against every printable character.
 */
function conditionToRelevantXPath(condition: FormActionCondition): string {
	const qPath = validateXFormPath(condition.question ?? "");
	const answer = xpathStringLiteral(condition.answer ?? "");
	const op = condition.operator ?? "=";
	return op === "selected"
		? `selected(${qPath}, ${answer})`
		: `${qPath} = ${answer}`;
}

/**
 * Render `value` as a valid XPath 1.0 string literal.
 *
 * XPath 1.0 has no escape sequence inside string literals: a `'...'` literal
 * cannot contain `'`, a `"..."` literal cannot contain `"`. The standard
 * encoding picks the delimiter the value doesn't contain, and falls back to
 * `concat()` (alternating delimiters across pieces) when the value contains
 * BOTH quote characters. The result is always parse-safe under JavaRosa's
 * XPath evaluator.
 *
 * The XML serializer escapes the returned string into the attribute value
 * separately — its `'` / `"` escaping is XML-spec, not XPath-spec, so a
 * downstream `&apos;` decodes back to `'` before JavaRosa parses the
 * expression. Both layers compose correctly.
 */
function xpathStringLiteral(value: string): string {
	const hasSingle = value.includes("'");
	const hasDouble = value.includes('"');
	if (!hasSingle) return `'${value}'`;
	if (!hasDouble) return `"${value}"`;
	// Both quote characters present — split on `'` and reassemble via
	// `concat()`, alternating single-quoted pieces with the literal `"'"`
	// rendered as the double-quoted literal that joins them. Each piece is
	// safe in its own delimiter because the split removes the only
	// disqualifying character.
	const pieces = value.split("'");
	const parts: string[] = [];
	for (let i = 0; i < pieces.length; i++) {
		if (i > 0) parts.push(`"'"`);
		if (pieces[i].length > 0) parts.push(`'${pieces[i]}'`);
	}
	return `concat(${parts.join(", ")})`;
}

/**
 * Splice case-management XML into an XForm string based on the form's
 * `FormActions`. Inserts a `<case>` element (with `<create>`, `<update>`,
 * `<close>` as applicable), zero or more `<subcase_n>` elements, the matching
 * `<bind>` rules wiring each case field to its XForm data path, and
 * `<setvalue>` elements seeding the case_id at form load.
 *
 * Round-trip parse + splice + serialize via the shared `xform/domSplice.ts`
 * helpers — `dom-serializer` is the single XML-escaping authority there, so
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
	caseType: string,
): string {
	const emission = buildCaseBlocks(actions, caseType);
	if (emission === null) return xform;

	const doc = parseXForm(xform);
	const dataEl = findDataElement(doc, "addCaseBlocks");

	// Group dataChildren by their splice parent's serialized XPath and walk
	// each parent once. Per-parent batching keeps `appendChildren`'s
	// `relinkSiblings` invariant clean (the linked-list `prev`/`next`
	// pointers DOM-serializer walks in parallel with the children array stay
	// consistent because each parent's children array is re-linked once after
	// all its appends).
	const spliceGroups = new Map<
		string,
		{ parent: Element; children: Element[] }
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
				children: [],
			};
			spliceGroups.set(key, group);
		}
		group.children.push(child.element);
	}
	for (const { parent, children } of spliceGroups.values()) {
		appendChildren(parent, children);
	}

	// Splice binds + setvalues into `<model>`. The model's canonical child
	// order is instance / secondary instances / binds / setvalues / itext, so
	// when an `<itext>` is present (always, for Nova-emitted forms) we insert
	// just before it; otherwise we append. Both `<bind>` and `<setvalue>`
	// groups go in together so they remain adjacent on the wire.
	const modelEl = findModelElement(doc, "addCaseBlocks");
	// Declare the `casedb` secondary instance when a preload setvalue reads
	// from it. `buildXForm`'s instance scan runs over field-level XPath only,
	// so a form that preloads but has no field-level `#case/` reference would
	// otherwise carry a `casedb` read with no matching `<instance>`. Mirrors
	// `add_case_preloads`'s `add_casedb()`. Idempotent: skip when the form
	// already declares it (a field referenced `casedb`, so `buildXForm` did).
	if (emission.needsCasedbInstance) {
		ensureInstance(modelEl, "casedb", "jr://instance/casedb");
	}

	const inserted: ChildNode[] = [...emission.binds, ...emission.setvalues];
	insertBeforeItext(modelEl, inserted);

	// Force every opened case's name question required. CommCare guarantees a
	// case can't be created nameless by stamping `required="true()"` onto the
	// name question's bind (`XFormCaseBlock.add_create_block`, run for the
	// primary case AND every subcase). `buildXForm` already emitted each field's
	// bind, so we merge the attribute onto it rather than appending a duplicate
	// — matching CCHQ's `add_bind` merge-on-conflict, and JavaRosa's own bind
	// merge. A missing bind is a compiler-bug invariant (every field gets one),
	// so append defensively.
	for (const namePath of emission.requiredNamePaths ?? []) {
		mergeRequiredOntoBind(modelEl, namePath);
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
				`addCaseBlocks could not resolve splice path "${path.toXPath()}" — ` +
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
 * missing bind is a compiler-bug invariant (every field gets one), so a fresh
 * bind is appended defensively.
 */
function mergeRequiredOntoBind(model: Element, namePath: string): void {
	const existing = getChildren(model).find(
		(child): child is Element =>
			child instanceof Element &&
			child.name === "bind" &&
			child.attribs.nodeset === namePath,
	);
	if (existing) {
		existing.attribs.required = "true()";
		return;
	}
	insertBeforeItext(model, [
		el("bind", { nodeset: namePath, required: "true()" }),
	]);
}
