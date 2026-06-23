/**
 * Post-expansion XForm parse-time ORACLE.
 *
 * Mirrors the FATAL contract CommCare Core / JavaRosa enforces while parsing a
 * form (`commcare-core .../xform/parse/XFormParser.java`). Any state our
 * emitter can reach must pass this oracle — a failing form here is a generator
 * bug, not an authoring error a user could fix. The oracle is co-developed
 * with a property-based fuzzer (`__tests__/xformOracle.fuzz.test.ts`) that
 * generates schema-valid `BlueprintDoc`s, emits them, and asserts the oracle
 * returns clean: that fuzzer is what proves the emitter total, and it also
 * defines the oracle's faithfulness — a check that flags legitimately-emitted
 * output is the ORACLE being wrong, never a new reject rule.
 *
 * ## Two XPath surfaces
 *
 * Classified with the shared Lezer-backed gate in `xform/pathExpression.ts`:
 *   - PATH-only — bind `nodeset`, control `ref`, `<group ref>`, `<setvalue
 *     ref>`. Core routes these through `XPathReference.getPathExpr`, which
 *     throws on a non-path (`XPathTypeMismatchException`). `isPathExpression`
 *     mirrors that gate.
 *   - ANY-expression — bind `relevant`/`required`/`constraint`/`calculate`/
 *     `readonly`, `<output value>`, `<setvalue value>`. Core only requires
 *     these parse as XPath (`buildCondition`/`buildCalculate`/`parseOutput`/
 *     `parseSetValueAction`). `isParseableXPath` mirrors that.
 *
 * ## Structural model
 *
 * The strict `XMLValidator.validate` gate proves well-formedness (the only
 * parse-failure path; htmlparser2 recovers rather than throws, so it can't be
 * the gate), then a single htmlparser2 DOM walk builds the shared model once:
 * the set of instance node paths (element + `@attr`), the set of REPEATABLE
 * node paths (elements carrying `jr:template`), and the itext id set. Each
 * invariant reads off that model.
 *
 * ## Conservatism on query_bound
 *
 * Query_bound repeats emit model-iteration markup with attribute targets
 * (`@ids`/`@count`/`@current_index` on the outer `<id>`, `@index`/`@id` on the
 * inner `<item jr:template="">`) plus a `current_index` calculate bind. Whether
 * Core's `expandReference(target,true)` resolves these template attributes was
 * not fully traced to ground, so the path-existence checks (#19/#20) collect
 * every `@attr` path into the valid-path set — exactly as the prior validator
 * did — and never newly reject a legitimately-emitted query_bound form. The
 * fuzzer generates query_bound docs; if the oracle flags one, the oracle is
 * wrong and gets fixed, never the emitter.
 *
 * ## Intentionally NOT enforced
 *
 * Calculate/relevant dependency-CYCLE detection (Core's
 * `FormDef.checkDependencyCycles`). The doc-layer validator
 * (`validator/index.ts::validateBlueprintDeep` via `TriggerDag`) already
 * detects cycles on authored XPath before emission; porting Core's runtime
 * triggerable-DAG walk into the wire oracle would duplicate that at high cost
 * with no added coverage. The doc layer owns cycles.
 *
 * ## Stricter than Core (preserved)
 *
 * A bind whose nodeset resolves to no instance node is only a WARN in Core
 * (`verifyBindings`) but Nova treats it FATAL (`XFORM_DANGLING_BIND`). A
 * dangling bind from the emitter is a generator bug, so the stricter posture
 * stays.
 */

