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
 * The emitter operates entirely on strings + primitives read off the doc;
 * it never constructs an intermediate tree. Walkers consume
 * `doc.fieldOrder[parentUuid]` and `doc.fields[fieldUuid]`, using
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
import type { Element } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import {
	escapeXml,
	expandHashtags,
	extractHashtags,
	hasHashtags,
	supportsValidation,
	VELLUM_HASHTAG_TRANSFORMS,
} from "@/lib/commcare";
import { readFieldString } from "@/lib/commcare/fieldProps";
import type { BlueprintDoc, ConnectConfig, Field, Uuid } from "@/lib/domain";

const PARSE_OPTS = { xmlMode: true } as const;
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
 * Wrap bare hashtag references (e.g. `#case/name`) in `<output value="..."/>`
 * tags, leaving existing `<output>` tags untouched. Split-and-rejoin on
 * the output-tag regex ensures we never double-wrap a hashtag that's
 * already inside an `<output>` attribute.
 */
function wrapBareHashtags(text: string): string {
	const parts = text.split(/(<output\b[^>]*\/>)/g);
	let changed = false;
	for (let i = 0; i < parts.length; i += 2) {
		const replaced = parts[i].replace(BARE_HASHTAG_RE, '<output value="$&"/>');
		if (replaced !== parts[i]) {
			parts[i] = replaced;
			changed = true;
		}
	}
	return changed ? parts.join("") : text;
}

/**
 * Process label / hint text: wrap any bare hashtag references, then
 * expand the hashtags inside every `<output value="...">` attribute
 * while preserving the original shorthand in a parallel `vellum:value`
 * attribute. Returns an XML-escaped, serialized string ready to drop
 * into an itext `<value>` element.
 */
function processLabelText(text: string): string {
	const preprocessed = wrapBareHashtags(text);
	const doc = parseDocument(preprocessed, PARSE_OPTS);

	const outputs = findAll(
		(node): node is Element => node.type === "tag" && node.name === "output",
		doc.children,
	);
	for (const el of outputs) {
		if (el.attribs.value) {
			const original = el.attribs.value;
			const expanded = expandHashtags(original);
			if (original !== expanded) {
				el.attribs["vellum:value"] = original;
			}
			el.attribs.value = expanded;
		}
	}

	return render(doc, RENDER_OPTS);
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
	connect: ConnectConfig | undefined,
	instances: InstanceTracker,
): { dataElements: string[]; binds: string[] } {
	const dataElements: string[] = [];
	const binds: string[] = [];

	if (!connect) return { dataElements, binds };

	if (connect.learn_module) {
		const lm = connect.learn_module;
		const lmId = lm.id || "connect_learn";
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
		const assessId = connect.assessment.id || "connect_assessment";
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
		const duId = du.id || "connect_deliver";
		instances.scanXPath(du.entity_id);
		instances.scanXPath(du.entity_name);
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
			`<bind nodeset="/data/${duId}/deliver/entity_id" calculate="${escapeXml(expandHashtags(du.entity_id))}"/>`,
			`<bind nodeset="/data/${duId}/deliver/entity_name" calculate="${escapeXml(expandHashtags(du.entity_name))}"/>`,
		);
	}

	if (connect.task) {
		const t = connect.task;
		const taskId = t.id || "connect_task";
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
 * expander); `connect` is the effective Connect config to embed —
 * omitted when the app-level `connectType` is unset.
 */
