/**
 * XForm XML emitter.
 *
 * Walks a single form in the normalized `BlueprintDoc` and emits its
 * complete XForm XML: `<instance>` data nodes, `<bind>` elements, setvalues,
 * body controls (input, select, group, repeat, trigger, upload, secret),
 * itext translation entries, Connect data blocks, and the secondary
 * instance declarations required by any XPath or label that references
 * `#case/`, `#user/`, or the commcare session.
 *
 * The emitter CONSTRUCTS a `domhandler` element tree and serializes it once
 * with `dom-serializer`; it never assembles XML by string concatenation. This
 * is a deliberate totality property: a string-concatenated emitter can produce
 * malformed bytes (an unescaped `<` in a label, an unbalanced tag from a
 * mishandled edge case), and only a test can catch it after the fact. A
 * constructed tree is well-formed BY CONSTRUCTION — the serializer owns every
 * byte of escaping and tag balancing, so malformed output is unrepresentable,
 * not merely untested. `escapeXml` is intentionally absent from this file:
 * hand-escaping a value and then handing it to the serializer would
 * double-encode it (`&` → `&amp;` → `&amp;amp;`), so the serializer is the
 * single, exclusive escaping authority here.
 *
 * Walkers consume `doc.fieldOrder[parentUuid]` and `doc.fields[fieldUuid]`,
 * using `doc.fieldOrder[fieldUuid]` being defined as the "this field is a
 * container" marker. The caller supplies the random xmlns and optional
 * Connect config via `BuildXFormOptions`.
 *
 * Every CommCare wire invariant this file encodes — the dual `vellum:*`
 * attribute pattern, markdown-form itext duplication, hashtag-prose
 * wrapping, `jr:itext(...)` constraint messages, `jr-insert` defaults
 * inside repeats, secondary-instance accumulation — is part of what
 * HQ and the Vellum editor expect on import. Do not "simplify" the
 * emitted bytes.
 */

import render from "dom-serializer";
import { type ChildNode, Element, Text } from "domhandler";
import { decodeXML } from "entities";
import {
	expandHashtags,
	extractHashtags,
	hasHashtags,
	RESERVED_XFORM_NODE_PREFIX,
	supportsValidation,
	VELLUM_HASHTAG_TRANSFORMS,
} from "@/lib/commcare";
import { effectiveDeliverEntities } from "@/lib/commcare/connectDefaults";
import type { ResolvedConnectConfig } from "@/lib/commcare/connectSlugs";
import { readFieldString } from "@/lib/commcare/fieldProps";
import { isCountReferencePath } from "@/lib/commcare/xform/countReference";
import { buildMetaBlock } from "@/lib/commcare/xform/metaBlock";
import type { BlueprintDoc, Field, FieldKind, Uuid } from "@/lib/domain";

/**
 * Serializer options. `xmlMode` so element names / namespaces / self-closing
 * follow XML rules; `selfClosingTags` so empty elements render `<x/>`;
 * `encodeEntities: "utf8"` so the serializer escapes `<` / `>` / `&` / `"` /
 * `'` in text and attribute values exactly once. The `'` → `&apos;` and `"` →
 * `&quot;` encodings are XML-spec-equivalent to the literal characters (a
 * conforming parser decodes them back identically), so emitting them rather
 * than the bare characters is a no-op for CommCare and Vellum.
 */
const RENDER_OPTS = {
	xmlMode: true,
	selfClosingTags: true,
	encodeEntities: "utf8" as const,
} as const;

// ── Element construction helpers ─────────────────────────────────────
//
// One-line constructors so the field walk reads as a tree literal rather than
// a wall of `new Element(...)`. `el` builds an element with attributes +
// element children; `text` builds a Text node. Attribute values are passed
// RAW (un-escaped) — the serializer escapes them, and any pre-escaping here
// would double-encode. Children's parent pointers stay unset until final
// assembly under `<h:html>`; the slot-array accumulators below rely on
// elements being orphaned during the walk so a placeholder can be swapped out
// by array index without disturbing a tree structure.

/** Build an element with raw attribute values and optional element children. */
function el(
	name: string,
	attribs: Record<string, string>,
	children: ChildNode[] = [],
): Element {
	return new Element(name, attribs, children);
}

/** Build a Text node carrying raw character data (serializer escapes it). */
function text(data: string): Text {
	return new Text(data);
}

/**
 * Bare-hashtag pattern for label / hint prose.
 *
 * Label text is natural language, NOT XPath — markdown syntax like `**`
 * around `#case/...` would parse as a multiplication operator under the
 * Lezer XPath grammar, so we match with a focused regex here and reserve
 * Lezer for actual XPath expressions.
 */
const BARE_HASHTAG_RE = /#(case|form|user)(\/[a-zA-Z_][a-zA-Z0-9_-]*)+/g;

/**
 * Build the ordered itext-value node list for one label / hint string, letting
 * `dom-serializer` (at final assembly) own ALL escaping.
 *
 * A label is natural-language PROSE that may embed Nova hashtag references
 * (`#case/name`, `#form/x`, `#user/y`). It is NOT markup. The earlier
 * approach parsed the whole label as XML to find the markup Nova itself had
 * just stitched in — and that whole-label parse is exactly what read an
 * author run like `(<2kg` as a bogus tag (leaking an invalid bare `<` that
 * CommCare HQ hard-rejects) and `<country><number>` as nested elements
 * (silent itext corruption). Issues #3 and #15.
 *
 * Instead we CONSTRUCT a DOM directly and never parse the label as markup:
 *
 *   - Prose runs (everything between hashtag matches) become a `Text` node
 *     whose data is `decodeXML(run)`. Decoding normalizes any pre-escaped
 *     entity the author may have typed (the historical `&lt;` workaround → `<`)
 *     so the serializer re-escapes it exactly once — `&lt;`, never the
 *     double-escaped `&amp;lt;` that would show a literal `&lt;` on device.
 *   - Each hashtag match becomes a constructed self-closing `<output>`
 *     element: `value` holds the expanded instance XPath, and the parallel
 *     `vellum:value` holds the original shorthand — but only when expansion
 *     changed the string (a non-expanding ref needs no round-trip shadow).
 *     This is the ONLY source of `<output>` elements: hashtags in prose are
 *     an SA-authoring concept Nova lowers to `<output>` here.
 *
 * Author-written `<output ...>` markup is deliberately NOT recognized — it
 * is not a supported authoring input (the SA and field editor emit
 * hashtags, never raw markup). A label that literally contains `<output>`
 * text is just prose, so it serializes as escaped literal text like any
 * other `<`.
 *
 * Returns a fresh node array on every call: the dual `<value>` + `<value
 * form="markdown">` itext duplicate needs INDEPENDENT node instances under the
 * two `<value>` parents (a domhandler node has a single parent pointer, so
 * sharing instances would re-parent and corrupt the first `<value>`), and
 * calling this builder once per `<value>` is how the caller gets them.
 *
 * The `BARE_HASHTAG_RE` regex (not the Lezer XPath parser) locates hashtag
 * spans because labels are prose: surrounding markdown like `**` (bold) around
 * a `#` ref parses as XPath operators under the grammar and would swallow the
 * `#`, so the structural XPath parser is the wrong tool for prose scanning here.
 */