import { type Document, type Element, isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import {
	isParseableXPath,
	isPathExpression,
} from "@/lib/commcare/xform/pathExpression";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";
import {
	buildXFormDataModel,
	localName,
	type XFormDataModel,
} from "./xformDataModel";

/**
 * The valid events an `<action>`/`<setvalue>` may declare. Mirrors
 * `commcare-core/.../core/model/actions/Action.java::allEvents`
 * (`isValidEvent` membership). Nova only ever emits `xforms-ready` and
 * `jr-insert`; the full set is enforced so a future emitter typo surfaces.
 */
const VALID_ACTION_EVENTS = new Set([
	"jr-insert",
	"xforms-value-changed",
	"xforms-ready",
	"xforms-revalidate",
]);

/**
 * Local alias — every invariant below reads off the shared model. The
 * `validator/xformDataModel.ts` module owns the actual walk so the
 * binding-resolution oracle can reuse it without re-traversing the DOM.
 */
type XFormModel = XFormDataModel;

// ── Path classification helpers ────────────────────────────────────

/**
 * A ref/nodeset targets the MAIN instance (the data tree this oracle resolves
 * against) when it starts with the data root path. Refs into secondary
 * instances (`instance('casedb')/...`) reference external data and are out of
 * scope for path-existence checks — only their XPath validity matters, which
 * the PATH/ANY classifiers cover.
 */
function targetsMainInstance(ref: string, rootPath: string): boolean {
	return ref.startsWith(rootPath);
}

// ── itext duplicate-definition detection (#10) ─────────────────────

/** Direct element children of `el` with the given tag name. Mirrors Core's
 *  direct-child iteration (`text.getElement(k)`) rather than a subtree search;
 *  a `<value>` nested deeper than a direct child is not a text-handle to Core. */
function directChildElementsNamed(el: Element, name: string): Element[] {
	return getChildren(el).filter(
		(c): c is Element => isTag(c) && c.name === name,
	);
}

/**
 * Detect duplicate itext (id, form) definitions within each translation (#10),
 * and reject `<text>` elements with no id or with non-`<value>` children (#11).
 *
 * `parseTextHandle` (`XFormParser.java`) rejects a form where the same
 * (id, form) key appears twice in one `<translation>`. The dedup key mirrors
 * Core's textID formula: `id` for the default form (when `form` is absent or
 * empty), `id + ";" + form` for named forms. Empty `form=""` normalizes to the
 * default exactly as Core does.
 *
 * Uniqueness is scoped per-translation — the same id legitimately appears in
 * every locale's `<translation>` block. Nova emits both `<value>` (default)
 * and `<value form="markdown">` under each `<text id>`; those are distinct
 * keys and must not be flagged.
 */
function checkItextDefinitions(
	doc: Document,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const translation of findAll(
		(el) => el.name === "translation",
		doc.children,
	)) {
		const lang = getAttributeValue(translation, "lang") ?? "unknown";
		const seenKeys = new Set<string>();

		for (const textEl of directChildElementsNamed(translation, "text")) {
			const id = getAttributeValue(textEl, "id");

			// #11: every <text> must carry a non-empty id. Core's parseTextHandle
			// keys the itext table on this id; an absent/empty id makes the entry
			// unreachable and Core rejects it.
			if (!id) {
				errors.push(
					validationError(
						"XFORM_TEXT_NO_ID",
						"form",
						`"${formName}" has a <text> element in the "${lang}" translation with no id. FormPlayer keys every translation entry on its id, so an id-less <text> can't be reached. This is a bug in the form generator.`,
						loc,
					),
				);
				continue;
			}

			// #11: a <text> may only carry <value> children. Core's parseTextHandle
			// reads each child as a translation form; any other element kind is a
			// parse failure. Nova never emits another child, so a stray one is a
			// generator bug.
			for (const child of getChildren(textEl)) {
				if (isTag(child) && child.name !== "value") {
					errors.push(
						validationError(
							"XFORM_TEXT_BAD_CHILD",
							"form",
							`"${formName}" has a <text id="${id}"> in the "${lang}" translation containing a <${child.name}> child, but FormPlayer only accepts <value> children inside <text>. This is a bug in the form generator.`,
							loc,
						),
					);
				}
			}

			// #10: duplicate (id, form) keys within this translation.
			for (const valueEl of directChildElementsNamed(textEl, "value")) {
				const rawForm = getAttributeValue(valueEl, "form") ?? "";
				const dedupKey = rawForm === "" ? id : `${id};${rawForm}`;
				if (seenKeys.has(dedupKey)) {
					const formDesc = rawForm === "" ? "" : ` (form="${rawForm}")`;
					errors.push(
						validationError(
							"XFORM_DUPLICATE_ITEXT",
							"form",
							`"${formName}" defines itext id "${id}"${formDesc} more than once in the "${lang}" translation. FormPlayer will reject this form. This is a bug in the form generator.`,
							loc,
						),
					);
				} else {
					seenKeys.add(dedupKey);
				}
			}
		}
	}

	return errors;
}

// ── translation structure (#12) ────────────────────────────────────

/**
 * Validate the `<itext>` translation block (#12): there must be ≥1
 * `<translation>`, each must carry a `lang`, no two may share a `lang`, and at
 * most one may be the default. Mirrors `XFormParser.java::parseIText` /
 * `parseTranslation`. The check only runs when an `<itext>` block is present —
 * a form with no labels has no itext and that is legal.
 */
function checkTranslations(
	doc: Document,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const itextBlocks = findAll((el) => el.name === "itext", doc.children);
	if (itextBlocks.length === 0) return errors;

	const translations = findAll((el) => el.name === "translation", doc.children);

	// ≥1 translation when an itext block exists. Core's parseIText requires at
	// least one to anchor the default locale.
	if (translations.length === 0) {
		errors.push(
			validationError(
				"XFORM_TRANSLATION_NONE",
				"form",
				`"${formName}" has an <itext> block with no <translation> inside it. FormPlayer needs at least one translation to resolve any label. This is a bug in the form generator.`,
				loc,
			),
		);
		return errors;
	}

	const seenLangs = new Set<string>();
	let defaultCount = 0;
	for (const translation of translations) {
		const lang = getAttributeValue(translation, "lang");
		if (!lang) {
			errors.push(
				validationError(
					"XFORM_TRANSLATION_NO_LANG",
					"form",
					`"${formName}" has a <translation> with no lang attribute. FormPlayer identifies each locale by its lang, so it can't load a lang-less translation. This is a bug in the form generator.`,
					loc,
				),
			);
		} else if (seenLangs.has(lang)) {
			errors.push(
				validationError(
					"XFORM_TRANSLATION_DUPLICATE_LANG",
					"form",
					`"${formName}" declares two <translation> blocks for lang "${lang}". FormPlayer allows only one translation per locale. This is a bug in the form generator.`,
					loc,
				),
			);
		} else {
			seenLangs.add(lang);
		}
		// `default=""` (any value of the attribute, including empty) marks the
		// default locale. Core allows at most one.
		if (getAttributeValue(translation, "default") !== undefined) defaultCount++;
	}

	if (defaultCount > 1) {
		errors.push(
			validationError(
				"XFORM_TRANSLATION_MULTIPLE_DEFAULT",
				"form",
				`"${formName}" marks ${defaultCount} <translation> blocks as the default locale, but FormPlayer allows only one default. This is a bug in the form generator.`,
				loc,
			),
		);
	}

	return errors;
}

// ── bind invariants (#2, #3, #19/dangling) ─────────────────────────

