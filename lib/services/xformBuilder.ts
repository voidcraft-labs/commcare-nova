/**
 * XForm XML builder for CommCare forms.
 *
 * Generates complete XForm XML from blueprint question definitions, including
 * itext translations, binds, setvalues, body elements, and secondary instances.
 * Extracted from hqJsonExpander.ts to isolate XForm construction logic.
 */

import render from "dom-serializer";
import type { Element } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import type {
	BlueprintForm,
	ConnectConfig,
	Question,
} from "../schemas/blueprint";
import { supportsValidation } from "../schemas/blueprint";
import {
	escapeXml,
	expandHashtags,
	extractHashtags,
	hasHashtags,
	VELLUM_HASHTAG_TRANSFORMS,
} from "./commcare";

const PARSE_OPTS = { xmlMode: true } as const;
const RENDER_OPTS = {
	xmlMode: true,
	selfClosingTags: true,
	encodeEntities: "utf8" as const,
} as const;

/**
 * Bare hashtag pattern for label/hint prose text.
 *
 * Labels are natural language, not XPath — the Lezer XPath parser can't find
 * hashtags in prose because surrounding characters (e.g. markdown `**`) get
 * parsed as XPath operators (multiply/wildcard), swallowing the `#`.
 * Regex is the correct tool here; Lezer handles XPath fields (calculate, etc.).
 */
const BARE_HASHTAG_RE = /#(case|form|user)(\/[a-zA-Z_][a-zA-Z0-9_-]*)+/g;

/**
 * Wrap bare hashtag references in prose text with <output value="..."/> tags.
 * Splits on existing <output/> tags to avoid double-wrapping hashtags
 * that are already inside output tag attributes.
 */