function buildLabelNodes(label: string): ChildNode[] {
	const nodes: ChildNode[] = [];
	// `BARE_HASHTAG_RE` is a module-level /g regex; reset `lastIndex` so a
	// prior call's state never leaks into this walk.
	BARE_HASHTAG_RE.lastIndex = 0;
	let cursor = 0;
	let match: RegExpExecArray | null = BARE_HASHTAG_RE.exec(label);
	while (match !== null) {
		// Prose before this hashtag → a Text node (decoded so the serializer
		// escapes exactly once).
		if (match.index > cursor) {
			nodes.push(text(decodeXML(label.slice(cursor, match.index))));
		}
		// The hashtag → a constructed <output> element. `value` is the expanded
		// XPath; `vellum:value` shadows the original shorthand only when
		// expansion actually changed it (Vellum round-trip).
		const original = match[0];
		const expanded = expandHashtags(original);
		const attribs: Record<string, string> = { value: expanded };
		if (original !== expanded) attribs["vellum:value"] = original;
		nodes.push(el("output", attribs));
		cursor = match.index + original.length;
		match = BARE_HASHTAG_RE.exec(label);
	}
	// Trailing prose after the last hashtag (or the whole string when there
	// were no hashtags at all).
	if (cursor < label.length) {
		nodes.push(text(decodeXML(label.slice(cursor))));
	}
	return nodes;
}

// ── Secondary-instance tracker ───────────────────────────────────────
//
// XPath + label sub-builders register any `casedb` / `commcaresession`
// usage as they produce their bind attributes; the tracker emits the
// matching `<instance>` elements once at the end. Requiring `casedb`
// implicitly requires `commcaresession` — every case XPath pulls the
// current `case_id` out of the session.

type InstanceId = "casedb" | "commcaresession";

const INSTANCE_SOURCES: Record<InstanceId, string> = {
	casedb: "jr://instance/casedb",
	commcaresession: "jr://instance/session",
};

class InstanceTracker {
	private ids = new Set<InstanceId>();

	require(id: InstanceId): void {
		this.ids.add(id);
		if (id === "casedb") this.ids.add("commcaresession");
	}

	/** Scan a pre-expansion XPath expression for instance references. */
	scanXPath(expr: string): void {
		if (
			expr.includes("#case/") ||
			expr.includes("#user/") ||
			expr.includes("instance('casedb')")
		) {
			this.require("casedb");
		}
		if (expr.includes("instance('commcaresession')")) {
			this.require("commcaresession");
		}
	}