function checkBinds(
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const bind of findAll((el) => el.name === "bind", model.doc.children)) {
		const nodeset = getAttributeValue(bind, "nodeset");

		// #2: every bind has a nodeset (processStandardBindAttributes).
		if (!nodeset) {
			errors.push(
				validationError(
					"XFORM_BIND_NO_NODESET",
					"form",
					`"${formName}" has a <bind> element with no nodeset attribute. FormPlayer requires every bind to have a nodeset. This is a bug in the form generator.`,
					loc,
				),
			);
			continue;
		}

		// #3: the nodeset must parse as a PATH (getPathExpr). A non-path nodeset
		// (a literal, function call, or arithmetic) is exactly what JavaRosa's
		// XPathReference rejects with XPathTypeMismatchException.
		if (!isPathExpression(nodeset)) {
			errors.push(
				validationError(
					"XFORM_NON_PATH_NODESET",
					"form",
					`"${formName}" has a <bind nodeset="${nodeset}"> whose value isn't a location path. FormPlayer parses a bind nodeset as a node reference and rejects anything that isn't a path (a literal, a function call, or arithmetic). Look at how this bind's nodeset was built. This is a bug in the form generator.`,
					loc,
				),
			);
			continue;
		}

		// Stricter-than-Core dangling-bind check: a main-instance nodeset must
		// resolve to a real node. Refs into secondary instances are skipped —
		// they reference external data this oracle doesn't model.
		if (!targetsMainInstance(nodeset, model.rootPath)) continue;
		if (!model.instancePaths.has(nodeset)) {
			errors.push(
				validationError(
					"XFORM_DANGLING_BIND",
					"form",
					`"${formName}" has a <bind> pointing to "${nodeset}" but that node doesn't exist in the form's data model. FormPlayer will reject this form. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// ANY-expression binds: relevant / required / constraint / calculate /
		// readonly must parse as valid XPath (buildCondition / buildCalculate).
		// An unparseable expression here is a JavaRosa parse error.
		for (const attr of [
			"relevant",
			"required",
			"constraint",
			"calculate",
			"readonly",
		]) {
			const expr = getAttributeValue(bind, attr);
			if (expr !== undefined && expr !== "" && !isParseableXPath(expr)) {
				errors.push(
					validationError(
						"XFORM_INVALID_BIND_EXPRESSION",
						"form",
						`"${formName}" has a <bind nodeset="${nodeset}"> whose ${attr} expression "${expr}" doesn't parse as valid XPath. FormPlayer evaluates this expression and rejects the form when it can't parse it. Look at how this field's ${attr} was authored. This is a bug in the form generator.`,
						loc,
					),
				);
			}
		}
	}

	return errors;
}

// ── control invariants (#4, #5, #6, #7, #8, #9, #19) ───────────────

/** Body control tags that require a PATH `ref` (#5/#6). `trigger` is the one
 *  control Core allows without a ref; Nova always emits one anyway. */
const REF_CONTROL_TAGS = [
	"input",
	"select1",
	"select",
	"trigger",
	"upload",
	"secret",
];

/** Selection controls that require ≥1 inline `<item>` (#7). */
const SELECT_TAGS = ["select1", "select"];

function checkControls(
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Controls + structural containers that carry a ref/nodeset Core resolves.
	const controlTags = [...REF_CONTROL_TAGS, "group", "repeat"];
	for (const ctrl of findAll(
		(el) => controlTags.includes(el.name),
		model.doc.children,
	)) {
		// `<repeat>` carries `nodeset`; every other control + `<group>` carry
		// `ref`. Both are PATH-only surfaces.
		const ref =
			ctrl.name === "repeat"
				? getAttributeValue(ctrl, "nodeset")
				: getAttributeValue(ctrl, "ref");

		// #5: a non-trigger control must carry a ref. Nova always emits one; the
		// assertion still fires if a future change drops it.
		if (!ref) {
			if (ctrl.name !== "trigger") {
				errors.push(
					validationError(
						"XFORM_CONTROL_NO_REF",
						"form",
						`"${formName}" has a <${ctrl.name}> control with no ref attribute. FormPlayer needs every control to name the node it edits. This is a bug in the form generator.`,
						loc,
					),
				);
			}
		} else {
			// #6: the ref must parse as a PATH (parseControl → XPathReference).
			if (!isPathExpression(ref)) {
				errors.push(
					validationError(
						"XFORM_NON_PATH_CONTROL_REF",
						"form",
						`"${formName}" has a <${ctrl.name}> whose ref "${ref}" isn't a location path. FormPlayer parses a control ref as a node reference and rejects anything that isn't a path. Look at how this control's ref was built. This is a bug in the form generator.`,
						loc,
					),
				);
			} else if (
				targetsMainInstance(ref, model.rootPath) &&
				!model.instancePaths.has(ref)
			) {
				// #19: the bound node must exist in the instance.
				errors.push(
					validationError(
						"XFORM_DANGLING_REF",
						"form",
						`"${formName}" has a <${ctrl.name}> control pointing to "${ref}" but that node doesn't exist in the form's data model. FormPlayer will reject this form. This is a bug in the form generator.`,
						loc,
					),
				);
			}
		}

		// #7 + #8 + #9: selection-control structural checks.
		if (SELECT_TAGS.includes(ctrl.name)) {
			const items = directChildElementsNamed(ctrl, "item");
			const itemsets = directChildElementsNamed(ctrl, "itemset");

			// #8: a select may not carry both inline items and an itemset
			// (parseControl). Nova never emits itemset, so this is defensive.
			if (items.length > 0 && itemsets.length > 0) {
				errors.push(
					validationError(
						"XFORM_SELECT_ITEMS_AND_ITEMSET",
						"form",
						`"${formName}" has a <${ctrl.name}> that declares both inline <item>s and an <itemset>. FormPlayer accepts one source of choices, not both. This is a bug in the form generator.`,
						loc,
					),
				);
			} else if (items.length === 0 && itemsets.length === 0) {
				// #7: a select with no choices at all.
				errors.push(
					validationError(
						"XFORM_SELECT_NO_ITEMS",
						"form",
						`"${formName}" has a <${ctrl.name}> with no <item> choices. FormPlayer needs at least one choice to render a selection question. This is a bug in the form generator.`,
						loc,
					),
				);
			}

			// #9: each inline <item> must carry a <label> and a <value>
			// (parseItem). A label-less or value-less item is a parse failure.
			for (const item of items) {
				const hasLabel = directChildElementsNamed(item, "label").length > 0;
				const hasValue = directChildElementsNamed(item, "value").length > 0;
				if (!hasLabel || !hasValue) {
					const missing =
						!hasLabel && !hasValue
							? "a <label> and a <value>"
							: !hasLabel
								? "a <label>"
								: "a <value>";
					errors.push(
						validationError(
							"XFORM_ITEM_INCOMPLETE",
							"form",
							`"${formName}" has a <${ctrl.name}> choice missing ${missing}. FormPlayer needs every <item> to carry both a label and a value. This is a bug in the form generator.`,
							loc,
						),
					);
				}
			}
		}
	}

	return errors;
}