function wrapBareHashtags(text: string): string {
	// Split on existing <output .../> tags — captured groups land at odd indices
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
 * Process label/hint text that may contain <output value="..."/> tags.
 * Bare hashtag references (#case/x, #form/x, #user/x) are auto-wrapped in
 * <output> tags first. Then all <output> tags get Lezer-based hashtag expansion
 * on the value attribute. Plain text is XML-escaped by dom-serializer.
 */
function processLabelText(text: string): string {
	// Wrap bare hashtag refs (e.g. #case/name) in <output> tags before parsing
	const preprocessed = wrapBareHashtags(text);
	const doc = parseDocument(preprocessed, PARSE_OPTS);

	// Expand hashtags in output tag value attributes, preserve shorthand in vellum:value
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

	// Serialize back — dom-serializer handles XML escaping of text nodes
	return render(doc, RENDER_OPTS);
}

// ── Secondary instance tracking ──────────────────────────────────────
// Instead of collecting XPaths into arrays and scanning them post-hoc,
// each sub-builder registers the instances it needs via this tracker.
// casedb implies commcaresession (case XPath uses session for case_id).

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

	/** Scan a pre-expansion XPath for instance references. */
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

	/** Scan label/hint prose for #case/ or #user/ hashtag refs. */
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
 * Build Connect data blocks and binds for the XForm.
 *
 * Each Connect type uses a two-level wrapper recognized by Vellum:
 *   <wrapper vellum:role="ConnectDeliverUnit">
 *     <inner xmlns="http://commcareconnect.com/data/v1/learn" id="wrapper">
 *       <child/>...
 *     </inner>
 *   </wrapper>
 *
 * The vellum:role attribute is what tells HQ this is a Connect entity, not a
 * plain hidden question. Without it, HQ can't process the Connect structure
 * and child binds (entity_id, user_score, etc.) fail at runtime.
 *
 * Each wrapper also needs its own bind with vellum:nodeset.
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

/** Build complete XForm XML from question definitions. */
export function buildXForm(form: BlueprintForm, xmlns: string): string {
	const questions = form.questions || [];
	const instances = new InstanceTracker();
	const dataElements: string[] = [];
	const binds: string[] = [];
	const setvalues: string[] = [];
	const bodyElements: string[] = [];

	// Collect itext entries (single language)
	const itextEntries: string[] = [];

	const addItext = (id: string, text: string | undefined) => {
		if (!text) return;
		const processed = processLabelText(text);
		// Always emit both plain and markdown values — CommCare only renders markdown
		// when <value form="markdown"> is present, and it's a no-op for plain text.
		// Without the markdown form, any markdown syntax renders as literal characters.
		itextEntries.push(
			`<text id="${id}"><value>${processed}</value><value form="markdown">${processed}</value></text>`,
		);
	};

	for (const q of questions) {
		buildQuestionParts(
			q,
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

	// Append Connect data blocks and binds (data-only, no body elements)
	const connectParts = buildConnectBlocks(form.connect, instances);
	dataElements.push(...connectParts.dataElements);
	binds.push(...connectParts.binds);

	const dataContent =
		dataElements.length > 0
			? "\n" +
				dataElements.map((e) => `          ${e}`).join("\n") +
				"\n        "
			: "";

	const bindContent =
		binds.length > 0 ? `\n${binds.map((b) => `      ${b}`).join("\n")}` : "";

	const setvalueContent =
		setvalues.length > 0
			? `\n${setvalues.map((s) => `      ${s}`).join("\n")}`
			: "";

	const formName = form.name;

	// Build itext translation block (single language)
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
        <data xmlns="${xmlns}" xmlns:jrm="http://dev.commcarehq.org/jr/xforms" uiVersion="1" version="1" name="${escapeXml(formName.toLowerCase().replace(/[^a-z0-9]+/g, "_"))}">${dataContent}</data>
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
 * Recursively generate the four XForm parts for a question:
 * - dataElements: <instance> data nodes
 * - binds: <bind> elements with type, required, validation, etc.
 * - itextEntries: <itext> translation entries for labels/hints/options
 * - bodyElements: <h:body> input/select/group elements
 *
 * Groups and repeats recurse into their children, building nested paths.
 */
function buildQuestionParts(
	q: Question,
	parentPath: string,
	dataElements: string[],
	binds: string[],
	setvalues: string[],
	bodyElements: string[],
	insideRepeat: boolean,
	addItext: (id: string, text: string | undefined, markdown?: boolean) => void,
	instances: InstanceTracker,
): void {
	const nodePath = `${parentPath}/${q.id}`;

	// Register instance requirements for all XPath fields and labels
	for (const expr of [
		q.relevant,
		q.validation,
		q.calculate,
		q.default_value,
		q.required,
	]) {
		if (expr) instances.scanXPath(expr);
	}
	for (const text of [q.label, q.hint]) {
		if (text) instances.scanLabel(text);
	}

	// Data element
	dataElements.push(`<${q.id}/>`);

	// Bind — real attributes get expanded XPath, vellum: attributes keep shorthand
	const vellumPath = `#form${nodePath.slice(5)}`; // /data/x → #form/x
	const bindParts = [`vellum:nodeset="${vellumPath}"`, `nodeset="${nodePath}"`];
	const xsdType = getXsdType(q.type);
	if (xsdType) bindParts.push(`type="${xsdType}"`);
	if (q.required) {
		const expandedReq = expandHashtags(q.required);
		if (hasHashtags(q.required))
			bindParts.push(`vellum:required="${escapeXml(q.required)}"`);
		bindParts.push(`required="${escapeXml(expandedReq)}"`);
	}
	// Validation (constraint + constraintMsg) is only meaningful on input
	// question types. Structural types (group/repeat/label) have no value to
	// check, and hidden fields are computed so the user can never correct a
	// "failing" value. We silently skip both attributes for non-input types
	// so an upstream misconfiguration can't leak a garbage bind into the
	// XForm — validation rules (see rules/question.ts) surface it to the SA.
	const canValidate = supportsValidation(q.type);
	if (canValidate && q.validation) {
		if (hasHashtags(q.validation))
			bindParts.push(`vellum:constraint="${escapeXml(q.validation)}"`);
		bindParts.push(`constraint="${escapeXml(expandHashtags(q.validation))}"`);
	}
	// Validation message must be an itext reference — HQ's XForm parser only
	// extracts constraintMsg when it's `jr:itext(...)`; inline text is ignored,
	// so the message would vanish on upload to HQ.
	if (canValidate && q.validation_msg) {
		bindParts.push(`jr:constraintMsg="jr:itext('${q.id}-constraintMsg')"`);
	}
	if (q.relevant) {
		if (hasHashtags(q.relevant))
			bindParts.push(`vellum:relevant="${escapeXml(q.relevant)}"`);
		bindParts.push(`relevant="${escapeXml(expandHashtags(q.relevant))}"`);
	}
	if (q.calculate) {
		if (hasHashtags(q.calculate))
			bindParts.push(`vellum:calculate="${escapeXml(q.calculate)}"`);
		bindParts.push(`calculate="${escapeXml(expandHashtags(q.calculate))}"`);
	}
	// Setvalue for default_value — same dual-attribute pattern
	// Inside repeats, use jr-insert event so defaults fire per iteration, not just on form load
	if (q.default_value) {
		const expandedValue = expandHashtags(q.default_value);
		const vellumAttrs = hasHashtags(q.default_value)
			? ` vellum:value="${escapeXml(q.default_value)}"`
			: "";
		const event = insideRepeat ? "jr-insert" : "xforms-ready";
		setvalues.push(
			`<setvalue event="${event}" vellum:ref="${vellumPath}" ref="${nodePath}"${vellumAttrs} value="${escapeXml(expandedValue)}"/>`,
		);
	}
	// Add Vellum hashtag metadata for #case/ and #user/ references — only
	// scan expressions that actually made it onto the bind (validation is
	// dropped for non-input types above).
	const xpathExprs = [
		q.relevant,
		canValidate ? q.validation : undefined,
		q.calculate,
		q.default_value,
		q.required,
	].filter(Boolean) as string[];
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

	// itext (hidden questions have no body element, so no label to reference)
	if (q.type !== "hidden" && q.label) {
		addItext(`${q.id}-label`, q.label);
		addItext(`${q.id}-hint`, q.hint);
	}

	// Validation message itext — only emitted for types that support
	// validation (see supportsValidation). Paired with the
	// `jr:constraintMsg="jr:itext(...)"` reference on the bind above; never
	// emit the itext entry without the reference, or vice versa.
	if (canValidate) {
		addItext(`${q.id}-constraintMsg`, q.validation_msg);
	}

	// itext for select options
	if (q.options && q.options.length > 0) {
		for (const opt of q.options) {
			addItext(`${q.id}-${opt.value}-label`, opt.label);
		}
	}

	// Body element
	if (q.type === "hidden") {
		// Hidden values have no body element — data + bind only
		return;
	} else if (q.type === "group" || q.type === "repeat") {
		// Group/repeat: contains nested child questions
		const childData: string[] = [];
		const childBinds: string[] = [];
		const childBody: string[] = [];
		const childInsideRepeat = q.type === "repeat" ? true : insideRepeat;
		for (const child of q.children || []) {
			buildQuestionParts(
				child,
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
		// Replace the self-closing data element with a proper parent element wrapping children
		dataElements.pop();
		const templateAttr = q.type === "repeat" ? ' jr:template=""' : "";
		dataElements.push(
			`<${q.id}${templateAttr}>${childData.join("")}</${q.id}>`,
		);
		// Replace the group bind with just a relevant bind if needed
		binds.pop();
		if (q.relevant) {
			const expandedGroupRelevant = expandHashtags(q.relevant);
			const vellumRelevantAttr = hasHashtags(q.relevant)
				? ` vellum:relevant="${escapeXml(q.relevant)}"`
				: "";
			binds.push(
				`<bind vellum:nodeset="${vellumPath}" nodeset="${nodePath}"${vellumRelevantAttr} relevant="${escapeXml(expandedGroupRelevant)}"/>`,
			);
		}
		binds.push(...childBinds);
		// Re-indent ALL lines of child body elements for proper nesting.
		// Child elements have: line 0 at 0 indent (relative), subsequent lines with absolute indent.
		// For group: line 0 needs +6 (4 base + 2 nesting), subsequent lines need +2.
		// For repeat: line 0 needs +8 (4 base + 2 group + 2 repeat), subsequent lines need +4.
		if (q.type === "repeat") {
			const indentedChildren = childBody.map((el) => {
				const lines = el.split("\n");
				lines[0] = `        ${lines[0]}`;
				for (let i = 1; i < lines.length; i++) lines[i] = `    ${lines[i]}`;
				return lines.join("\n");
			});
			const innerLines = indentedChildren.join("\n");
			bodyElements.push(
				`<group ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>\n      <repeat nodeset="${nodePath}">\n${innerLines}\n      </repeat>\n    </group>`,
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
				`<group ref="${nodePath}" appearance="field-list">\n      <label ref="jr:itext('${q.id}-label')"/>\n${innerLines}\n    </group>`,
			);
		}
		return;
	} else if (q.type === "single_select" || q.type === "multi_select") {
		const tag = q.type === "single_select" ? "select1" : "select";
		const items = (q.options ?? [])
			.map(
				(opt) =>
					`  <item><label ref="jr:itext('${q.id}-${opt.value}-label')"/><value>${escapeXml(opt.value)}</value></item>`,
			)
			.join("\n    ");
		let el = `<${tag} ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`;
		if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`;
		el += `\n    ${items}\n    </${tag}>`;
		bodyElements.push(el);
	} else if (q.type === "label") {
		let el = `<trigger ref="${nodePath}" appearance="minimal">\n      <label ref="jr:itext('${q.id}-label')"/>`;
		if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`;
		el += `\n    </trigger>`;
		bodyElements.push(el);
	} else if (q.type === "secret") {
		let el = `<secret ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`;
		if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`;
		el += `\n    </secret>`;
		bodyElements.push(el);
	} else if (
		q.type === "image" ||
		q.type === "audio" ||
		q.type === "video" ||
		q.type === "signature"
	) {
		const mediatype =
			q.type === "audio"
				? "audio/*"
				: q.type === "video"
					? "video/*"
					: "image/*";
		const appearance = q.type === "signature" ? ' appearance="signature"' : "";
		let el = `<upload ref="${nodePath}" mediatype="${mediatype}"${appearance}>\n      <label ref="jr:itext('${q.id}-label')"/>`;
		if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`;
		el += `\n    </upload>`;
		bodyElements.push(el);
	} else {
		// Input types: text, int, decimal, date, time, datetime, geopoint, barcode
		const appearance = getAppearance(q.type);
		const appearanceAttr = appearance ? ` appearance="${appearance}"` : "";
		let el = `<input ref="${nodePath}"${appearanceAttr}>\n      <label ref="jr:itext('${q.id}-label')"/>`;
		if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`;
		el += `\n    </input>`;
		bodyElements.push(el);
	}
}

/** Map question type to XForm appearance attribute. */
function getAppearance(type: string): string | null {
	switch (type) {
		default:
			return null;
	}
}

/** Map question type to its XSD type for XForm <bind> elements. */
function getXsdType(type: string): string | null {
	switch (type) {
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
		case "label":
			return null;
		case "group":
			return null;
		case "repeat":
			return null;
		case "single_select":
			return "xsd:string";
		case "multi_select":
			return "xsd:string";
		default:
			return "xsd:string";
	}
}
