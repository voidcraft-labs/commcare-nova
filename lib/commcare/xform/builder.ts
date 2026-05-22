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
 * The emitter assembles the XForm by string concatenation off the doc's
 * primitives; the body / bind / data walk never builds an intermediate
 * tree. The one localized exception is itext value construction
 * (`processLabelText`), which builds a small domhandler node list per label
 * so the serializer — not hand-rolled escaping — owns entity escaping.
 * Walkers consume `doc.fieldOrder[parentUuid]` and `doc.fields[fieldUuid]`,
 * using
 * `doc.fieldOrder[fieldUuid]` being defined as the "this field is a
 * container" marker. The caller supplies the random xmlns and optional
 * Connect config / case-type metadata via `BuildXFormOptions`.
 *
 * Every CommCare wire invariant this file encodes — the dual `vellum:*`
 * attribute pattern, markdown-form itext duplication, hashtag-prose
 * wrapping, `jr:itext(...)` constraint messages, `jr-insert` defaults
 * inside repeats, secondary-instance accumulation — is part of what
 * HQ and the Vellum editor expect on import. Do not "simplify" the
 * emitted bytes.
 */

import render from "dom-serializer";
import { type AnyNode, Element, Text } from "domhandler";
import { decodeXML } from "entities";
import {
	escapeXml,
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
import type { BlueprintDoc, Field, FieldKind, Uuid } from "@/lib/domain";

const RENDER_OPTS = {
	xmlMode: true,
	selfClosingTags: true,
	encodeEntities: "utf8" as const,
} as const;

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
 * Build the ordered itext-value node list for one label / hint string and
 * serialize it once, letting `dom-serializer` own ALL escaping.
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
 *   - Prose runs (everything between hashtag matches) become a domhandler
 *     `Text` node whose data is `decodeXML(run)`. Decoding normalizes any
 *     pre-escaped entity the author may have typed (the historical `&lt;`
 *     workaround → `<`) so the serializer re-escapes it exactly once —
 *     `&lt;`, never the double-escaped `&amp;lt;` that would show a literal
 *     `&lt;` on device. `dom-serializer` escapes `<` / `>` / `&` in text
 *     data automatically.
 *   - Each hashtag match becomes a constructed self-closing `<output>`
 *     `Element`: `value` holds the expanded instance XPath, and the parallel
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
 * The `BARE_HASHTAG_RE` regex (not the Lezer XPath parser) locates hashtag
 * spans because labels are prose: markdown syntax like `**` around a `#`
 * ref parses as XPath operators under the grammar (see
 * lib/commcare/xpath/CLAUDE.md).
 */
function processLabelText(text: string): string {
	const nodes: AnyNode[] = [];
	// `BARE_HASHTAG_RE` is a module-level /g regex; reset `lastIndex` so a
	// prior call's state never leaks into this walk.
	BARE_HASHTAG_RE.lastIndex = 0;
	let cursor = 0;
	let match: RegExpExecArray | null = BARE_HASHTAG_RE.exec(text);
	while (match !== null) {
		// Prose before this hashtag → a Text node (decoded so the
		// serializer escapes exactly once).
		if (match.index > cursor) {
			nodes.push(new Text(decodeXML(text.slice(cursor, match.index))));
		}
		// The hashtag → a constructed <output> element. `value` is the
		// expanded XPath; `vellum:value` shadows the original shorthand
		// only when expansion actually changed it (Vellum round-trip).
		const original = match[0];
		const expanded = expandHashtags(original);
		const attribs: Record<string, string> = { value: expanded };
		if (original !== expanded) attribs["vellum:value"] = original;
		nodes.push(new Element("output", attribs));
		cursor = match.index + original.length;
		match = BARE_HASHTAG_RE.exec(text);
	}
	// Trailing prose after the last hashtag (or the whole string when there
	// were no hashtags at all).
	if (cursor < text.length) {
		nodes.push(new Text(decodeXML(text.slice(cursor))));
	}
	// `dom-serializer` escapes text-node data and attribute values; no byte
	// is ever hand-escaped on this path.
	return render(nodes, RENDER_OPTS);
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
	scanLabel(text: string): void {
		if (/#(case|user)\//.test(text)) this.require("casedb");
	}

	toXml(): string[] {
		return (["casedb", "commcaresession"] as const)
			.filter((id) => this.ids.has(id))
			.map(
				(id) => `      <instance src="${INSTANCE_SOURCES[id]}" id="${id}" />`,
			);
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
): { dataElements: string[]; binds: string[] } {
	const dataElements: string[] = [];
	const binds: string[] = [];

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
			`<${lmId} vellum:role="ConnectLearnModule">` +
				`<module xmlns="${CONNECT_XMLNS}" id="${lmId}">` +
				`<name>${escapeXml(lm.name)}</name>` +
				`<description>${escapeXml(lm.description)}</description>` +
				`<time_estimate>${lm.time_estimate}</time_estimate>` +
				`</module>` +
				`</${lmId}>`,
		);
		binds.push(
			`<bind vellum:nodeset="#form/${lmId}" nodeset="/data/${lmId}"/>`,
		);
	}

	if (connect.assessment) {
		const assessId = connect.assessment.id;
		instances.scanXPath(connect.assessment.user_score);
		dataElements.push(
			`<${assessId} vellum:role="ConnectAssessment">` +
				`<assessment xmlns="${CONNECT_XMLNS}" id="${assessId}">` +
				`<user_score/>` +
				`</assessment>` +
				`</${assessId}>`,
		);
		binds.push(
			`<bind vellum:nodeset="#form/${assessId}" nodeset="/data/${assessId}"/>`,
			`<bind nodeset="/data/${assessId}/assessment/user_score" calculate="${escapeXml(expandHashtags(connect.assessment.user_score))}"/>`,
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
			`<${duId} vellum:role="ConnectDeliverUnit">` +
				`<deliver xmlns="${CONNECT_XMLNS}" id="${duId}">` +
				`<name>${escapeXml(du.name)}</name>` +
				`<entity_id/>` +
				`<entity_name/>` +
				`</deliver>` +
				`</${duId}>`,
		);
		binds.push(
			`<bind vellum:nodeset="#form/${duId}" nodeset="/data/${duId}"/>`,
			`<bind nodeset="/data/${duId}/deliver/entity_id" calculate="${escapeXml(expandHashtags(entityId))}"/>`,
			`<bind nodeset="/data/${duId}/deliver/entity_name" calculate="${escapeXml(expandHashtags(entityName))}"/>`,
		);
	}

	if (connect.task) {
		const t = connect.task;
		const taskId = t.id;
		dataElements.push(
			`<${taskId} vellum:role="ConnectTask">` +
				`<task xmlns="${CONNECT_XMLNS}" id="${taskId}">` +
				`<name>${escapeXml(t.name)}</name>` +
				`<description>${escapeXml(t.description)}</description>` +
				`</task>` +
				`</${taskId}>`,
		);
		binds.push(
			`<bind vellum:nodeset="#form/${taskId}" nodeset="/data/${taskId}"/>`,
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
 * body / itext / instances, and assembles them into the XForm template.
 */
export function buildXForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
	opts: BuildXFormOptions,
): string {
	const form = doc.forms[formUuid];
	const instances = new InstanceTracker();
	const dataElements: string[] = [];
	const binds: string[] = [];
	const setvalues: string[] = [];
	const bodyElements: string[] = [];
	const itextEntries: string[] = [];

	// Register an itext `<text>` entry. Every entry emits both the plain
	// value AND a `<value form="markdown">` duplicate — CommCare only
	// renders markdown when the markdown form is present, and it's a
	// no-op for plain text. Without the duplicate, `**bold**` renders as
	// literal asterisks on device.
	const addItext = (id: string, text: string | undefined): void => {
		if (!text) return;
		const processed = processLabelText(text);
		itextEntries.push(
			`<text id="${id}"><value>${processed}</value><value form="markdown">${processed}</value></text>`,
		);
	};

	for (const fieldUuid of doc.fieldOrder[formUuid] ?? []) {
		buildFieldParts(
			doc,
			fieldUuid,
			"/data",
			// Top-level fields get an empty itext-key prefix, so their key is
			// just `field.id` — the common flat-form case is byte-identical to
			// before this scheme existed.
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

	const dataContent =
		dataElements.length > 0
			? `\n${dataElements.map((e) => `          ${e}`).join("\n")}\n        `
			: "";

	const bindContent =
		binds.length > 0 ? `\n${binds.map((b) => `      ${b}`).join("\n")}` : "";

	const setvalueContent =
		setvalues.length > 0
			? `\n${setvalues.map((s) => `      ${s}`).join("\n")}`
			: "";

	const formName = form.name;
	const content = itextEntries.map((e) => `          ${e}`).join("\n");
	const translations = `        <translation lang="en" default="">\n${content}\n        </translation>`;
	const bodyContent = bodyElements.map((e) => `    ${e}`).join("\n");

	const secondaryInstances = instances.toXml();
	const secondaryContent =
		secondaryInstances.length > 0 ? `\n${secondaryInstances.join("\n")}` : "";

	return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">
  <h:head>
    <h:title>${escapeXml(formName)}</h:title>
    <model>
      <instance>
        <data xmlns="${opts.xmlns}" xmlns:jrm="http://dev.commcarehq.org/jr/xforms" uiVersion="1" version="1" name="${escapeXml(formName.toLowerCase().replace(/[^a-z0-9]+/g, "_"))}">${dataContent}</data>
      </instance>${secondaryContent}${bindContent}${setvalueContent}
      <itext>
${translations}
      </itext>
    </model>
  </h:head>
  <h:body>
${bodyContent}
  </h:body>
</h:html>`;
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
 * Group / repeat containers recurse through `doc.fieldOrder[fieldUuid]`
 * to emit nested parts, rewriting their parent data element + bind to
 * the container shape once their children are built.
 *
 * `topDataElements` / `topBinds` always reference the FORM-ROOT data and
 * bind arrays, threaded through every recursion unchanged. They are the
 * landing site for synthetic nodes that must live at `/data` regardless of
 * how deeply the emitting field is nested — currently the hidden count node
 * a hoisted `count_bound` repeat needs (its `xforms-ready` setvalue fires at
 * form load, before any container template exists). The `setvalues` array is
 * already form-root-scoped for the same reason, so it needs no parallel.
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
	dataElements: string[],
	binds: string[],
	setvalues: string[],
	bodyElements: string[],
	insideRepeat: boolean,
	addItext: (id: string, text: string | undefined) => void,
	instances: InstanceTracker,
	topDataElements: string[],
	topBinds: string[],
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
	for (const text of [label, hint]) {
		if (text) instances.scanLabel(text);
	}

	// One `<instance>` data node per field. Replaced IN PLACE for containers
	// once children have been emitted below. We record the slot index now
	// rather than `pop()`-ing after recursion, because a descendant repeat
	// can append a hoisted synthetic count node to this same array (the
	// `topDataElements` thread aliases `dataElements` at form root) — a blind
	// `pop()` would remove that synthetic node instead of this placeholder.
	const dataSlot = dataElements.length;
	dataElements.push(`<${field.id}/>`);

	// Bind: real attributes get expanded XPath; `vellum:*` attrs preserve
	// the original shorthand for the Vellum editor on round-trip.
	const vellumPath = `#form${nodePath.slice(5)}`; // "/data/x" → "#form/x"
	const bindParts = [`vellum:nodeset="${vellumPath}"`, `nodeset="${nodePath}"`];
	const xsdType = getXsdType(field.kind);
	if (xsdType) bindParts.push(`type="${xsdType}"`);
	if (required) {
		if (hasHashtags(required))
			bindParts.push(`vellum:required="${escapeXml(required)}"`);
		bindParts.push(`required="${escapeXml(expandHashtags(required))}"`);
	}

	// Validation (constraint + constraintMsg) is meaningful only on
	// input kinds. Structural (group/repeat/label) and computed (hidden)
	// fields have no user-editable value to check — silently skip the
	// attributes so an upstream misconfiguration can't leak a garbage
	// bind. The validator flags `validate` on non-input kinds as its
	// own error.
	const canValidate = supportsValidation(field.kind);
	if (canValidate && validate) {
		if (hasHashtags(validate))
			bindParts.push(`vellum:constraint="${escapeXml(validate)}"`);
		bindParts.push(`constraint="${escapeXml(expandHashtags(validate))}"`);
	}

	// `jr:constraintMsg` MUST be an itext reference — HQ's XForm parser
	// only reads the attribute when it points at an itext id via
	// `jr:itext(...)`, so inline text would vanish on upload. The matching
	// `<text>` entry is registered below when `canValidate` holds.
	if (canValidate && validateMsg) {
		bindParts.push(`jr:constraintMsg="jr:itext('${itextKey}-constraintMsg')"`);
	}

	if (relevant) {
		if (hasHashtags(relevant))
			bindParts.push(`vellum:relevant="${escapeXml(relevant)}"`);
		bindParts.push(`relevant="${escapeXml(expandHashtags(relevant))}"`);
	}
	if (calculate) {
		if (hasHashtags(calculate))
			bindParts.push(`vellum:calculate="${escapeXml(calculate)}"`);
		bindParts.push(`calculate="${escapeXml(expandHashtags(calculate))}"`);
	}

	// Setvalue for `default_value`. Inside a repeat group we fire on
	// `jr-insert` so each new iteration gets the default; outside, the
	// one-shot `xforms-ready` event is correct.
	if (defaultValue) {
		const expandedValue = expandHashtags(defaultValue);
		const vellumAttrs = hasHashtags(defaultValue)
			? ` vellum:value="${escapeXml(defaultValue)}"`
			: "";
		const event = insideRepeat ? "jr-insert" : "xforms-ready";
		setvalues.push(
			`<setvalue event="${event}" vellum:ref="${vellumPath}" ref="${nodePath}"${vellumAttrs} value="${escapeXml(expandedValue)}"/>`,
		);
	}

	// Vellum hashtag metadata: the editor needs the hashtag map + the
	// shared transforms table to round-trip `#case/` / `#user/` refs.
	// Scan only the expressions that actually made it onto the bind
	// (validation was dropped for non-input kinds above).
	const xpathExprs: string[] = [];
	if (relevant) xpathExprs.push(relevant);
	if (canValidate && validate) xpathExprs.push(validate);
	if (calculate) xpathExprs.push(calculate);
	if (defaultValue) xpathExprs.push(defaultValue);
	if (required) xpathExprs.push(required);

	const hashtags = extractHashtags(xpathExprs);
	if (hashtags.length > 0) {
		const hashtagMap = Object.fromEntries(hashtags.map((h) => [h, null]));
		bindParts.push(
			`vellum:hashtags="${escapeXml(JSON.stringify(hashtagMap))}"`,
		);
		bindParts.push(
			`vellum:hashtagTransforms="${escapeXml(JSON.stringify(VELLUM_HASHTAG_TRANSFORMS))}"`,
		);
	}
	// Record this leaf bind's slot so a container can rewrite it IN PLACE
	// after recursion — same reasoning as `dataSlot`: a descendant repeat
	// may append a hoisted count node's bind to this same array, so a blind
	// `pop()` would remove the wrong entry.
	const bindSlot = binds.length;
	binds.push(`<bind ${bindParts.join(" ")}/>`);

	// itext. Hidden kinds have no body element, so no label to reference.
	if (field.kind !== "hidden" && label) {
		addItext(`${itextKey}-label`, label);
		addItext(`${itextKey}-hint`, hint);
	}

	// Validate message itext — paired with the `jr:constraintMsg`
	// attribute above; never emit the entry without the reference, or
	// vice versa.
	if (canValidate) {
		addItext(`${itextKey}-constraintMsg`, validateMsg);
	}

	// Options (select kinds).
	//
	// itext ids are keyed by the option's stable array INDEX, not its
	// `value` — `${itextKey}-opt${index}-label`. Two options may legally
	// share a `value` (the domain's `selectOptionSchema` is `{ value, label }`
	// with no uniqueness constraint), but a value-keyed itext id would then
	// collapse both onto one id. CommCare's XForm parser hard-rejects a
	// duplicate itext id (`commcare-core/.../xform/parse/XFormParser.java::
	// verifyTextMappings`, reached from `parseItem`'s label-ref check),
	// while it accepts two `<item>`s sharing a `<value>` with no objection
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
		// Containers: recurse through children, then rewrite the parent
		// data element to wrap them and swap the leaf bind for a container
		// bind (relevant-only when one was set).
		const childData: string[] = [];
		const childBinds: string[] = [];
		const childBody: string[] = [];
		const childInsideRepeat = field.kind === "repeat" ? true : insideRepeat;

		// Query-bound repeats nest children under an extra `<item>` level
		// (Vellum's "model iteration" pattern). The outer `<id>` element
		// holds `@ids` / `@count` / `@current_index`; the inner `<item>`
		// is the per-iteration template. Rewriting `childParentPath`
		// here propagates `/item` into every descendant's bind nodeset,
		// body ref, and setvalue ref — not just the data section.
		// user_controlled and count_bound repeats keep the flat
		// `<id>...</id>` shape with no rewrite.
		const isQueryBoundRepeat =
			field.kind === "repeat" && field.repeat_mode === "query_bound";
		const childParentPath = isQueryBoundRepeat ? `${nodePath}/item` : nodePath;

		for (const childUuid of doc.fieldOrder[fieldUuid] ?? []) {
			buildFieldParts(
				doc,
				childUuid,
				childParentPath,
				// Children's itext keys hang off this field's key — the ancestry
				// prefix grows by one segment per nesting level, keeping cousins
				// in distinct subtrees from ever colliding.
				`${itextKey}-`,
				childData,
				childBinds,
				setvalues,
				childBody,
				childInsideRepeat,
				addItext,
				instances,
				// Pass the form-root arrays through unchanged — synthetic
				// nodes always land at /data, never in this container's
				// childData/childBinds scope.
				topDataElements,
				topBinds,
			);
		}

		// Rewrite the self-closing data element with a proper parent
		// wrapping its children. Three shapes:
		//   - group: `<id>...</id>`
		//   - user_controlled / count_bound repeat: `<id jr:template="">...</id>`
		//   - query_bound repeat: `<id ids="" count="" current_index=""
		//       vellum:role="Repeat"><item id="" index="" jr:template="">...
		//       </item></id>`
		// The query_bound shape mirrors Vellum's model-iteration
		// emission. The four attribute slots on the outer `<id>` are
		// load-bearing:
		//   - `ids` and `count` are seeded by setvalue at xforms-ready
		//     (or jr-insert when nested) from the configured ids_query.
		//   - `current_index` is set by a `<bind calculate>` to
		//     `count(${nodePath}/item)` — JavaRosa updates it as items
		//     materialize, and the per-iteration `@index` setvalue reads
		//     it at jr-insert time. Without this slot the model-iteration
		//     pattern collapses (every iteration reads position 0).
		//   - `vellum:role="Repeat"` is the round-trip metadata Vellum
		//     uses to recognize a model-iteration container on import.
		// Replace the placeholder at its recorded slot (NOT `pop()` — a
		// descendant repeat may have appended a hoisted count node after it).
		const containerData = isQueryBoundRepeat
			? `<${field.id} ids="" count="" current_index="" vellum:role="Repeat"><item id="" index="" jr:template="">${childData.join("")}</item></${field.id}>`
			: `<${field.id}${field.kind === "repeat" ? ' jr:template=""' : ""}>${childData.join("")}</${field.id}>`;
		dataElements[dataSlot] = containerData;

		// Rewrite the leaf bind at its recorded slot. Containers don't carry
		// validation / calculate / required on their own node, so the leaf
		// bind becomes either a relevant-only container bind (when `relevant`
		// is set) or is dropped entirely. Child binds always append at the
		// end (order is irrelevant to JavaRosa).
		if (relevant) {
			const expandedGroupRelevant = expandHashtags(relevant);
			const vellumRelevantAttr = hasHashtags(relevant)
				? ` vellum:relevant="${escapeXml(relevant)}"`
				: "";
			binds[bindSlot] =
				`<bind vellum:nodeset="${vellumPath}" nodeset="${nodePath}"${vellumRelevantAttr} relevant="${escapeXml(expandedGroupRelevant)}"/>`;
		} else {
			// Drop the leaf bind in place. `splice` (not `pop`) so any
			// synthetic bind a descendant appended after this slot is kept.
			binds.splice(bindSlot, 1);
		}
		binds.push(...childBinds);

		// Re-indent child body elements so the nested structure renders
		// cleanly. Repeats wrap their children in an extra `<group>`; the
		// indentation offsets account for both layouts.
		//
		// `<label>` is gated on a truthy `label`. Container kinds
		// (`group`, `repeat`) extend `containerFieldBase` (label
		// optional); when label is empty/absent, no itext entry is
		// registered for it, so emitting an unconditional
		// `<label ref="jr:itext('${id}-label')"/>` would produce a
		// dangling reference the XForm oracle flags as
		// `XFORM_MISSING_ITEXT`. Skipping the element entirely is also
		// what CommCare expects for transparent structural containers —
		// the runtime renders nothing for an unlabeled group/repeat
		// header.
		const labelLine = label
			? `\n      <label ref="jr:itext('${itextKey}-label')"/>`
			: "";
		if (field.kind === "repeat") {
			// Per-mode wire shape. The body's `<repeat>` and any top-level
			// setvalue setup vary; the surrounding `<group>` wrapper +
			// label + bind do not.
			//
			//   user_controlled: bare `<repeat nodeset="${nodePath}">`
			//     + no jr:count, no setvalues. Runtime adds/removes
			//     instances via UI.
			//
			//   count_bound: `<repeat nodeset="${nodePath}" jr:count="..."
			//     jr:noAddRemove="true()">`. JavaRosa evaluates jr:count
			//     once at form load and freezes the cardinality.
			//
			//   query_bound: `<repeat nodeset="${nodePath}/item"
			//     jr:count="${nodePath}/@count" jr:noAddRemove="true()">`
			//     plus four top-level <setvalue> elements (Vellum's
			//     "model iteration" pattern):
			//       1. on xforms-ready, set ${nodePath}/@ids =
			//          join(' ', <ids_query>)
			//       2. on xforms-ready, set ${nodePath}/@count =
			//          count-selected(${nodePath}/@ids)
			//       3. on jr-insert, set ${nodePath}/item/@index =
			//          int(${nodePath}/@current_index)
			//       4. on jr-insert, set ${nodePath}/item/@id =
			//          selected-at(${nodePath}/@ids, ../@index)
			//     The data section wraps children in `<item>` (handled
			//     by the data-element rewrite above).
			let repeatNodeset = nodePath;
			let repeatExtraAttrs = "";
			if (field.repeat_mode === "count_bound") {
				const expandedCount = expandHashtags(field.repeat_count);
				// Hashtags inside repeat_count may reference casedb/session.
				instances.scanXPath(field.repeat_count);

				// JavaRosa parses the `jr:count` attribute through
				// `new XPathReference(countRef)`, which throws
				// `XPathTypeMismatchException("Expected XPath path, got XPath
				// expression: [...]")` for anything that isn't a location
				// path (commcare-core
				// org/javarosa/model/xform/XPathReference.java::getPathExpr,
				// reached from XFormParser.java's `jr:count` handling). So
				// `jr:count` must point at a node — never a literal,
				// arithmetic, or function call.
				//
				// When the author's count already IS a path
				// (`#form/desired_count` → `/data/desired_count`), point
				// `jr:count` straight at it (the test_trigger_caching.xml
				// shape). Otherwise hoist the value into a hidden form-root
				// node seeded by `<setvalue event="xforms-ready">` and point
				// `jr:count` at it — the group_relevancy_in_repeat.xml shape.
				if (isCountReferencePath(expandedCount)) {
					// Path → emit directly. `vellum:count` mirrors the prior
					// behavior: stamped only when the author wrote a hashtag
					// shorthand worth round-tripping back into the editor.
					const vellumCountAttr = hasHashtags(field.repeat_count)
						? ` vellum:count="${escapeXml(field.repeat_count)}"`
						: "";
					repeatExtraAttrs = `${vellumCountAttr} jr:count="${escapeXml(expandedCount)}" jr:noAddRemove="true()"`;
				} else {
					// Non-path → hoist. The hidden node lives at `/data`
					// (form root, via the `top*` arrays) so its
					// `xforms-ready` setvalue has a target at form load, even
					// when this repeat is nested inside a group or another
					// repeat.
					//
					// The node lives in the flat `/data` namespace, so its
					// name must be unique across the WHOLE form — but `field.id`
					// is unique only among SIBLINGS (cousins may share an id;
					// the validator's `duplicateFieldIds` scopes uniqueness to
					// one level). Two cousin count_bound repeats both named
					// `items` would otherwise hoist to the same
					// `/data/__nova_count_items` and collide: duplicate data
					// node + bind + setvalue, and two repeats whose `jr:count`
					// point at the same node, so one silently steals the
					// other's cardinality. Keep the readable bare name when it
					// is free and auto-suffix `_N` on collision — the same
					// disambiguation shape Nova uses for sibling-id clashes. The
					// loop probes live membership of `topDataElements`, so it
					// disambiguates against ANY node already there and can never
					// emit a duplicate. In practice the only `__nova_count_*`
					// nodes present are our own prior hoists — the reserved
					// `__nova_` prefix keeps the namespace off-limits to authored
					// ids (validator `reservedFieldIdPrefix`) — but correctness
					// does not lean on that: the probe stands on its own.
					const countNodeBase = `${RESERVED_XFORM_NODE_PREFIX}count_${field.id}`;
					let countNodeName = countNodeBase;
					for (
						let n = 1;
						topDataElements.includes(`<${countNodeName}/>`);
						n++
					) {
						countNodeName = `${countNodeBase}_${n}`;
					}
					const countNodePath = `/data/${countNodeName}`;
					topDataElements.push(`<${countNodeName}/>`);
					// `xsd:int` matches the count's domain (a cardinality)
					// and the canonical fixture's `<bind ... type="xsd:int"/>`.
					topBinds.push(`<bind nodeset="${countNodePath}" type="xsd:int"/>`);
					// Frozen-at-form-load is count_bound's documented
					// contract (JavaRosa evaluates `jr:count` once and never
					// recalculates), so the seed always fires on
					// `xforms-ready` — there is no per-iteration re-seed
					// semantic to coerce for, even when nested.
					setvalues.push(
						`<setvalue event="xforms-ready" ref="${countNodePath}" value="${escapeXml(expandedCount)}"/>`,
					);
					// The author's original count (literal or expression) is
					// the only place the un-hoisted intent survives, so
					// preserve it unconditionally as `vellum:count`
					// round-trip metadata. Vellum reads `vellum:*` attrs
					// opportunistically and tolerates a non-path value here.
					repeatExtraAttrs = ` vellum:count="${escapeXml(field.repeat_count)}" jr:count="${countNodePath}" jr:noAddRemove="true()"`;
				}
			} else if (field.repeat_mode === "query_bound") {
				repeatNodeset = `${nodePath}/item`;
				repeatExtraAttrs = ` jr:count="${nodePath}/@count" jr:noAddRemove="true()"`;
				const expandedIdsQuery = expandHashtags(field.data_source.ids_query);
				const idsValue = `join(' ', ${expandedIdsQuery})`;
				const countValue = `count-selected(${nodePath}/@ids)`;
				const indexValue = `int(${nodePath}/@current_index)`;
				const idValue = `selected-at(${nodePath}/@ids, ../@index)`;
				// `@current_index` calculate bind: JavaRosa updates the
				// outer container's `@current_index` to match the live
				// item count at every jr-insert. The per-instance
				// `@index` setvalue reads this to know which slot it is.
				// Without this bind, `@current_index` stays empty and
				// every iteration's `@index` resolves to 0 — collapsing
				// the @id setvalue's `selected-at(@ids, @index)` to
				// always pick id 0.
				binds.push(
					`<bind nodeset="${nodePath}/@current_index" calculate="count(${nodePath}/item)"/>`,
				);
				// Event coercion for nested model-iteration repeats.
				// Mirrors Vellum's modeliteration.js::getSetValues —
				// when a query-bound repeat lives INSIDE another
				// repeat, the `@ids` and `@count` setvalues fire on
				// `jr-insert` instead of `xforms-ready` so each outer
				// iteration re-seeds its inner ids list. With
				// `xforms-ready`, the inner repeat's @ids reflects
				// only the FIRST outer iteration's row context. The
				// `@index` and `@id` setvalues are always on
				// `jr-insert` regardless.
				const seedEvent = insideRepeat ? "jr-insert" : "xforms-ready";
				setvalues.push(
					`<setvalue event="${seedEvent}" ref="${nodePath}/@ids" value="${escapeXml(idsValue)}"/>`,
				);
				setvalues.push(
					`<setvalue event="${seedEvent}" ref="${nodePath}/@count" value="${escapeXml(countValue)}"/>`,
				);
				setvalues.push(
					`<setvalue event="jr-insert" ref="${nodePath}/item/@index" value="${escapeXml(indexValue)}"/>`,
				);
				setvalues.push(
					`<setvalue event="jr-insert" ref="${nodePath}/item/@id" value="${escapeXml(idValue)}"/>`,
				);
				// ids_query may reference casedb / commcaresession.
				instances.scanXPath(field.data_source.ids_query);
			}

			const indentedChildren = childBody.map((el) => {
				const lines = el.split("\n");
				lines[0] = `        ${lines[0]}`;
				for (let i = 1; i < lines.length; i++) lines[i] = `    ${lines[i]}`;
				return lines.join("\n");
			});
			const innerLines = indentedChildren.join("\n");
			bodyElements.push(
				`<group ref="${nodePath}">${labelLine}\n      <repeat nodeset="${repeatNodeset}"${repeatExtraAttrs}>\n${innerLines}\n      </repeat>\n    </group>`,
			);
		} else {
			const indentedChildren = childBody.map((el) => {
				const lines = el.split("\n");
				lines[0] = `      ${lines[0]}`;
				for (let i = 1; i < lines.length; i++) lines[i] = `  ${lines[i]}`;
				return lines.join("\n");
			});
			const innerLines = indentedChildren.join("\n");
			// `appearance="field-list"` is a CommCare semantic that drives
			// single-page rendering of the group's children. For a labelled
			// group it's Nova's default; for an empty-label (transparent)
			// group, dropping the attribute matches the "no visual impact"
			// runtime semantic — there's no group chrome to anchor a
			// field-list layout against, so leaving it on would assert a
			// layout posture the author didn't ask for.
			const appearanceAttr = label ? ' appearance="field-list"' : "";
			bodyElements.push(
				`<group ref="${nodePath}"${appearanceAttr}>${labelLine}\n${innerLines}\n    </group>`,
			);
		}
		return;
	}

	if (field.kind === "single_select" || field.kind === "multi_select") {
		const tag = field.kind === "single_select" ? "select1" : "select";
		// Each `<item>`'s `<label ref>` references the same per-INDEX itext id
		// registered above (`-opt${index}-label`), so duplicate option values
		// never collide. The `<value>` still emits `opt.value` verbatim
		// (escaped) — JavaRosa permits duplicate `<value>`s across items.
		const items = (options ?? [])
			.map(
				(opt, index) =>
					`  <item><label ref="jr:itext('${itextKey}-opt${index}-label')"/><value>${escapeXml(opt.value)}</value></item>`,
			)
			.join("\n    ");
		let el = `<${tag} ref="${nodePath}">\n      <label ref="jr:itext('${itextKey}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${itextKey}-hint')"/>`;
		el += `\n    ${items}\n    </${tag}>`;
		bodyElements.push(el);
		return;
	}

	if (field.kind === "label") {
		let el = `<trigger ref="${nodePath}" appearance="minimal">\n      <label ref="jr:itext('${itextKey}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${itextKey}-hint')"/>`;
		el += `\n    </trigger>`;
		bodyElements.push(el);
		return;
	}

	if (field.kind === "secret") {
		let el = `<secret ref="${nodePath}">\n      <label ref="jr:itext('${itextKey}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${itextKey}-hint')"/>`;
		el += `\n    </secret>`;
		bodyElements.push(el);
		return;
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
		const appearance =
			field.kind === "signature" ? ' appearance="signature"' : "";
		let el = `<upload ref="${nodePath}" mediatype="${mediatype}"${appearance}>\n      <label ref="jr:itext('${itextKey}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${itextKey}-hint')"/>`;
		el += `\n    </upload>`;
		bodyElements.push(el);
		return;
	}

	// Remaining input kinds: text, int, decimal, date, time, datetime,
	// geopoint, barcode. They all render as `<input>` with the XSD type
	// on the bind.
	let el = `<input ref="${nodePath}">\n      <label ref="jr:itext('${itextKey}-label')"/>`;
	if (hint) el += `\n      <hint ref="jr:itext('${itextKey}-hint')"/>`;
	el += `\n    </input>`;
	bodyElements.push(el);
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