// ── repeat invariants (#4, #16, #22) ───────────────────────────────

/**
 * Whether `ancestor` is a strict path-prefix ancestor of `descendant` in the
 * instance tree — `/data/a` is a parent-of `/data/a/b` but not of `/data/ab`.
 * The trailing `/` guard prevents a sibling whose name shares a prefix from
 * being read as a descendant.
 */
function isPathAncestorOf(ancestor: string, descendant: string): boolean {
	return descendant.startsWith(`${ancestor}/`);
}

/**
 * Repeat-member-binding scope (#22) — Core's `verifyRepeatMemberBindings`. The
 * check is STRUCTURAL CONTAINMENT, not type homogeneity. Three sub-checks, run
 * over the body `<repeat>`/control nesting (Core walks the form-element tree,
 * which is the body, not the data section):
 *
 *   (a) every member's bound node must be a DESCENDANT of its enclosing
 *       repeat's nodeset (`repeatBind.isParentOf(childBind)`);
 *   (b) a nested `<repeat>` may not bind to the SAME node as its parent repeat
 *       (a non-repeat child sharing the node is fine);
 *   (c) no repeatable node may sit strictly between a member and its closest
 *       containing repeat — a member must be scoped to its CLOSEST repeatable
 *       ancestor, not skip an intervening one.
 *
 * #4 (a repeat may not bind to `/` or `/data`) and #16 (≤1 `jr:template` per
 * repeated set) are checked alongside since both key off the same body walk.
 */
function checkRepeats(
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// #4: a repeat's nodeset may not be the document root or the data root.
	// Core's verifyBindings rejects a repeat binding to `/` or `/data`.
	for (const repeat of findAll(
		(el) => el.name === "repeat",
		model.doc.children,
	)) {
		const nodeset = getAttributeValue(repeat, "nodeset");
		if (nodeset === "/" || nodeset === model.rootPath) {
			errors.push(
				validationError(
					"XFORM_REPEAT_BINDS_ROOT",
					"form",
					`"${formName}" has a <repeat> bound to "${nodeset}", the form root. FormPlayer can't repeat the root node — a repeat must wrap a child group. This is a bug in the form generator.`,
					loc,
				),
			);
		}
	}

	// #16: at most one `jr:template` per repeated set. In the data section, two
	// sibling elements with the same name both carrying jr:template is exactly
	// Core's "more than one node declared as the template for the same repeated
	// set" parse failure (saveInstanceNode). Detect by grouping repeatable paths
	// by their parent+name — a duplicate path can't occur (DOM names are unique
	// per parse), so the real signal is two SIBLINGS sharing a name where both
	// are templates. Since identical sibling element names collapse in our path
	// model, we instead scan the raw DOM for sibling templates of one name.
	for (const parent of findAll(
		(el): el is Element => isTag(el),
		model.doc.children,
	)) {
		const templateNamesSeen = new Set<string>();
		for (const child of getChildren(parent)) {
			if (!isTag(child)) continue;
			if (getAttributeValue(child, "jr:template") === undefined) continue;
			if (templateNamesSeen.has(child.name)) {
				errors.push(
					validationError(
						"XFORM_DUPLICATE_TEMPLATE",
						"form",
						`"${formName}" declares more than one jr:template node for the repeated set "${child.name}". FormPlayer allows one template per repeat. This is a bug in the form generator.`,
						loc,
					),
				);
			} else {
				templateNamesSeen.add(child.name);
			}
		}
	}

	// #22: walk the BODY repeat/control nesting, tracking the nearest enclosing
	// repeat's nodeset. The body element is the XHTML `<h:body>` — htmlparser2
	// keeps the namespace prefix in `name`, so match on the local name (the
	// part after the `:`) to stay robust to the prefix the emitter happens to
	// pick. We descend from the body root.
	const bodyEls = findAll(
		(el) => localName(el.name) === "body",
		model.doc.children,
	);
	for (const body of bodyEls) {
		walkRepeatScope(body, null, model, formName, loc, errors);
	}

	return errors;
}

/**
 * Mirror Core's `collapseRepeatGroups`: a NON-repeat `<group>` whose only
 * element child is a `<repeat>` is replaced by that repeat for the purpose of
 * binding-scope verification. Returns the inner repeat when `el` is such a
 * wrapper, otherwise `el` unchanged. The collapse is recursive in Core, but
 * since the substituted repeat is then walked normally (and its own children
 * re-collapsed on descent), one level of substitution per visit suffices.
 *
 * "Only element child" follows Core's `getChildren().size() == 1` on the form
 * element tree: a `<group>`'s own `<label>` is form metadata, not a form-element
 * child, so a wrapper group carrying `<label>` + `<repeat>` still collapses.
 * We mirror that by counting only `<repeat>` / `<group>` / control element
 * children, ignoring `<label>` and other non-form-element markup.
 */