	/** Scan label / hint prose for `#case/` or `#user/` hashtag references. */
	scanLabel(label: string): void {
		if (/#(case|user)\//.test(label)) this.require("casedb");
	}

	/** The `<instance>` elements for every accumulated id, in canonical order. */
	toElements(): Element[] {
		return (["casedb", "commcaresession"] as const)
			.filter((id) => this.ids.has(id))
			.map((id) => el("instance", { src: INSTANCE_SOURCES[id], id }));
	}
}

const CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn";

/**
 * Build the Connect data blocks + matching binds for a form.
 *
 * Each Connect entity uses a two-level wrapper Vellum recognizes via the
 * `vellum:role` attribute: without it, HQ treats the wrapper as a plain
 * hidden XForm node and the child binds (user_score, entity_id, etc.)
 * fail at runtime. Each wrapper gets its own `vellum:nodeset` bind plus
 * a bind per declared sub-node so CommCare has paths to write to.
 */
function buildConnectBlocks(
	connect: ResolvedConnectConfig | undefined,
	instances: InstanceTracker,
): { dataElements: Element[]; binds: Element[] } {
	const dataElements: Element[] = [];
	const binds: Element[] = [];

	if (!connect) return { dataElements, binds };

	if (connect.learn_module) {
		const lm = connect.learn_module;
		// `lm.id` is the connect block's id — already a valid, unique, ≤50
		// slug (forced correct at the source; the resolver only passed it
		// through). It threads identically into the wrapper element name, the
		// `id=` attribute, and the bind nodeset below, so all three references
		// to this block always agree.
		const lmId = lm.id;
		dataElements.push(
			el(lmId, { "vellum:role": "ConnectLearnModule" }, [
				el("module", { xmlns: CONNECT_XMLNS, id: lmId }, [
					el("name", {}, [text(lm.name)]),
					el("description", {}, [text(lm.description)]),
					el("time_estimate", {}, [text(String(lm.time_estimate))]),
				]),
			]),
		);
		binds.push(
			el("bind", {
				"vellum:nodeset": `#form/${lmId}`,
				nodeset: `/data/${lmId}`,
			}),
		);
	}

	if (connect.assessment) {
		const assessId = connect.assessment.id;
		instances.scanXPath(connect.assessment.user_score);
		dataElements.push(
			el(assessId, { "vellum:role": "ConnectAssessment" }, [
				el("assessment", { xmlns: CONNECT_XMLNS, id: assessId }, [
					el("user_score", {}),
				]),
			]),
		);
		binds.push(
			el("bind", {
				"vellum:nodeset": `#form/${assessId}`,
				nodeset: `/data/${assessId}`,
			}),
			el("bind", {
				nodeset: `/data/${assessId}/assessment/user_score`,
				calculate: expandHashtags(connect.assessment.user_score),
			}),
		);
	}

	if (connect.deliver_unit) {
		const du = connect.deliver_unit;
		const duId = du.id;
		// `entity_id` / `entity_name` are optional in the domain.
		// `effectiveDeliverEntities` resolves them against the canonical
		// defaults — same helper the session-preload builder calls, so
		// the bind XML and the case-references load map agree on which
		// XPaths actually run at form-fill time.
		const { entityId, entityName } = effectiveDeliverEntities(du);
		instances.scanXPath(entityId);
		instances.scanXPath(entityName);
		dataElements.push(
			el(duId, { "vellum:role": "ConnectDeliverUnit" }, [
				el("deliver", { xmlns: CONNECT_XMLNS, id: duId }, [
					el("name", {}, [text(du.name)]),
					el("entity_id", {}),
					el("entity_name", {}),
				]),
			]),
		);
		binds.push(
			el("bind", {
				"vellum:nodeset": `#form/${duId}`,
				nodeset: `/data/${duId}`,
			}),
			el("bind", {
				nodeset: `/data/${duId}/deliver/entity_id`,
				calculate: expandHashtags(entityId),
			}),
			el("bind", {
				nodeset: `/data/${duId}/deliver/entity_name`,
				calculate: expandHashtags(entityName),
			}),
		);
	}

	if (connect.task) {
		const t = connect.task;
		const taskId = t.id;
		dataElements.push(
			el(taskId, { "vellum:role": "ConnectTask" }, [
				el("task", { xmlns: CONNECT_XMLNS, id: taskId }, [
					el("name", {}, [text(t.name)]),
					el("description", {}, [text(t.description)]),
				]),
			]),
		);
		binds.push(
			el("bind", {
				"vellum:nodeset": `#form/${taskId}`,
				nodeset: `/data/${taskId}`,
			}),
		);
	}

	return { dataElements, binds };
}

/**
 * Options threaded into `buildXForm`. `xmlns` is the random instance
 * namespace HQ expects on every form (generated once per form by the
 * expander); `connect` is the resolved Connect config to embed (the
 * pass-through output of `buildConnectSlugMap`, whose ids are valid by
 * construction at the source) — omitted when the app-level `connectType` is
 * unset or the form carries no Connect block.
 */
export interface BuildXFormOptions {
	xmlns: string;
	connect?: ResolvedConnectConfig;
}

/**
 * Emit the full XForm XML for `formUuid`. Walks the form's field order
 * (plus any container children), accumulates data / binds / setvalues /
 * body / itext / instances as constructed elements, assembles them under the
 * `<h:html>` root, and serializes the tree once.
 */
export function buildXForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	opts: BuildXFormOptions,
): string {
	const form = doc.forms[formUuid];
	const instances = new InstanceTracker();
	const dataElements: Element[] = [];
	const binds: Element[] = [];
	const setvalues: Element[] = [];
	const bodyElements: Element[] = [];
	const itextEntries: Element[] = [];

	// OpenRosa <meta> block — `<deviceID>`, `<timeStart>`, `<timeEnd>`,
	// `<username>`, `<userID>`, `<instanceID>`, `<appVersion>`, `<drift>`
	// plus the eight setvalues that populate them at form load. Always
	// emitted; the receiving systems (CCHQ, FormPlayer reports, mobile
	// sync) rely on it for audit + integrity. The setvalues reference
	// `instance('commcaresession')/session/context/...` so the form
	// inherently requires the session instance.
	const meta = buildMetaBlock();
	dataElements.push(meta.dataElement);
	setvalues.push(...meta.setvalues);
	instances.require("commcaresession");

	// Register an itext `<text>` entry. Every entry emits both the plain value
	// AND a `<value form="markdown">` duplicate — CommCare only renders
	// markdown when the markdown form is present, and it's a no-op for plain
	// text. Without the duplicate, `**bold**` renders as literal asterisks on
	// device. `buildLabelNodes` is called ONCE PER `<value>` so each gets
	// independent node instances (a domhandler node has a single parent).
	const addItext = (id: string, label: string | undefined): void => {
		if (!label) return;
		itextEntries.push(
			el("text", { id }, [
				el("value", {}, buildLabelNodes(label)),
				el("value", { form: "markdown" }, buildLabelNodes(label)),
			]),
		);
	};

	for (const fieldUuid of doc.fieldOrder[formUuid] ?? []) {
		buildFieldParts(
			doc,
			fieldUuid,
			"/data",
			// Top-level fields get an empty itext-key prefix, so their key is
			// just `field.id` — the common flat-form case.
			"",
			dataElements,
			binds,
			setvalues,
			bodyElements,
			false,
			addItext,
			instances,
			// At the top level the form-root arrays ARE the "top" arrays.
			// Inside containers these stay pointed at the root arrays (passed
			// through unchanged) so a hoisted count node always lands at
			// /data, never inside a group/repeat scope. See `dataElements`
			// vs `topDataElements` in `buildFieldParts`.
			dataElements,
			binds,
		);
	}

	// Connect data + binds are data-only (no body elements).
	const connectParts = buildConnectBlocks(opts.connect, instances);
	dataElements.push(...connectParts.dataElements);
	binds.push(...connectParts.binds);

	// Form name lowered to a slug for the `<data name>` attribute — the same
	// normalization the prior emitter applied.
	const dataName = form.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

	// Assemble the model: primary instance (the data tree), then the
	// accumulated secondary instances, binds, setvalues, and the itext block.
	// Element ORDER within the model is significant to JavaRosa's parse, so it
	// mirrors the prior emitter's sequence exactly: instance → secondary
	// instances → binds → setvalues → itext.
	const dataEl = el(
		"data",
		{
			xmlns: opts.xmlns,
			"xmlns:jrm": "http://dev.commcarehq.org/jr/xforms",
			uiVersion: "1",
			version: "1",
			name: dataName,
		},
		dataElements,
	);

	const modelChildren: ChildNode[] = [
		el("instance", {}, [dataEl]),
		...instances.toElements(),
		...binds,
		...setvalues,
		el("itext", {}, [
			el("translation", { lang: "en", default: "" }, itextEntries),
		]),
	];

	const html = el(
		"h:html",
		{
			"xmlns:h": "http://www.w3.org/1999/xhtml",
			xmlns: "http://www.w3.org/2002/xforms",
			"xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
			"xmlns:jr": "http://openrosa.org/javarosa",
			"xmlns:vellum": "http://commcarehq.org/xforms/vellum",
		},
		[
			el("h:head", {}, [
				el("h:title", {}, [text(form.name)]),
				el("model", {}, modelChildren),
			]),
			el("h:body", {}, bodyElements),
		],
	);

	// Single serialization of the whole tree. The XML declaration is the one
	// byte the serializer doesn't emit, so it's prepended literally.
	return `<?xml version="1.0"?>\n${render(html, RENDER_OPTS)}`;
}

