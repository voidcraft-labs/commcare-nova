/** Shared constructors for raw XML values. Emitters build ordered domhandler
 * trees; serializeXml is the sole escaping and whitespace-preservation boundary.
 * Never escape a value before constructing its element or text node. */

import { type ChildNode, Element, Text } from "domhandler";
import {
	type LegacyAuthoredXPath,
	type LegacyFormLinkXPath,
	legacyAuthoredXPathText,
	legacyFormLinkXPathText,
} from "./xform/legacyAuthoredXPath";
import type { InstanceDecl, InstanceSink } from "./xpath/wire/instances";
import { serializeWire } from "./xpath/wire/serialize";
import type { WireExpr, WireMode } from "./xpath/wire/tree";

/** Executable attributes only. A stack query's value, for example, is a URL. */
const XPATH_ATTRIBUTES = {
	bind: [
		"nodeset",
		"relevant",
		"required",
		"constraint",
		"calculate",
		"readonly",
		"jr:constraintMsg",
		"vellum:nodeset",
		"vellum:relevant",
		"vellum:requiredCondition",
		"vellum:constraint",
		"vellum:calculate",
	],
	setvalue: ["ref", "value", "vellum:ref"],
	output: ["ref", "value", "vellum:value"],
	repeat: ["nodeset", "jr:count", "vellum:jr__count"],
	group: ["ref", "function"],
	input: ["ref"],
	select: ["ref"],
	select1: ["ref"],
	upload: ["ref"],
	secret: ["ref"],
	trigger: ["ref"],
	range: ["ref"],
	"orx:pollsensor": ["ref"],
	itemset: ["nodeset"],
	label: ["ref"],
	value: ["ref"],
	hint: ["ref"],
	help: ["ref"],
	alert: ["ref"],
	sort: ["ref"],
	xpath: ["function"],
	datum: ["nodeset", "value", "function"],
	"instance-datum": ["nodeset", "value", "function"],
	form: ["nodeset", "value", "function"],
	data: ["ref", "nodeset", "exclude"],
	prompt: ["default", "exclude"],
	required: ["test"],
	validation: ["test"],
	assert: ["test"],
	post: ["relevant"],
	create: ["if", "value"],
	push: ["if", "value"],
	clear: ["if", "value"],
	rewind: ["if", "value"],
	command: ["relevant", "if", "value"],
	action: ["relevant", "auto_launch"],
	field: ["relevant"],
	detail: ["relevant"],
	menu: ["relevant"],
} as const;

const AUTHORED_ATTRIBUTES = {
	bind: [
		"relevant",
		"required",
		"constraint",
		"calculate",
		"jr:constraintMsg",
		"vellum:relevant",
		"vellum:requiredCondition",
		"vellum:constraint",
		"vellum:calculate",
	],
	setvalue: ["value"],
	output: ["ref", "value", "vellum:value"],
	repeat: ["jr:count"],
} as const;

const FORM_LINK_ATTRIBUTES = {
	create: ["if"],
	push: ["if"],
	clear: ["if"],
	datum: ["value"],
} as const;

type XPathElementName = keyof typeof XPATH_ATTRIBUTES;
type XPathAttribute<Name extends string> = Name extends XPathElementName
	? (typeof XPATH_ATTRIBUTES)[Name][number]
	: never;
type AuthoredAttribute<Name extends string> =
	Name extends keyof typeof AUTHORED_ATTRIBUTES
		? (typeof AUTHORED_ATTRIBUTES)[Name][number]
		: never;
type FormLinkAttribute<Name extends string> =
	Name extends keyof typeof FORM_LINK_ATTRIBUTES
		? (typeof FORM_LINK_ATTRIBUTES)[Name][number]
		: never;
type RawAttributes<Name extends string> = Record<string, string> &
	Partial<Record<XPathAttribute<Name>, never>>;
type SlotMap<Keys extends string, Value> = [Keys] extends [never]
	? never
	: Partial<Record<Keys, Value>>;

export interface WireElementContext {
	readonly mode: WireMode;
	readonly instances: InstanceSink;
	/** The sole temporary text reader; removed with the form-logic transition. */
	readonly resolveLegacyInstances?: (
		value: LegacyAuthoredXPath | LegacyFormLinkXPath,
	) => Iterable<InstanceDecl>;
}

