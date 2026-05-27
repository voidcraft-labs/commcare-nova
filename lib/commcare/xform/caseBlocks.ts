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

import render from "dom-serializer";
import { type ChildNode, Element } from "domhandler";
import { findOne, getChildren } from "domutils";
import { parseDocument } from "htmlparser2";
import type { FormActionCondition, FormActions } from "@/lib/commcare";
import {
	validateCaseType,
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import { el, RENDER_OPTS } from "@/lib/commcare/xform/elementBuilders";

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
 * Parse options for the round-trip. Mirrors `validator/xformDataModel.ts`'s
 * parse contract — the same option set the post-injection XForm oracle uses to
 * re-parse what we emit here, so the byte-level round-trip is the contract on
 * both sides.
 */
const PARSE_OPTS = { xmlMode: true } as const;

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
 *     non-repeat subcases) appended to the form's `<model>`. Form-root scope
 *     because `xforms-ready` fires once at form load.
 *
 * `null` is returned when the form has no case-management actions to emit —
 * the caller short-circuits without touching the DOM.
 */
interface CaseBlocksEmission {
	readonly dataChildren: Element[];
	readonly binds: Element[];
	readonly setvalues: Element[];
}

/**
 * Construct the case-block DOM emission for a form's `FormActions`. Pure
 * builder — produces orphaned `Element` nodes the caller splices into a parent
 * tree. Returns `null` when none of the four action shapes (open / update /
 * close / subcase) is active, so the caller knows to skip the splice
 * entirely.
 *
 * Element / attribute insertion order matches the prior string-template
 * emitter so the byte-level wire output stays stable: `<case>` carries
 * `case_id`, `date_modified`, `user_id`, `xmlns` in that exact order; `<bind>`
 * elements list `nodeset` first, then the kind-specific attributes (`type`
 * before `calculate` on the date_modified bind, `calculate` alone on user_id /
 * case_id, `relevant` alone on conditional binds). The serializer preserves
 * attribute insertion order, so the literal substrings the test suite asserts
 * (`<case case_id="" date_modified="" user_id="" xmlns="...">`) survive.
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

	if (!isCreate && !isUpdate && !isClose && !hasSubcases) return null;

	// Per-emission accumulators. `caseChildren` is the children list of the
	// primary `<case>` element (create / update / close grandchildren); `binds`
	// + `setvalues` accumulate the per-action model-level emissions.
	const caseChildren: Element[] = [];
	const binds: Element[] = [];
	const setvalues: Element[] = [];

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
		binds.push(
			el("bind", {
				nodeset: "/data/case/create/case_type",
				calculate: `'${validatedCaseType}'`,
			}),
		);
		const namePath = openCase.name_update?.question_path || "/data/name";
		binds.push(
			el("bind", {
				nodeset: "/data/case/create/case_name",
				calculate: validateXFormPath(namePath),
			}),
		);
		// owner_id reads from the always-on meta block (which is itself seeded
		// from session/context at form load). Matching CCHQ's canonical shape —
		// `instance('commcaresession')/session/context/userid` resolves
		// equivalently but the fixture-shape calculate is what CCHQ Vellum emits
		// and what the Vellum round-trip preserves.
		binds.push(
			el("bind", {
				nodeset: "/data/case/create/owner_id",
				calculate: "/data/meta/userID",
			}),
		);
		// Wire the form's `/data/case/@case_id` to the session datum
		// `deriveSessionDatums` emits for this same `open_case` action.
		// `xforms-ready` fires once at form load — the form-side and the
		// session-side both pull their value from the same `uuid()`.
		setvalues.push(
			el("setvalue", {
				ref: "/data/case/@case_id",
				event: "xforms-ready",
				value: `instance('commcaresession')/session/data/case_id_new_${validatedCaseType}_0`,
			}),
		);
		// Conditional-open forms get a `<bind relevant>` on the case element.
		// Same operator dispatch as the close condition below.
		if (openMode === "if" && openCase.condition.question) {
			binds.push(
				el("bind", {
					nodeset: "/data/case",
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
				nodeset: "/data/case/@case_id",
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
		for (const [prop, mapping] of Object.entries(updateCase.update)) {
			const validProp = validatePropertyName(prop);
			const qPath = mapping.question_path || `/data/${prop}`;
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
					nodeset: `/data/case/update/${validProp}`,
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
					nodeset: "/data/case/close",
					relevant: conditionToRelevantXPath(closeCase.condition),
				}),
			);
		}
	}

	// Whether the primary case element appears at all. When the form has only
	// subcases (no open/update/close on the parent), no `<case>` is appended
	// under `<data>` and no attribute binds (date_modified, user_id) emit.
	const dataChildren: Element[] = [];
	if (isCreate || isUpdate || isClose) {
		dataChildren.push(buildCaseElement(caseChildren));
		// `<case>` attribute binds read out of the always-on /data/meta block
		// (populated by setvalues from session/context at form load + on every
		// revalidate for timeEnd). The meta block ships with every Nova-emitted
		// form, so these references resolve.
		binds.push(
			el("bind", {
				nodeset: "/data/case/@date_modified",
				type: "xsd:dateTime",
				calculate: "/data/meta/timeEnd",
			}),
		);
		binds.push(
			el("bind", {
				nodeset: "/data/case/@user_id",
				calculate: "/data/meta/userID",
			}),
		);
	}

	// Subcases — each child-case creation gets a dedicated element named
	// `subcase_{n}` (or nested under its repeat context).
	for (let sIdx = 0; sIdx < subcases.length; sIdx++) {
		const sc = subcases[sIdx];
		if (sc.condition.type !== "always" && sc.condition.type !== "if") {
			continue;
		}

		const elName = `subcase_${sIdx}`;
		const repeatCtx = sc.repeat_context || "";
		const basePath = repeatCtx ? `${repeatCtx}/${elName}` : `/data/${elName}`;
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
		binds.push(
			el("bind", {
				nodeset: `${basePath}/case/create/case_type`,
				calculate: `'${validatedSubcaseType}'`,
			}),
		);
		const namePath = sc.name_update?.question_path || `${basePath}/name`;
		binds.push(
			el("bind", {
				nodeset: `${basePath}/case/create/case_name`,
				calculate: validateXFormPath(namePath),
			}),
		);
		binds.push(
			el("bind", {
				nodeset: `${basePath}/case/create/owner_id`,
				calculate: "/data/meta/userID",
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
		if (repeatCtx) {
			binds.push(
				el("bind", {
					nodeset: `${basePath}/case/@case_id`,
					calculate: "uuid()",
				}),
			);
		} else {
			setvalues.push(
				el("setvalue", {
					ref: `${basePath}/case/@case_id`,
					event: "xforms-ready",
					value: `instance('commcaresession')/session/data/${subcaseDatumId}`,
				}),
			);
		}

		// Subcase case-attribute binds — same shape as the primary case.
		binds.push(
			el("bind", {
				nodeset: `${basePath}/case/@date_modified`,
				type: "xsd:dateTime",
				calculate: "/data/meta/timeEnd",
			}),
		);
		binds.push(
			el("bind", {
				nodeset: `${basePath}/case/@user_id`,
				calculate: "/data/meta/userID",
			}),
		);

		// Conditional subcase create — `<bind relevant>` on the subcase case
		// element.
		if (sc.condition.type === "if" && sc.condition.question) {
			binds.push(
				el("bind", {
					nodeset: `${basePath}/case`,
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
		for (const [prop, mapping] of props) {
			const validProp = validatePropertyName(prop);
			const qPath = mapping.question_path || `/data/${prop}`;
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
					nodeset: `${basePath}/case/update/${validProp}`,
					calculate: resolvedQPath,
					relevant: `count(${resolvedQPath}) > 0`,
				}),
			);
		}

		// Index edge back to the parent case — last child per CCHQ's wire
		// order (create / update / index). `xform.py::add_index_ref` and the
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
				nodeset: `${basePath}/case/index/parent`,
				calculate: "/data/case/@case_id",
			}),
		);

		// The subcase's `<case>` carries the same three attributes as the
		// primary case (case_id, date_modified, user_id) plus the
		// case-transaction xmlns. Wrapping element (`<subcase_n>`) holds the
		// case element; the case element holds the create / update / index
		// children.
		dataChildren.push(el(elName, {}, [buildCaseElement(scChildren)]));
	}

	return { dataChildren, binds, setvalues };
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
 * Implementation:
 *
 *   1. Build the case-block emission via `buildCaseBlocks` — pure DOM
 *      construction, returns `null` when no actions need to fire.
 *   2. Parse the input XForm as XML via `htmlparser2`. This is the same parse
 *      contract `validator/xformDataModel.ts::buildXFormDataModel` uses (the
 *      post-injection oracle re-parses what we emit here).
 *   3. Splice the case + subcase elements under the primary `<data>` element
 *      and the binds + setvalues under `<model>` (before `<itext>` when
 *      present, so the model preserves the canonical sequence: instance /
 *      secondary instances / binds / setvalues / itext).
 *   4. Re-serialize the tree once via `dom-serializer`. The serializer is the
 *      single XML-escaping authority — every interpolated XPath body,
 *      case-type name, and field path becomes an attribute value through
 *      `setAttribute` (via the `attribs` object literal), so the escape is
 *      applied exactly once at render and never by hand.
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

	const doc = parseDocument(xform, PARSE_OPTS);

	// Splice the `<case>` + `<subcase_n>` elements as children of the form's
	// primary `<data>` instance node. The emitter (`xform/builder.ts`) emits
	// exactly one `<data>` element under the only `<instance>` with no `id`
	// attribute, so `findOne` against the document tree resolves it
	// unambiguously. A missing `<data>` is a compiler-bug invariant (the
	// emitter would have failed first), not a fixable authoring state.
	const dataEl = findOne((elem) => elem.name === "data", doc.children, true);
	if (dataEl === null) {
		throw new Error(
			"addCaseBlocks could not find a <data> element in the XForm. " +
				"The form emitter guarantees exactly one top-level <data> per form; " +
				"this points at corruption between buildXForm and addCaseBlocks. " +
				"Re-run the compile from a clean expandDoc.",
		);
	}
	appendChildren(dataEl, emission.dataChildren);

	// Splice binds + setvalues into `<model>`. The model's canonical child
	// order is instance / secondary instances / binds / setvalues / itext, so
	// when an `<itext>` is present (always, for Nova-emitted forms) we insert
	// just before it; otherwise we append. Both `<bind>` and `<setvalue>`
	// groups go in together so they remain adjacent on the wire.
	const modelEl = findOne((elem) => elem.name === "model", doc.children, true);
	if (modelEl === null) {
		throw new Error(
			"addCaseBlocks could not find a <model> element in the XForm. " +
				"The form emitter guarantees exactly one <model> per form; " +
				"this points at corruption between buildXForm and addCaseBlocks. " +
				"Re-run the compile from a clean expandDoc.",
		);
	}
	const inserted: ChildNode[] = [...emission.binds, ...emission.setvalues];
	insertBeforeItext(modelEl, inserted);

	// Single serialization pass. Unlike `buildXForm` upstream — which constructs
	// the DOM from scratch and prepends the XML declaration because the
	// serializer doesn't emit one — we are serializing a tree the parser
	// already populated with the input's `<?xml ...?>` processing instruction.
	// The serializer renders that PI verbatim, so prepending another declaration
	// would produce two and trip the post-injection XML well-formedness gate
	// ("XML declaration allowed only at the start of the document").
	return render(doc, RENDER_OPTS);
}

/**
 * Append each child element to the parent. Updates the children array and
 * re-seats every `prev` / `next` pointer in one pass — `dom-serializer` walks
 * both the array and the linked-list pointers, so leaving the pointers stale
 * on either side would corrupt the serialized output.
 */