function collapseRepeatWrapper(el: Element): Element {
	if (localName(el.name) !== "group") return el;
	// The `ref` guard has NO analog in Core's `collapseRepeatGroups` — Core
	// collapses any non-repeat group wrapping a single repeat regardless of
	// whether the group is bound. It's a Nova-emitter-shape assumption: Nova's
	// repeat wrapper group ALWAYS carries the repeat's `ref` (see the
	// `<group ref="…"><repeat nodeset="…">` shape in `xform/builder.ts`), so a
	// ref-less group here is never a Nova repeat wrapper and skipping it avoids
	// collapsing an unrelated layout group. If the emitter ever emits a ref-less
	// wrapper, drop this guard to match Core exactly.
	if (getAttributeValue(el, "ref") === undefined) return el;

	const FORM_ELEMENT_TAGS = new Set(["repeat", "group", ...REF_CONTROL_TAGS]);
	const formChildren = getChildren(el).filter(
		(c): c is Element => isTag(c) && FORM_ELEMENT_TAGS.has(localName(c.name)),
	);
	if (formChildren.length !== 1) return el;

	const only = formChildren[0];
	return localName(only.name) === "repeat" ? only : el;
}

/**
 * Body of the #22 recursion. `enclosingRepeatBind` is the nodeset of the
 * closest containing `<repeat>` (null at the body root, standing in for Core's
 * `TreeReference.rootRef()`).
 */
function walkRepeatScope(
	el: Element,
	enclosingRepeatBind: string | null,
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	for (const rawChild of getChildren(el)) {
		if (!isTag(rawChild)) continue;

		// Mirror Core's `collapseRepeatGroups` (XFormParser.java), which runs
		// BEFORE `verifyRepeatMemberBindings`: a NON-repeat `<group>` whose only
		// element child is a `<repeat>` collapses into that repeat (the wrapper
		// group is discarded, its label moved onto the repeat). This is exactly
		// the Vellum repeat shape Nova emits — `<group ref="/data/x"><repeat
		// nodeset="/data/x">…`. Without the collapse the oracle would read the
		// wrapper group as a member binding to the repeatable node and falsely
		// flag a skipped-repeat scope error. We substitute the inner repeat for
		// the wrapper so the scope check sees Core's collapsed tree.
		const child = collapseRepeatWrapper(rawChild);

		const isRepeat = localName(child.name) === "repeat";
		const isGroup = localName(child.name) === "group";
		// A member's bound node: `<repeat nodeset>` or control/group `ref`.
		const childBind = isRepeat
			? getAttributeValue(child, "nodeset")
			: getAttributeValue(child, "ref");

		// Only main-instance, parseable-path members participate in scope
		// checks; #6 already flagged a non-path ref, and a secondary-instance
		// ref isn't part of the repeat data tree.
		const memberInScope =
			childBind !== undefined && targetsMainInstance(childBind, model.rootPath);

		if (memberInScope && childBind !== undefined) {
			const repeatBind = enclosingRepeatBind;

			// (a) descendant containment: a member must be a descendant of its
			// enclosing repeat's nodeset. (When there is no enclosing repeat,
			// the root contains everything, so this only checks members that
			// ARE inside a repeat.)
			if (repeatBind !== null && !isPathAncestorOf(repeatBind, childBind)) {
				// Exception: a member equal to the repeat bind is handled by (b).
				if (childBind !== repeatBind) {
					errors.push(
						validationError(
							"XFORM_REPEAT_MEMBER_SCOPE",
							"form",
							`"${formName}" has a <${child.name}> bound to "${childBind}" inside a <repeat> bound to "${repeatBind}", but "${childBind}" isn't a descendant of the repeat's node. FormPlayer requires every repeat member to live under the repeated node. This is a bug in the form generator.`,
							loc,
						),
					);
				}
			}

			// (b) a nested repeat may not bind to the SAME node as its parent
			// repeat (a non-repeat child sharing the node is fine).
			if (repeatBind !== null && isRepeat && childBind === repeatBind) {
				errors.push(
					validationError(
						"XFORM_REPEAT_MEMBER_SCOPE",
						"form",
						`"${formName}" nests a <repeat> bound to "${childBind}" directly inside another <repeat> bound to the same node. FormPlayer can't repeat the same node twice — a nested repeat must wrap a deeper child. This is a bug in the form generator.`,
						loc,
					),
				);
			}

			// (c) no repeatable node strictly between the enclosing repeat and
			// the member: the member must be scoped to its CLOSEST repeatable
			// ancestor. Scan each instance path segment between the enclosing
			// repeat bind (exclusive) and the member bind (exclusive of the
			// member itself unless the member is itself a repeat). A repeatable
			// node found there means an intervening repeat was skipped.
			const skipped = findSkippedRepeatableAncestor(
				childBind,
				repeatBind,
				isRepeat,
				model.repeatablePaths,
			);
			if (skipped) {
				errors.push(
					validationError(
						"XFORM_REPEAT_MEMBER_SCOPE",
						"form",
						`"${formName}" has a <${child.name}> bound to "${childBind}" whose closest repeatable ancestor in the data model is "${skipped}", not the <repeat> it's nested under. FormPlayer requires a member to be scoped to its closest containing repeat. This is a bug in the form generator.`,
						loc,
					),
				);
			}
		}

		// Recurse. A `<repeat>` becomes the new enclosing repeat for its
		// subtree; a `<group>` or any other element keeps the current one.
		const nextEnclosing =
			isRepeat && childBind !== undefined ? childBind : enclosingRepeatBind;
		// Groups and repeats hold further controls; recurse through every
		// element so deeply-nested members are reached.
		if (isRepeat || isGroup || getChildren(child).some(isTag)) {
			walkRepeatScope(child, nextEnclosing, model, formName, loc, errors);
		}
	}
}