/**
 * Read a field's `options` array regardless of which kind declares it.
 * Same rationale as `readFieldString` (lib/commcare/fieldProps.ts):
 * `options` appears only on select variants, so the accessor returns
 * `undefined` for kinds that don't carry it.
 */
function readOptions(
	field: Field,
): Array<{ value: string; label: string }> | undefined {
	const value = (field as unknown as Record<string, unknown>).options;
	return Array.isArray(value)
		? (value as Array<{ value: string; label: string }>)
		: undefined;
}

/**
 * Recursively emit the four XForm parts for a single field:
 *
 *   - `dataElements`: one `<instance>` data node per field
 *   - `binds`:       `<bind>` with expanded XPath + dual `vellum:*` attrs
 *   - `setvalues`:   `<setvalue>` for fields with a `default_value`
 *   - `bodyElements` + `itextEntries`: the `<h:body>` control + its labels
 *
 * Group / repeat containers recurse through `doc.fieldOrder[fieldUuid]` to
 * emit nested parts, then build their parent data element + container bind
 * from the children that were collected.
 *
 * `topDataElements` / `topBinds` always reference the FORM-ROOT data and
 * bind arrays, threaded through every recursion unchanged. They are the
 * landing site for synthetic nodes that must live at `/data` regardless of
 * how deeply the emitting field is nested — currently the hidden count node
 * a hoisted `count_bound` repeat needs (its `xforms-ready` setvalue fires at
 * form load, before any container template exists). The `setvalues` array is
 * already form-root-scoped for the same reason, so it needs no parallel.
 *
 * The data + bind placeholders are recorded by ARRAY SLOT (`dataSlot` /
 * `bindSlot`) and rewritten in place for containers, NOT `pop()`-ed after
 * recursion: a descendant repeat can append a hoisted synthetic count node to
 * this same array (the `topDataElements` thread aliases `dataElements` at form
 * root), so a blind `pop()` would remove that synthetic node instead of this
 * field's placeholder. Storing element refs (not strings) in the slot arrays
 * makes the in-place swap a plain index assignment; parents are assigned only
 * at final assembly under `<h:html>`, so the orphaned elements in these arrays
 * can be freely replaced by index during the walk.
 *
 * `itextKeyPrefix` is the ancestry prefix every itext id this field emits is
 * built from: `itextKey = itextKeyPrefix + field.id`, and children recurse
 * with `itextKey + "-"`. itext ids share a single flat namespace per form
 * (`<text id="...">`), and JavaRosa hard-rejects a duplicate id at parse
 * (`commcare-core .../xform/parse/XFormParser.java::parseTextHandle`). But a
 * `field.id` is unique only among SIBLINGS — cousins in different containers
 * may legally share one (the validator's `duplicateFieldIds` scopes
 * uniqueness to one level). Keying itext by `field.id` alone therefore
 * collides for two cousins sharing an id, producing an invalid form from a
 * valid authoring state. Threading the key forward from the field-id ancestry
 * (NOT recovered from the assembled node path — synthetic path segments like
 * the query_bound `/item` level must not leak into the key) makes every id
 * form-unique: cousins differ because their prefixes differ, siblings can't
 * collide because their ids are unique. itext ids are regenerated every emit
 * and never persisted, so the scheme carries no migration concern.
 */