export interface BuildXFormOptions {
	xmlns: string;
	connect?: ConnectConfig;
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
			dataElements,
			binds,
			setvalues,
			bodyElements,
			false,
			addItext,
			instances,
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
 */
function buildFieldParts(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	parentPath: string,
	dataElements: string[],
	binds: string[],
	setvalues: string[],
	bodyElements: string[],
	insideRepeat: boolean,
	addItext: (id: string, text: string | undefined) => void,
	instances: InstanceTracker,
): void {
	const field = doc.fields[fieldUuid];
	const nodePath = `${parentPath}/${field.id}`;

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

	// One `<instance>` data node per field. Replaced for containers once
	// children have been emitted below.
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
		bindParts.push(`jr:constraintMsg="jr:itext('${field.id}-constraintMsg')"`);
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
	binds.push(`<bind ${bindParts.join(" ")}/>`);

	// itext. Hidden kinds have no body element, so no label to reference.
	if (field.kind !== "hidden" && label) {
		addItext(`${field.id}-label`, label);
		addItext(`${field.id}-hint`, hint);
	}

	// Validate message itext — paired with the `jr:constraintMsg`
	// attribute above; never emit the entry without the reference, or
	// vice versa.
	if (canValidate) {
		addItext(`${field.id}-constraintMsg`, validateMsg);
	}

	// Options (select kinds).
	const options = readOptions(field);
	if (options && options.length > 0) {
		for (const opt of options) {
			addItext(`${field.id}-${opt.value}-label`, opt.label);
		}
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

		for (const childUuid of doc.fieldOrder[fieldUuid] ?? []) {
			buildFieldParts(
				doc,
				childUuid,
				nodePath,
				childData,
				childBinds,
				setvalues,
				childBody,
				childInsideRepeat,
				addItext,
				instances,
			);
		}

		// Rewrite the self-closing data element with a proper parent
		// wrapping its children.
		dataElements.pop();
		const templateAttr = field.kind === "repeat" ? ' jr:template=""' : "";
		dataElements.push(
			`<${field.id}${templateAttr}>${childData.join("")}</${field.id}>`,
		);

		// Rewrite the leaf bind as a relevant-only container bind when
		// `relevant` is set; otherwise drop it (containers don't carry
		// validation / calculate / required on their own node).
		binds.pop();
		if (relevant) {
			const expandedGroupRelevant = expandHashtags(relevant);
			const vellumRelevantAttr = hasHashtags(relevant)
				? ` vellum:relevant="${escapeXml(relevant)}"`
				: "";
			binds.push(
				`<bind vellum:nodeset="${vellumPath}" nodeset="${nodePath}"${vellumRelevantAttr} relevant="${escapeXml(expandedGroupRelevant)}"/>`,
			);
		}
		binds.push(...childBinds);

		// Re-indent child body elements so the nested structure renders
		// cleanly. Repeats wrap their children in an extra `<group>`; the
		// indentation offsets account for both layouts.
		if (field.kind === "repeat") {
			const indentedChildren = childBody.map((el) => {
				const lines = el.split("\n");
				lines[0] = `        ${lines[0]}`;
				for (let i = 1; i < lines.length; i++) lines[i] = `    ${lines[i]}`;
				return lines.join("\n");
			});
			const innerLines = indentedChildren.join("\n");
			bodyElements.push(
				`<group ref="${nodePath}">\n      <label ref="jr:itext('${field.id}-label')"/>\n      <repeat nodeset="${nodePath}">\n${innerLines}\n      </repeat>\n    </group>`,
			);
		} else {
			const indentedChildren = childBody.map((el) => {
				const lines = el.split("\n");
				lines[0] = `      ${lines[0]}`;
				for (let i = 1; i < lines.length; i++) lines[i] = `  ${lines[i]}`;
				return lines.join("\n");
			});
			const innerLines = indentedChildren.join("\n");
			bodyElements.push(
				`<group ref="${nodePath}" appearance="field-list">\n      <label ref="jr:itext('${field.id}-label')"/>\n${innerLines}\n    </group>`,
			);
		}
		return;
	}

	if (field.kind === "single_select" || field.kind === "multi_select") {
		const tag = field.kind === "single_select" ? "select1" : "select";
		const items = (options ?? [])
			.map(
				(opt) =>
					`  <item><label ref="jr:itext('${field.id}-${opt.value}-label')"/><value>${escapeXml(opt.value)}</value></item>`,
			)
			.join("\n    ");
		let el = `<${tag} ref="${nodePath}">\n      <label ref="jr:itext('${field.id}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${field.id}-hint')"/>`;
		el += `\n    ${items}\n    </${tag}>`;
		bodyElements.push(el);
		return;
	}

	if (field.kind === "label") {
		let el = `<trigger ref="${nodePath}" appearance="minimal">\n      <label ref="jr:itext('${field.id}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${field.id}-hint')"/>`;
		el += `\n    </trigger>`;
		bodyElements.push(el);
		return;
	}

	if (field.kind === "secret") {
		let el = `<secret ref="${nodePath}">\n      <label ref="jr:itext('${field.id}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${field.id}-hint')"/>`;
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
		let el = `<upload ref="${nodePath}" mediatype="${mediatype}"${appearance}>\n      <label ref="jr:itext('${field.id}-label')"/>`;
		if (hint) el += `\n      <hint ref="jr:itext('${field.id}-hint')"/>`;
		el += `\n    </upload>`;
		bodyElements.push(el);
		return;
	}

	// Remaining input kinds: text, int, decimal, date, time, datetime,
	// geopoint, barcode. They all render as `<input>` with the XSD type
	// on the bind.
	let el = `<input ref="${nodePath}">\n      <label ref="jr:itext('${field.id}-label')"/>`;
	if (hint) el += `\n      <hint ref="jr:itext('${field.id}-hint')"/>`;
	el += `\n    </input>`;
	bodyElements.push(el);
}

/**
 * Map a domain `FieldKind` to its XSD bind type. Structural kinds
 * (group/repeat/label) have no type; everything else carries a concrete
 * xsd:* type on the bind so CommCare applies the right input parsing
 * and validation on device.
 */
function getXsdType(kind: Field["kind"]): string | null {
	switch (kind) {
		case "text":
			return "xsd:string";
		case "int":
			return "xsd:int";
		case "decimal":
			return "xsd:decimal";
		case "date":
			return "xsd:date";
		case "time":
			return "xsd:time";
		case "datetime":
			return "xsd:dateTime";
		case "geopoint":
			return "xsd:string";
		case "barcode":
			return "xsd:string";
		case "image":
			return "xsd:string";
		case "audio":
			return "xsd:string";
		case "video":
			return "xsd:string";
		case "signature":
			return "xsd:string";
		case "hidden":
			return "xsd:string";
		case "secret":
			return "xsd:string";
		case "single_select":
			return "xsd:string";
		case "multi_select":
			return "xsd:string";
		case "label":
			return null;
		case "group":
			return null;
		case "repeat":
			return null;
	}
}