/**
 * Return the path of a repeatable node that sits STRICTLY between the
 * enclosing repeat bind and the member bind — the marker of a skipped repeat
 * (#22 sub-check c). Returns `null` when no such node exists.
 *
 * Walks the member path segment by segment from just below the enclosing
 * repeat (or the root, when there is none) down to — but not including — the
 * member's own node, unless the member is itself a repeat, in which case its
 * own node is allowed to be repeatable (it IS the repeat). This mirrors Core's
 * `k == childBind.size() - 1 && isRepeat` allowance.
 */
function findSkippedRepeatableAncestor(
	memberBind: string,
	enclosingRepeatBind: string | null,
	memberIsRepeat: boolean,
	repeatablePaths: ReadonlySet<string>,
): string | null {
	const memberSegs = memberBind.split("/");
	// The first index to scan: one past the enclosing repeat's depth (so we
	// only look at nodes BELOW it), or from the root when unscoped.
	const startDepth =
		enclosingRepeatBind === null ? 1 : enclosingRepeatBind.split("/").length;
	// The last index to scan: the segment just above the member, OR the member
	// itself when the member is not a repeat (a repeatable member node under no
	// closer repeat is the skip we want to catch). When the member IS a repeat,
	// its own node being repeatable is expected, so stop one short.
	const endDepth = memberIsRepeat ? memberSegs.length - 1 : memberSegs.length;

	// Scan starts one segment BELOW the enclosing repeat (`startDepth + 1`), so
	// every `path` here is strictly deeper than `enclosingRepeatBind` — the
	// enclosing repeat's own node can never reappear in this range.
	for (let depth = startDepth + 1; depth <= endDepth; depth++) {
		const path = memberSegs.slice(0, depth).join("/");
		if (repeatablePaths.has(path)) return path;
	}
	return null;
}

// ── setvalue invariants (#13, #14, #15, #20) ───────────────────────

function checkSetValues(
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const sv of findAll(
		(el) => el.name === "setvalue",
		model.doc.children,
	)) {
		// #15: the action event must be one Core recognizes (Action.isValidEvent).
		const event = getAttributeValue(sv, "event");
		if (event !== undefined && !VALID_ACTION_EVENTS.has(event)) {
			errors.push(
				validationError(
					"XFORM_INVALID_ACTION_EVENT",
					"form",
					`"${formName}" has a <setvalue event="${event}"> but FormPlayer only recognizes the events ${[...VALID_ACTION_EVENTS].join(", ")}. Look at how this setvalue's event was set. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// #13: a setvalue must carry a target ref (parseSetValueAction).
		const ref = getAttributeValue(sv, "ref");
		if (!ref) {
			errors.push(
				validationError(
					"XFORM_SETVALUE_NO_TARGET",
					"form",
					`"${formName}" has a <setvalue> with no target ref attribute. FormPlayer requires setvalue elements to target a node. This is a bug in the form generator.`,
					loc,
				),
			);
			continue;
		}

		// #14a: the target ref must parse as a PATH (parseSetValueAction →
		// XPathReference).
		if (!isPathExpression(ref)) {
			errors.push(
				validationError(
					"XFORM_INVALID_SETVALUE",
					"form",
					`"${formName}" has a <setvalue> whose target ref "${ref}" isn't a location path. FormPlayer parses a setvalue ref as a node reference and rejects anything that isn't a path. Look at how this setvalue's ref was built. This is a bug in the form generator.`,
					loc,
				),
			);
		} else if (
			targetsMainInstance(ref, model.rootPath) &&
			!model.instancePaths.has(ref)
		) {
			// #20: the target node (incl. @attr targets) must exist.
			errors.push(
				validationError(
					"XFORM_DANGLING_REF",
					"form",
					`"${formName}" has a <setvalue> targeting "${ref}" but that node doesn't exist in the form's data model. FormPlayer will reject this form. This is a bug in the form generator.`,
					loc,
				),
			);
		}

		// #14b: the value expression (when present) must parse as valid XPath.
		const value = getAttributeValue(sv, "value");
		if (value !== undefined && value !== "" && !isParseableXPath(value)) {
			errors.push(
				validationError(
					"XFORM_INVALID_SETVALUE",
					"form",
					`"${formName}" has a <setvalue ref="${ref}"> whose value expression "${value}" doesn't parse as valid XPath. FormPlayer evaluates the value and rejects the form when it can't parse it. Look at how this setvalue's value was authored. This is a bug in the form generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── output invariants (#18) ────────────────────────────────────────

function checkOutputs(
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const out of findAll((el) => el.name === "output", model.doc.children)) {
		// #18: an <output> must carry a ref or a value (parseOutput); the value
		// expression must parse as valid XPath (ANY-expression surface). Nova
		// emits `value` (and a parallel `vellum:value`); Core also accepts `ref`.
		const value = getAttributeValue(out, "value");
		const ref = getAttributeValue(out, "ref");
		if (value === undefined && ref === undefined) {
			errors.push(
				validationError(
					"XFORM_INVALID_OUTPUT",
					"form",
					`"${formName}" has an <output> with neither a value nor a ref attribute. FormPlayer needs an output to name what to display. This is a bug in the form generator.`,
					loc,
				),
			);
			continue;
		}
		if (value !== undefined && value !== "" && !isParseableXPath(value)) {
			errors.push(
				validationError(
					"XFORM_INVALID_OUTPUT",
					"form",
					`"${formName}" has an <output value="${value}"> whose value doesn't parse as valid XPath. FormPlayer evaluates an output value and rejects the form when it can't parse it. Look at how this label's reference was built. This is a bug in the form generator.`,
					loc,
				),
			);
		}
	}

	return errors;
}

// ── itext reference resolution (#21) ───────────────────────────────

/**
 * Pattern matching a complete `jr:itext('<id>')` reference. The body-element
 * scan and the `<bind jr:constraintMsg>` scan both unwrap their attribute value
 * through this — the resolution target is the captured id, identical across
 * surfaces.
 */