function buildFieldParts(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	parentPath: string,
	itextKeyPrefix: string,
	dataElements: Element[],
	binds: Element[],
	setvalues: Element[],
	bodyElements: Element[],
	insideRepeat: boolean,
	addItext: (id: string, label: string | undefined) => void,
	instances: InstanceTracker,
	topDataElements: Element[],
	topBinds: Element[],
): void {
	const field = doc.fields[fieldUuid];
	const nodePath = `${parentPath}/${field.id}`;
	// Form-unique itext key, built forward from the field-id ancestry (see the
	// `itextKeyPrefix` paragraph above). Every `<text id>` definition and every
	// `jr:itext('...')` reference this field emits derives from this one value.
	const itextKey = itextKeyPrefix + field.id;

	const relevant = readFieldString(field, "relevant");
	const validate = readFieldString(field, "validate");
	const validateMsg = readFieldString(field, "validate_msg");
	const calculate = readFieldString(field, "calculate");
	const defaultValue = readFieldString(field, "default_value");
	const required = readFieldString(field, "required");
	const label = readFieldString(field, "label");
	const hint = readFieldString(field, "hint");

	// Secondary-instance requirements: any XPath that mentions `#case/`,
	// `#user/`, or a raw `instance('casedb')` / `instance('commcaresession')`
	// reference forces us to declare the matching `<instance>` later.
	for (const expr of [relevant, validate, calculate, defaultValue, required]) {
		if (expr) instances.scanXPath(expr);
	}
	for (const labelText of [label, hint]) {
		if (labelText) instances.scanLabel(labelText);
	}

	// One `<instance>` data node per field. Replaced IN PLACE for containers
	// once children have been emitted below. We record the slot index now
	// rather than `pop()`-ing after recursion, because a descendant repeat
	// can append a hoisted synthetic count node to this same array (the
	// `topDataElements` thread aliases `dataElements` at form root) — a blind
	// `pop()` would remove that synthetic node instead of this placeholder.
	const dataSlot = dataElements.length;
	dataElements.push(el(field.id, {}));

	// Bind: real attributes get expanded XPath; `vellum:*` attrs preserve the
	// original shorthand for the Vellum editor on round-trip. Attributes are
	// accumulated in an ordered object so the emitted attribute sequence
	// matches the prior emitter (the serializer preserves insertion order).
	const vellumPath = `#form${nodePath.slice(5)}`; // "/data/x" → "#form/x"
	const bindAttribs: Record<string, string> = {
		"vellum:nodeset": vellumPath,
		nodeset: nodePath,
	};
	const xsdType = getXsdType(field.kind);
	if (xsdType) bindAttribs.type = xsdType;
	if (required) {
		if (hasHashtags(required)) bindAttribs["vellum:required"] = required;
		bindAttribs.required = expandHashtags(required);
	}

	// Validation (constraint + constraintMsg) is meaningful only on input
	// kinds. Structural (group/repeat/label) and computed (hidden) fields have
	// no user-editable value to check — silently skip the attributes so an
	// upstream misconfiguration can't leak a garbage bind. The validator flags
	// `validate` on non-input kinds as its own error.
	const canValidate = supportsValidation(field.kind);
	if (canValidate && validate) {
		if (hasHashtags(validate)) bindAttribs["vellum:constraint"] = validate;
		bindAttribs.constraint = expandHashtags(validate);
	}

	// `jr:constraintMsg` MUST be an itext reference — HQ's XForm parser only
	// reads the attribute when it points at an itext id via `jr:itext(...)`, so
	// inline text would vanish on upload. The matching `<text>` entry is
	// registered below when `canValidate` holds.
	if (canValidate && validateMsg) {
		bindAttribs["jr:constraintMsg"] = `jr:itext('${itextKey}-constraintMsg')`;
	}

	if (relevant) {
		if (hasHashtags(relevant)) bindAttribs["vellum:relevant"] = relevant;
		bindAttribs.relevant = expandHashtags(relevant);
	}
	if (calculate) {
		if (hasHashtags(calculate)) bindAttribs["vellum:calculate"] = calculate;
		bindAttribs.calculate = expandHashtags(calculate);
	}

	// Setvalue for `default_value`. Inside a repeat group we fire on `jr-insert`
	// so each new iteration gets the default; outside, the one-shot
	// `xforms-ready` event is correct.
	if (defaultValue) {
		const setvalueAttribs: Record<string, string> = {
			event: insideRepeat ? "jr-insert" : "xforms-ready",
			"vellum:ref": vellumPath,
			ref: nodePath,
		};
		if (hasHashtags(defaultValue))
			setvalueAttribs["vellum:value"] = defaultValue;
		setvalueAttribs.value = expandHashtags(defaultValue);
		setvalues.push(el("setvalue", setvalueAttribs));
	}

	// Vellum hashtag metadata: the editor needs the hashtag map + the shared
	// transforms table to round-trip `#case/` / `#user/` refs. Scan only the
	// expressions that actually made it onto the bind (validation was dropped
	// for non-input kinds above).
	const xpathExprs: string[] = [];
	if (relevant) xpathExprs.push(relevant);
	if (canValidate && validate) xpathExprs.push(validate);
	if (calculate) xpathExprs.push(calculate);
	if (defaultValue) xpathExprs.push(defaultValue);
	if (required) xpathExprs.push(required);

	const hashtags = extractHashtags(xpathExprs);
	if (hashtags.length > 0) {
		const hashtagMap = Object.fromEntries(hashtags.map((h) => [h, null]));
		bindAttribs["vellum:hashtags"] = JSON.stringify(hashtagMap);
		bindAttribs["vellum:hashtagTransforms"] = JSON.stringify(
			VELLUM_HASHTAG_TRANSFORMS,
		);
	}
	// Record this leaf bind's slot so a container can rewrite it IN PLACE after
	// recursion — same reasoning as `dataSlot`: a descendant repeat may append
	// a hoisted count node's bind to this same array, so a blind `pop()` would
	// remove the wrong entry.
	const bindSlot = binds.length;
	binds.push(el("bind", bindAttribs));

	// itext. Hidden kinds have no body element, so no label to reference.
	if (field.kind !== "hidden" && label) {
		addItext(`${itextKey}-label`, label);
		addItext(`${itextKey}-hint`, hint);
	}

	// Validate message itext — paired with the `jr:constraintMsg` attribute
	// above; never emit the entry without the reference, or vice versa.
	if (canValidate) {
		addItext(`${itextKey}-constraintMsg`, validateMsg);
	}

	// Options (select kinds).
	//
	// itext ids are keyed by the option's stable array INDEX, not its `value` —
	// `${itextKey}-opt${index}-label`. Two options may legally share a `value`
	// (the domain's `selectOptionSchema` is `{ value, label }` with no
	// uniqueness constraint), but a value-keyed itext id would then collapse
	// both onto one id. CommCare's XForm parser hard-rejects a duplicate itext
	// id (`commcare-core/.../xform/parse/XFormParser.java::verifyTextMappings`,
	// reached from `parseItem`'s label-ref check), while it accepts two
	// `<item>`s sharing a `<value>` with no objection
	// (`XFormParser.java::parseItem` adds each `SelectChoice` with no
	// value-uniqueness check). So the collision lived purely in the itext
	// layer; an index key makes the id unique by construction. The `<item>`
	// emission below uses the identical scheme so no `<label ref>` dangles.
	const options = readOptions(field);
	if (options && options.length > 0) {
		options.forEach((opt, index) => {
			addItext(`${itextKey}-opt${index}-label`, opt.label);
		});
	}

	// Body element (varies by kind).
	if (field.kind === "hidden") {
		return; // no body; data + bind only
	}

	if (field.kind === "group" || field.kind === "repeat") {
		buildContainer(
			doc,
			field,
			fieldUuid,
			nodePath,
			vellumPath,
			itextKey,
			label,
			relevant,
			insideRepeat,
			dataSlot,
			bindSlot,
			dataElements,
			binds,
			setvalues,
			bodyElements,
			addItext,
			instances,
			topDataElements,
			topBinds,
		);
		return;
	}

	// Leaf controls — every one carries a `<label>` referencing the field's
	// itext id, plus an optional `<hint>`. The control element + any
	// kind-specific attributes are decided by `buildLeafControl`.
	bodyElements.push(buildLeafControl(field, nodePath, itextKey, hint));
}

/**
 * Build the `<h:body>` control for a non-container, non-hidden leaf field. All
 * leaf kinds share the `<label>` + optional `<hint>` itext-reference shape;
 * they differ only in the wrapping control element and its attributes:
 *
 *   - select kinds → `<select1>` / `<select>` with one `<item>` per option;
 *   - label kind   → `<trigger appearance="minimal">`;
 *   - secret kind  → `<secret>`;
 *   - media kinds  → `<upload mediatype="...">` (+ `appearance="signature"`);
 *   - everything else (text/int/date/...) → `<input>`.
 */