export interface WireElementSpec<Name extends XPathElementName> {
	readonly attributes?: RawAttributes<Name>;
	readonly xpath?: Partial<Record<XPathAttribute<Name>, WireExpr>>;
	readonly authoredXPath?: SlotMap<
		AuthoredAttribute<Name>,
		LegacyAuthoredXPath
	>;
	readonly legacyFormLinkXPath?: SlotMap<
		FormLinkAttribute<Name>,
		LegacyFormLinkXPath
	>;
}

function includesAttribute(
	table: Readonly<Record<string, readonly string[]>>,
	name: string,
	attribute: string,
): boolean {
	return Object.hasOwn(table, name) && table[name].includes(attribute);
}

function rawAttributes(
	name: string,
	attributes: Readonly<Record<string, string>>,
): Record<string, string> {
	for (const attribute of Object.keys(attributes)) {
		if (includesAttribute(XPATH_ATTRIBUTES, name, attribute))
			throw new Error(
				`The <${name}> ${attribute} attribute requires an XPath tree.`,
			);
	}
	return { ...attributes };
}

function attributeMode(mode: WireMode, attribute: string): WireMode {
	if (attribute.startsWith("vellum:")) {
		if (mode.target !== "xform" && mode.target !== "vellum")
			throw new Error("A Vellum shadow belongs to an XForm element.");
		return { target: "vellum", constraint: attribute === "vellum:constraint" };
	}
	return mode.target === "xform" || mode.target === "vellum"
		? { ...mode, constraint: attribute === "constraint" }
		: mode;
}

/** Serialize executable values at their XML slot and accumulate the reads. */
export function xel<const Name extends XPathElementName>(
	name: Name,
	spec: WireElementSpec<NoInfer<Name>>,
	context: WireElementContext,
	children: ChildNode[] = [],
): Element {
	const attributes = rawAttributes(name, spec.attributes ?? {});
	const written = new Set(Object.keys(attributes));
	const claim = (attribute: string) => {
		if (written.has(attribute))
			throw new Error(
				`The <${name}> ${attribute} attribute was supplied more than once.`,
			);
		written.add(attribute);
	};
	const xpath: Readonly<Record<string, WireExpr | undefined>> =
		spec.xpath ?? {};
	for (const [attribute, expression] of Object.entries(xpath)) {
		if (expression === undefined) continue;
		if (!includesAttribute(XPATH_ATTRIBUTES, name, attribute))
			throw new Error(
				`The <${name}> ${attribute} attribute is not an XPath slot.`,
			);
		claim(attribute);
		const printed = serializeWire(
			expression,
			attributeMode(context.mode, attribute),
		);
		if (printed === undefined) continue;
		attributes[attribute] = printed.text;
		context.instances.add(printed.instances);
	}
	const legacy = <Legacy extends LegacyAuthoredXPath | LegacyFormLinkXPath>(
		table: Readonly<Record<string, readonly string[]>>,
		values: Readonly<Record<string, Legacy | undefined>>,
		textOf: (value: Legacy) => string,
	) => {
		for (const [attribute, expression] of Object.entries(values)) {
			if (expression === undefined) continue;
			if (!includesAttribute(table, name, attribute))
				throw new Error(
					`The <${name}> ${attribute} attribute is not a legacy authored slot.`,
				);
			claim(attribute);
			if (context.resolveLegacyInstances === undefined)
				throw new Error(
					"An authored XPath slot needs its temporary instance resolver.",
				);
			attributes[attribute] = textOf(expression);
			context.instances.add(context.resolveLegacyInstances(expression));
		}
	};
	legacy(
		AUTHORED_ATTRIBUTES,
		spec.authoredXPath ?? {},
		legacyAuthoredXPathText,
	);
	legacy(
		FORM_LINK_ATTRIBUTES,
		spec.legacyFormLinkXPath ?? {},
		legacyFormLinkXPathText,
	);
	return new Element(name, attributes, children);
}

/**
 * Build an XML element with raw attribute values and optional element
 * children. Attribute insertion order is preserved by the serializer, so
 * callers control byte-level attribute sequence by ordering the `attribs`
 * object literal.
 */
export function el<const Name extends string>(
	name: Name,
	attribs: RawAttributes<NoInfer<Name>>,
	children: ChildNode[] = [],
): Element {
	return new Element(name, rawAttributes(name, attribs), children);
}

/**
 * Build a Text node carrying raw character data. The serializer XML-escapes
 * the text exactly once at render time.
 */
export function text(data: string): Text {
	return new Text(data);
}