const JR_ITEXT_REF_PATTERN = /^jr:itext\('([^']+)'\)$/;

/**
 * Resolution of every `jr:itext('X')` reference the form makes — across two
 * surfaces JavaRosa treats DIFFERENTLY at parse time:
 *
 *   - **Body-element `ref` attributes.** `<label ref="jr:itext('X')">`,
 *     `<hint ref="...">`, `<help ref="...">`, `<value ref="...">` on inline
 *     `<item>`s. A dangling id here is parse-FATAL: `commcare-core
 *     .../xform/parse/XFormParser.java::verifyTextMappings` throws
 *     `XFormParseException` when the default locale has no matching `<text>`.
 *   - **`<bind jr:constraintMsg>` attributes.** `commcare-core
 *     .../xform/parse/XFormParser.java::parseBindAttributes` stores the
 *     `jr:constraintMsg` value RAW on the binding — it never routes through
 *     `verifyTextMappings`, so a dangling id there is NOT parse-fatal. The
 *     runtime tolerates it: `Constraint.java::getConstraintMessage` resolves the
 *     itext lazily at constraint-failure display time and falls back to the raw
 *     string when the lookup misses. The bind-attribute scan is therefore a
 *     regression guard STRICTER than Core (same posture as `XFORM_DANGLING_BIND`),
 *     not a mirror of a runtime crash.
 *
 * Both surfaces share one check because the emit-time invariant is uniform: a
 * `jr:itext('X')` reference — body ref or `jr:constraintMsg` — must exist iff its
 * `<text id="X">` entry does. A media-only `validate_msg_media` whose
 * registration gate ever drifts from the bind-attribute gate would emit a
 * dangling `jr:constraintMsg` ref — caught here as a generator bug rather than
 * shipped as a silently-degraded constraint message (the bare `jr:itext('X')`
 * string surfacing to the user instead of the intended text).
 */
function checkItextReferences(
	model: XFormModel,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const errors: ValidationError[] = [];
	if (model.itextIds.size === 0) return errors;

	const reportMissing = (textId: string): void => {
		if (model.itextIds.has(textId)) return;
		errors.push(
			validationError(
				"XFORM_MISSING_ITEXT",
				"form",
				`"${formName}" references itext ID "${textId}" but no <text id="${textId}"> exists in the translations. FormPlayer will fail to display this label. This is a bug in the form generator.`,
				loc,
			),
		);
	};

	// Surface 1 — body element `ref` attributes that hold `jr:itext('X')`.
	for (const el of findAll((el) => {
		const ref = getAttributeValue(el, "ref");
		return !!ref && ref.startsWith("jr:itext('");
	}, model.doc.children)) {
		const ref = getAttributeValue(el, "ref");
		if (!ref) continue;
		const match = ref.match(JR_ITEXT_REF_PATTERN);
		if (!match) continue;
		reportMissing(match[1]);
	}

	// Surface 2 — `<bind jr:constraintMsg="jr:itext('X')">`. The bind-attribute
	// scan ALWAYS runs against `<bind>` regardless of the attribute holding the
	// reference, because the prefix predicate above can't reach attributes other
	// than `ref` (it filters on `ref`'s value).
	for (const bind of findAll((el) => el.name === "bind", model.doc.children)) {
		const constraintMsg = getAttributeValue(bind, "jr:constraintMsg");
		if (constraintMsg === undefined) continue;
		const match = constraintMsg.match(JR_ITEXT_REF_PATTERN);
		// A non-itext `jr:constraintMsg` is a separate validity concern (HQ's
		// XForm parser only honors the `jr:itext(...)` shape), out of this
		// oracle's scope — the emitter is constrained at the source to emit only
		// the itext form (see `xform/builder.ts::buildLeafField`).
		if (!match) continue;
		reportMissing(match[1]);
	}

	return errors;
}

// ── Media-value resolution (jr:// path → manifest) ─────────────────

/**
 * The `jr://file/` prefix every CommCare media reference carries — Nova's
 * emitters always emit the full reference, never a bare wire path. The media-
 * value scan strips this prefix before comparing against the manifest, which
 * carries wire paths (`commcare/<hash><ext>`).
 */
const JR_FILE_PREFIX = "jr://file/";

/**
 * Resolution of every `<value form="image|audio|video">jr://file/...</value>`
 * itext sibling against the bundled-media manifest. The manifest carries the
 * `commcare/<hash><ext>` wire paths the compiler wrote into the CCZ archive;
 * an itext media value pointing at a path NOT in that set would render as a
 * broken icon on device — the runtime resolves the reference against the
 * media-suite descriptor (`media_suite.xml`) which derives from the same
 * manifest, so the reference and the bundle must agree on every path.
 *
 * Skipped when `mediaManifest === undefined` — that's the media-OFF mode
 * every existing caller still runs in (no media emission at all), where the
 * form carries no media `<value>` siblings to resolve.
 *
 * `<value>` text content is read off the element's children: `domhandler`
 * stores element text as a child `Text` node, and any whitespace/text
 * concatenation is what `.children[*].data` collects.
 */