function buildLeafControl(
	field: Field,
	nodePath: string,
	itextKey: string,
	hint: string | undefined,
): Element {
	// The shared head of every control: the label reference, then the optional
	// hint reference. Built once and reused across the kind branches.
	const head: Element[] = [
		el("label", { ref: `jr:itext('${itextKey}-label')` }),
	];
	if (hint) head.push(el("hint", { ref: `jr:itext('${itextKey}-hint')` }));

	if (field.kind === "single_select" || field.kind === "multi_select") {
		const tag = field.kind === "single_select" ? "select1" : "select";
		// Each `<item>`'s `<label ref>` references the same per-INDEX itext id
		// registered by the caller (`-opt${index}-label`), so duplicate option
		// values never collide. The `<value>` emits `opt.value` verbatim — the
		// serializer escapes it; JavaRosa permits duplicate `<value>`s.
		const options = readOptions(field) ?? [];
		const items = options.map((opt, index) =>
			el("item", {}, [
				el("label", { ref: `jr:itext('${itextKey}-opt${index}-label')` }),
				el("value", {}, [text(opt.value)]),
			]),
		);
		return el(tag, { ref: nodePath }, [...head, ...items]);
	}

	if (field.kind === "label") {
		return el("trigger", { ref: nodePath, appearance: "minimal" }, head);
	}

	if (field.kind === "secret") {
		return el("secret", { ref: nodePath }, head);
	}

	if (
		field.kind === "image" ||
		field.kind === "audio" ||
		field.kind === "video" ||
		field.kind === "signature"
	) {
		const mediatype =
			field.kind === "audio"
				? "audio/*"
				: field.kind === "video"
					? "video/*"
					: "image/*";
		const uploadAttribs: Record<string, string> = {
			ref: nodePath,
			mediatype,
		};
		if (field.kind === "signature") uploadAttribs.appearance = "signature";
		return el("upload", uploadAttribs, head);
	}

	// Remaining input kinds: text, int, decimal, date, time, datetime,
	// geopoint, barcode. They all render as `<input>` with the XSD type on the
	// bind (added by the caller).
	return el("input", { ref: nodePath }, head);
}

/**
 * Build a `group` / `repeat` container: recurse through children, rewrite the
 * parent data element + bind to wrap them, and emit the `<h:body>` control.
 *
 * Extracted from `buildFieldParts` because the container path is the bulk of
 * the per-kind logic (three repeat modes, the count-hoist machinery, the
 * model-iteration setvalue setup) and keeping it inline made the field walk
 * unreadable. The slot-rewrite contract is preserved exactly: the data
 * placeholder at `dataSlot` and the bind placeholder at `bindSlot` are
 * replaced in place (never `pop()`-ed), because a descendant repeat may have
 * appended a hoisted count node after them.
 */
function buildContainer(
	doc: BlueprintDoc,
	field: Field,
	fieldUuid: Uuid,
	nodePath: string,
	vellumPath: string,
	itextKey: string,
	label: string | undefined,
	relevant: string | undefined,
	insideRepeat: boolean,
	dataSlot: number,
	bindSlot: number,
	dataElements: Element[],
	binds: Element[],
	setvalues: Element[],
	bodyElements: Element[],
	addItext: (id: string, label: string | undefined) => void,
	instances: InstanceTracker,
	topDataElements: Element[],
	topBinds: Element[],
): void {
	// Containers recurse through children, then rewrite the parent data element
	// to wrap them and swap the leaf bind for a container bind (relevant-only
	// when one was set).
	const childData: Element[] = [];
	const childBinds: Element[] = [];
	const childBody: Element[] = [];
	const childInsideRepeat = field.kind === "repeat" ? true : insideRepeat;

	// Query-bound repeats nest children under an extra `<item>` level (Vellum's
	// "model iteration" pattern). The outer `<id>` element holds
	// `@ids` / `@count` / `@current_index`; the inner `<item>` is the
	// per-iteration template. Rewriting `childParentPath` here propagates
	// `/item` into every descendant's bind nodeset, body ref, and setvalue ref
	// — not just the data section. user_controlled and count_bound repeats keep
	// the flat `<id>...</id>` shape with no rewrite.
	const isQueryBoundRepeat =
		field.kind === "repeat" && field.repeat_mode === "query_bound";
	const childParentPath = isQueryBoundRepeat ? `${nodePath}/item` : nodePath;

	for (const childUuid of doc.fieldOrder[fieldUuid] ?? []) {
		buildFieldParts(
			doc,
			childUuid,
			childParentPath,
			// Children's itext keys hang off this field's key — the ancestry
			// prefix grows by one segment per nesting level, keeping cousins in
			// distinct subtrees from ever colliding.
			`${itextKey}-`,
			childData,
			childBinds,
			setvalues,
			childBody,
			childInsideRepeat,
			addItext,
			instances,
			// Pass the form-root arrays through unchanged — synthetic nodes
			// always land at /data, never in this container's childData/childBinds
			// scope.
			topDataElements,
			topBinds,
		);
	}

	// Rewrite the self-closing data placeholder with a proper parent wrapping
	// its children. Three shapes:
	//   - group: `<id>...</id>`
	//   - user_controlled / count_bound repeat: `<id jr:template="">...</id>`
	//   - query_bound repeat: `<id ids="" count="" current_index=""
	//       vellum:role="Repeat"><item id="" index="" jr:template="">...
	//       </item></id>`
	// The query_bound shape mirrors Vellum's model-iteration emission. The four
	// attribute slots on the outer `<id>` are load-bearing:
	//   - `ids` and `count` are seeded by setvalue at xforms-ready (or jr-insert
	//     when nested) from the configured ids_query.
	//   - `current_index` is set by a `<bind calculate>` to `count(${nodePath}/
	//     item)` — JavaRosa updates it as items materialize, and the
	//     per-iteration `@index` setvalue reads it at jr-insert time. Without
	//     this slot the model-iteration pattern collapses (every iteration reads
	//     position 0).
	//   - `vellum:role="Repeat"` is the round-trip metadata Vellum uses to
	//     recognize a model-iteration container on import.
	// Replace the placeholder at its recorded slot (NOT `pop()` — a descendant
	// repeat may have appended a hoisted count node after it).
	if (isQueryBoundRepeat) {
		dataElements[dataSlot] = el(
			field.id,
			{
				ids: "",
				count: "",
				current_index: "",
				"vellum:role": "Repeat",
			},
			[el("item", { id: "", index: "", "jr:template": "" }, childData)],
		);
	} else {
		const containerAttribs: Record<string, string> =
			field.kind === "repeat" ? { "jr:template": "" } : {};
		dataElements[dataSlot] = el(field.id, containerAttribs, childData);
	}

	// Rewrite the leaf bind at its recorded slot. Containers don't carry
	// validation / calculate / required on their own node, so the leaf bind
	// becomes either a relevant-only container bind (when `relevant` is set) or
	// is dropped entirely. Child binds always append at the end (order is
	// irrelevant to JavaRosa).
	if (relevant) {
		const groupBindAttribs: Record<string, string> = {
			"vellum:nodeset": vellumPath,
			nodeset: nodePath,
		};
		if (hasHashtags(relevant)) groupBindAttribs["vellum:relevant"] = relevant;
		groupBindAttribs.relevant = expandHashtags(relevant);
		binds[bindSlot] = el("bind", groupBindAttribs);
	} else {
		// Drop the leaf bind in place. `splice` (not `pop`) so any synthetic
		// bind a descendant appended after this slot is kept.
		binds.splice(bindSlot, 1);
	}
	binds.push(...childBinds);

	// `<label>` is gated on a truthy `label`. Container kinds (`group`,
	// `repeat`) extend `containerFieldBase` (label optional); when label is
	// empty/absent, no itext entry is registered for it, so emitting an
	// unconditional `<label ref="jr:itext('${id}-label')"/>` would produce a
	// dangling reference the XForm oracle flags as `XFORM_MISSING_ITEXT`.
	// Skipping the element entirely is also what CommCare expects for
	// transparent structural containers — the runtime renders nothing for an
	// unlabeled group/repeat header.
	const labelEl = label
		? el("label", { ref: `jr:itext('${itextKey}-label')` })
		: undefined;

	if (field.kind === "repeat") {
		bodyElements.push(
			buildRepeatBody(
				field,
				nodePath,
				labelEl,
				childBody,
				insideRepeat,
				setvalues,
				binds,
				topDataElements,
				topBinds,
				instances,
			),
		);
		return;
	}

	// Group body: `<group ref>` wrapping the children. `appearance="field-list"`
	// is a CommCare semantic that drives single-page rendering of the group's
	// children. For a labelled group it's Nova's default; for an empty-label
	// (transparent) group, dropping the attribute matches the "no visual
	// impact" runtime semantic — there's no group chrome to anchor a field-list
	// layout against, so leaving it on would assert a layout posture the author
	// didn't ask for.
	const groupAttribs: Record<string, string> = { ref: nodePath };
	if (label) groupAttribs.appearance = "field-list";
	const groupChildren: Element[] = labelEl
		? [labelEl, ...childBody]
		: childBody;
	bodyElements.push(el("group", groupAttribs, groupChildren));
}