function appendChildren(parent: Element, children: Element[]): void {
	for (const child of children) child.parent = parent;
	parent.children.push(...children);
	relinkSiblings(parent.children);
}

/**
 * Insert a node list into `<model>` just before the `<itext>` child (when
 * present) so the model preserves the canonical instance / secondary
 * instances / binds / setvalues / itext order. With no `<itext>` (a shape
 * Nova never actually emits, but tolerated defensively), the nodes are
 * appended at the end.
 *
 * Maintains the linked-list pointers (`prev` / `next`) the serializer walks
 * alongside `children`, so the spliced nodes serialize in their inserted
 * position even though `dom-serializer` traverses both arrays.
 */
function insertBeforeItext(model: Element, nodes: ChildNode[]): void {
	const itextIndex = getChildren(model).findIndex(
		(child) => child instanceof Element && child.name === "itext",
	);
	if (itextIndex === -1) {
		for (const node of nodes) appendNode(model, node);
		return;
	}
	// Splice the nodes at the `<itext>` slot — pushing `<itext>` (and anything
	// after it) one position rightward. Then re-seat every `prev` / `next`
	// pointer from the freshly ordered array. `dom-serializer` walks both the
	// children array and the linked-list pointers, so leaving the pointers
	// stale would corrupt the serialized output.
	model.children.splice(itextIndex, 0, ...nodes);
	for (const node of nodes) node.parent = model;
	relinkSiblings(model.children);
}

/**
 * Append one node at the end of `parent.children`. Used only by the
 * `<itext>`-absent fallback in `insertBeforeItext`. Same pointer-relinking
 * contract as `appendChildren`.
 */
function appendNode(parent: Element, node: ChildNode): void {
	node.parent = parent;
	parent.children.push(node);
	relinkSiblings(parent.children);
}

/**
 * Walk an ordered children list and re-seat every `prev` / `next` pointer to
 * match the array's index order. Cheaper than tracking adjacency on every
 * splice site, and `dom-serializer` walks both the array and the linked-list
 * pointers — leaving the pointers stale would corrupt the serialized output.
 */
function relinkSiblings(children: ChildNode[]): void {
	for (let i = 0; i < children.length; i++) {
		const node = children[i];
		node.prev = i > 0 ? children[i - 1] : null;
		node.next = i < children.length - 1 ? children[i + 1] : null;
	}
}