function checkMediaValues(
	model: XFormModel,
	mediaManifest: ReadonlySet<string> | undefined,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	if (mediaManifest === undefined) return [];
	const errors: ValidationError[] = [];

	for (const valueEl of findAll(
		(el) => el.name === "value",
		model.doc.children,
	)) {
		const form = getAttributeValue(valueEl, "form");
		// Media values carry one of the three image/audio/video forms. The plain
		// `<value>` (no form) is the text translation; markdown / vellum forms
		// are non-media and out of scope here.
		if (form !== "image" && form !== "audio" && form !== "video") continue;

		const refText = readElementText(valueEl).trim();
		if (refText === "") continue;
		if (!refText.startsWith(JR_FILE_PREFIX)) continue;

		const wirePath = refText.slice(JR_FILE_PREFIX.length);
		if (mediaManifest.has(wirePath)) continue;

		errors.push(
			validationError(
				"XFORM_DANGLING_MEDIA_REF",
				"form",
				`"${formName}" has a <value form="${form}"> referencing "${refText}", but the compile-time media manifest has no entry for "${wirePath}". The device resolves this jr:// reference against media_suite.xml's local resources, so a reference without a bundled file renders as a broken icon. This is a bug in the form generator.`,
				loc,
			),
		);
	}

	return errors;
}

/**
 * Concatenate every direct text-child of an element. Mirrors
 * `XFormParser::parseTextOrLocale`'s `parser.nextText()` read — KXmlParser
 * collapses contiguous text into one read; `domhandler` keeps them as
 * adjacent `Text` nodes, so the equivalent here is a children sweep.
 */
function readElementText(el: Element): string {
	let acc = "";
	for (const child of getChildren(el)) {
		if (isTag(child)) continue;
		// `domhandler`'s `Text` nodes expose `.data`; the type isn't `Element` so
		// the property access goes through a structural lookup.
		const data = (child as { data?: string }).data;
		if (typeof data === "string") acc += data;
	}
	return acc;
}

// ── Namespace declarations (#0 — malformedness) ────────────────────

/** XML namespace prefixes that are always available without an explicit
 *  `xmlns:` declaration. */
const RESERVED_NS_PREFIXES = new Set(["xml"]);

/**
 * Every namespace prefix used on an element or attribute NAME must be
 * declared somewhere via `xmlns:<prefix>`. An undeclared prefix makes the
 * whole document malformed XML: CCHQ's namespace-aware parser rejects the
 * form, and on the multimedia path `FormMediaMixin.all_media` then returns
 * empty (the form never parses), so EVERY media reference silently fails to
 * attach on upload.
 *
 * `fast-xml-parser`'s validator (the model's parse gate) does NOT check
 * namespace declarations, so this is the check that catches an emitter that
 * uses a prefix it forgot to declare (e.g. an `<orx:meta>` emitted without
 * its `xmlns:orx` declaration). "Declared anywhere" counts as available — this flags
 * never-declared prefixes, not strict per-element scoping, so a
 * correctly-scoped prefix never trips it.
 */
function checkNamespacePrefixes(
	doc: Document,
	formName: string,
	loc: ValidationLocation,
): ValidationError[] {
	const declared = new Set<string>();
	const used = new Set<string>();
	for (const el of findAll(() => true, doc.children)) {
		const nameColon = el.name.indexOf(":");
		if (nameColon !== -1) used.add(el.name.slice(0, nameColon));
		for (const attr of Object.keys(el.attribs)) {
			if (attr === "xmlns") continue; // the default namespace carries no prefix
			if (attr.startsWith("xmlns:")) {
				declared.add(attr.slice("xmlns:".length));
				continue;
			}
			const attrColon = attr.indexOf(":");
			if (attrColon !== -1) used.add(attr.slice(0, attrColon));
		}
	}
	const errors: ValidationError[] = [];
	for (const prefix of used) {
		if (RESERVED_NS_PREFIXES.has(prefix) || declared.has(prefix)) continue;
		errors.push(
			validationError(
				"XFORM_PARSE_ERROR",
				"form",
				`"${formName}" uses the XML namespace prefix "${prefix}:" but never declares it (no matching xmlns:${prefix}). That makes the whole form malformed XML — CCHQ's parser rejects it, which silently breaks every media reference on upload. This is a bug in the form generator.`,
				loc,
			),
		);
	}
	return errors;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validate a generated XForm XML string against CommCare Core's parse-time
 * FATAL contract. Returns structured errors (empty array on a clean form). The
 * `(xml, formName, moduleName) → ValidationError[]` shape feeds the existing
 * error pipeline directly; the emitter test suites and
 * `lib/commcare/compiler.ts` consume it unchanged.
 *
 * `mediaManifest`, when supplied, is the closed set of `commcare/<hash><ext>`
 * wire paths bundled into the CCZ archive (the same paths
 * `media_suite.xml`'s `<location>` elements point at). The oracle then
 * additionally proves every `<value form="image|audio|video">jr://file/...`
 * itext sibling resolves into that set — an unresolved reference would render
 * as a broken icon on device. Omit (or pass `undefined`) on the media-OFF
 * path: the form then carries no media value siblings to resolve.
 */
export function validateXForm(
	xml: string,
	formName: string,
	moduleName: string,
	mediaManifest?: ReadonlySet<string>,
): ValidationError[] {
	const loc = { formName, moduleName };

	// The shared model is parse-gate + DOM walk in one. A `fatal` return is the
	// only parse-failure path — XForm malformedness or a missing main
	// `<instance>` element. The binding-resolution oracle reads off the same
	// model in the same `compileCcz` pass.
	const built = buildXFormDataModel(xml, formName, moduleName);
	if ("fatal" in built) return [built.fatal];
	const model = built.model;
	const doc = model.doc;

	// Run every invariant against the shared model. Order is cosmetic — errors
	// accumulate into one flat array the caller renders.
	return [
		...checkNamespacePrefixes(doc, formName, loc),
		...checkTranslations(doc, formName, loc),
		...checkItextDefinitions(doc, formName, loc),
		...checkBinds(model, formName, loc),
		...checkControls(model, formName, loc),
		...checkRepeats(model, formName, loc),
		...checkSetValues(model, formName, loc),
		...checkOutputs(model, formName, loc),
		...checkItextReferences(model, formName, loc),
		...checkMediaValues(model, mediaManifest, formName, loc),
	];
}