/**
 * Build the `<group><repeat>...</repeat></group>` body for a repeat container,
 * dispatching the three `repeat_mode` wire shapes. The surrounding `<group>`
 * wrapper + optional label is mode-invariant; the `<repeat>` attributes and any
 * top-level setvalue / bind setup vary:
 *
 *   user_controlled: bare `<repeat nodeset="${nodePath}">` — runtime adds /
 *     removes instances via UI; no jr:count, no setvalues.
 *
 *   count_bound: `<repeat nodeset="${nodePath}" jr:count="..."
 *     jr:noAddRemove="true()">`. JavaRosa evaluates jr:count once at form load
 *     and freezes the cardinality. A path count points jr:count straight at the
 *     path; a literal / expression count is hoisted into a hidden form-root node
 *     (see the count-hoist block).
 *
 *   query_bound: `<repeat nodeset="${nodePath}/item"
 *     jr:count="${nodePath}/@count" jr:noAddRemove="true()">` plus four
 *     top-level `<setvalue>` elements (Vellum's "model iteration" pattern):
 *       1. on xforms-ready, set ${nodePath}/@ids = join(' ', <ids_query>)
 *       2. on xforms-ready, set ${nodePath}/@count = count-selected(@ids)
 *       3. on jr-insert, set ${nodePath}/item/@index = int(@current_index)
 *       4. on jr-insert, set ${nodePath}/item/@id = selected-at(@ids, ../@index)
 *     The data section wraps children in `<item>` (handled by the caller's
 *     data-element rewrite).
 */
function buildRepeatBody(
	field: Field & { kind: "repeat" },
	nodePath: string,
	labelEl: Element | undefined,
	childBody: Element[],
	insideRepeat: boolean,
	setvalues: Element[],
	binds: Element[],
	topDataElements: Element[],
	topBinds: Element[],
	instances: InstanceTracker,
): Element {
	let repeatNodeset = nodePath;
	const repeatAttribs: Record<string, string> = {};

	if (field.repeat_mode === "count_bound") {
		const expandedCount = expandHashtags(field.repeat_count);
		// Hashtags inside repeat_count may reference casedb/session.
		instances.scanXPath(field.repeat_count);

		// JavaRosa parses the `jr:count` attribute through
		// `new XPathReference(countRef)`, which throws
		// `XPathTypeMismatchException("Expected XPath path, got XPath
		// expression: [...]")` for anything that isn't a location path
		// (commcare-core org/javarosa/model/xform/XPathReference.java::
		// getPathExpr, reached from XFormParser.java's `jr:count` handling). So
		// `jr:count` must point at a node — never a literal, arithmetic, or
		// function call.
		//
		// When the author's count already IS a path (`#form/desired_count` →
		// `/data/desired_count`), point `jr:count` straight at it (the
		// test_trigger_caching.xml shape). Otherwise hoist the value into a
		// hidden form-root node seeded by `<setvalue event="xforms-ready">` and
		// point `jr:count` at it — the group_relevancy_in_repeat.xml shape.
		if (isCountReferencePath(expandedCount)) {
			// Path → emit directly. `vellum:count` mirrors the prior behavior:
			// stamped only when the author wrote a hashtag shorthand worth
			// round-tripping back into the editor. Insertion order matches the
			// prior emitter: vellum:count (when present), then jr:count, then
			// jr:noAddRemove.
			if (hasHashtags(field.repeat_count)) {
				repeatAttribs["vellum:count"] = field.repeat_count;
			}
			repeatAttribs["jr:count"] = expandedCount;
			repeatAttribs["jr:noAddRemove"] = "true()";
		} else {
			// Non-path → hoist. The hidden node lives at `/data` (form root, via
			// the `top*` arrays) so its `xforms-ready` setvalue has a target at
			// form load, even when this repeat is nested inside a group or
			// another repeat.
			//
			// The node lives in the flat `/data` namespace, so its name must be
			// unique across the WHOLE form — but `field.id` is unique only among
			// SIBLINGS (cousins may share an id; the validator's
			// `duplicateFieldIds` scopes uniqueness to one level). Two cousin
			// count_bound repeats both named `items` would otherwise hoist to
			// the same `/data/__nova_count_items` and collide: duplicate data
			// node + bind + setvalue, and two repeats whose `jr:count` point at
			// the same node, so one silently steals the other's cardinality.
			// Keep the readable bare name when it is free and auto-suffix `_N` on
			// collision — the same disambiguation shape Nova uses for sibling-id
			// clashes. The loop probes live membership of `topDataElements` (by
			// element name), so it disambiguates against ANY node already there
			// and can never emit a duplicate. In practice the only `__nova_count_*`
			// nodes present are our own prior hoists — the reserved `__nova_`
			// prefix keeps the namespace off-limits to authored ids (validator
			// `reservedFieldIdPrefix`) — but correctness does not lean on that:
			// the probe stands on its own.
			const countNodeBase = `${RESERVED_XFORM_NODE_PREFIX}count_${field.id}`;
			let countNodeName = countNodeBase;
			for (
				let n = 1;
				topDataElements.some((e) => e.name === countNodeName);
				n++
			) {
				countNodeName = `${countNodeBase}_${n}`;
			}
			const countNodePath = `/data/${countNodeName}`;
			topDataElements.push(el(countNodeName, {}));
			// `xsd:int` matches the count's domain (a cardinality) and the
			// canonical fixture's `<bind ... type="xsd:int"/>`.
			topBinds.push(el("bind", { nodeset: countNodePath, type: "xsd:int" }));
			// Frozen-at-form-load is count_bound's documented contract (JavaRosa
			// evaluates `jr:count` once and never recalculates), so the seed
			// always fires on `xforms-ready` — there is no per-iteration re-seed
			// semantic to coerce for, even when nested.
			setvalues.push(
				el("setvalue", {
					event: "xforms-ready",
					ref: countNodePath,
					value: expandedCount,
				}),
			);
			// The author's original count (literal or expression) is the only
			// place the un-hoisted intent survives, so preserve it
			// unconditionally as `vellum:count` round-trip metadata. Vellum reads
			// `vellum:*` attrs opportunistically and tolerates a non-path value
			// here. Insertion order matches the prior emitter: vellum:count,
			// jr:count, jr:noAddRemove.
			repeatAttribs["vellum:count"] = field.repeat_count;
			repeatAttribs["jr:count"] = countNodePath;
			repeatAttribs["jr:noAddRemove"] = "true()";
		}
	} else if (field.repeat_mode === "query_bound") {
		repeatNodeset = `${nodePath}/item`;
		repeatAttribs["jr:count"] = `${nodePath}/@count`;
		repeatAttribs["jr:noAddRemove"] = "true()";
		const expandedIdsQuery = expandHashtags(field.data_source.ids_query);
		const idsValue = `join(' ', ${expandedIdsQuery})`;
		const countValue = `count-selected(${nodePath}/@ids)`;
		const indexValue = `int(${nodePath}/@current_index)`;
		const idValue = `selected-at(${nodePath}/@ids, ../@index)`;
		// `@current_index` calculate bind: JavaRosa updates the outer container's
		// `@current_index` to match the live item count at every jr-insert. The
		// per-instance `@index` setvalue reads this to know which slot it is.
		// Without this bind, `@current_index` stays empty and every iteration's
		// `@index` resolves to 0 — collapsing the @id setvalue's
		// `selected-at(@ids, @index)` to always pick id 0.
		binds.push(
			el("bind", {
				nodeset: `${nodePath}/@current_index`,
				calculate: `count(${nodePath}/item)`,
			}),
		);
		// Event coercion for nested model-iteration repeats. Mirrors Vellum's
		// modeliteration.js::getSetValues — when a query-bound repeat lives
		// INSIDE another repeat, the `@ids` and `@count` setvalues fire on
		// `jr-insert` instead of `xforms-ready` so each outer iteration re-seeds
		// its inner ids list. With `xforms-ready`, the inner repeat's @ids
		// reflects only the FIRST outer iteration's row context. The `@index`
		// and `@id` setvalues are always on `jr-insert` regardless.
		const seedEvent = insideRepeat ? "jr-insert" : "xforms-ready";
		setvalues.push(
			el("setvalue", {
				event: seedEvent,
				ref: `${nodePath}/@ids`,
				value: idsValue,
			}),
			el("setvalue", {
				event: seedEvent,
				ref: `${nodePath}/@count`,
				value: countValue,
			}),
			el("setvalue", {
				event: "jr-insert",
				ref: `${nodePath}/item/@index`,
				value: indexValue,
			}),
			el("setvalue", {
				event: "jr-insert",
				ref: `${nodePath}/item/@id`,
				value: idValue,
			}),
		);
		// ids_query may reference casedb / commcaresession.
		instances.scanXPath(field.data_source.ids_query);
	}

	// The `<repeat>` itself, then the surrounding `<group>` wrapper that holds
	// the optional label + the repeat. Children sit directly inside the
	// `<repeat>`. Attribute insertion order is `nodeset` first, then the
	// mode-specific attributes — matching the prior emitter's byte order.
	const repeatEl = el(
		"repeat",
		{ nodeset: repeatNodeset, ...repeatAttribs },
		childBody,
	);
	const groupChildren: Element[] = labelEl ? [labelEl, repeatEl] : [repeatEl];
	return el("group", { ref: nodePath }, groupChildren);
}

/**
 * XForm bind `type` attribute per domain `FieldKind`.
 *
 * Structural kinds (`group`, `repeat`, `label`) have no `type` on the
 * bind — CommCare treats them as grouping nodes. Every other kind
 * carries a concrete `xsd:*` type so the mobile client applies the
 * correct input parsing + validation on device.
 *
 * This deliberately diverges from `fieldRegistry[kind].dataType`: the
 * registry's `dataType` is the detail-column format descriptor
 * (`"binary"` for media, `"geopoint"` for geopoint, etc.), which is
 * consumed by the case-list + case-detail emitters. Bind types for the
 * XForm body answer a different question ("how does the XForm runtime
 * parse the value?"), and media/geopoint / binary answers all flatten
 * to `xsd:string` at that layer.
 *
 * Declaring this as a `Record<FieldKind, ...>` keyed off the domain
 * tuple makes TypeScript a gate on adding a new kind: a missing entry
 * here fails `tsc`, so the compile pipeline cannot silently emit an
 * XForm without a decided bind type for a new kind.
 */
const XSD_TYPE_BY_KIND: Record<FieldKind, string | null> = {
	text: "xsd:string",
	int: "xsd:int",
	decimal: "xsd:decimal",
	date: "xsd:date",
	time: "xsd:time",
	datetime: "xsd:dateTime",
	geopoint: "xsd:string",
	barcode: "xsd:string",
	image: "xsd:string",
	audio: "xsd:string",
	video: "xsd:string",
	signature: "xsd:string",
	hidden: "xsd:string",
	secret: "xsd:string",
	single_select: "xsd:string",
	multi_select: "xsd:string",
	label: null,
	group: null,
	repeat: null,
};

function getXsdType(kind: FieldKind): string | null {
	return XSD_TYPE_BY_KIND[kind];
}
