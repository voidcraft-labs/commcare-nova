/** Released endpoint verification follows reachable runtime definitions, not labels. */

import type { SyntaxNode } from "@lezer/common";
import { type Element, isTag } from "domhandler";
import { textContent } from "domutils";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { tryParseXml } from "./xmlParse";
import { parser } from "./xpath/parser";

const SIGNATURE_TAGS = new Set([
	"endpoint",
	"argument",
	"stack",
	"create",
	"push",
	"clear",
	"rewind",
	"mark",
	"jump",
	"url",
	"datum",
	"instance-datum",
	"command",
	"query",
	"data",
	"remote-request",
	"entry",
	"form",
	"instance",
	"session",
	"post",
	"assertions",
	"assert",
	"prompt",
	"itemset",
	"label",
	"value",
	"sort",
	"required",
	"validation",
]);

function signatureRecord(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid entry-point signature object.");
	return value as Record<string, unknown>;
}

function signatureKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some(
			(key) => !required.includes(key) && !optional.includes(key),
		)
	)
		throw new Error("Unknown entry-point signature shape.");
}

function signatureString(value: unknown): string {
	if (typeof value !== "string")
		throw new Error("Invalid entry-point signature text.");
	return value;
}

function signatureArray(value: unknown): unknown[] {
	if (!Array.isArray(value))
		throw new Error("Invalid entry-point signature list.");
	return value;
}

/** Preserve operators, operand nesting and literal contents. Only spelling
 * whitespace and the quote delimiter disappear; no wire emitter is involved. */
function signatureXPath(source: string): unknown {
	const tree = parser.parse(source);
	const node = (part: SyntaxNode): unknown => {
		if (part.type.isError)
			throw new Error("Invalid entry-point signature XPath.");
		const children: unknown[] = [];
		for (let child = part.firstChild; child; child = child.nextSibling) {
			if (!["(", ")", ","].includes(child.name)) children.push(node(child));
		}
		const text = source.slice(part.from, part.to);
		return part.firstChild !== null
			? { kind: part.name, children }
			: {
					kind: part.name,
					value: part.name === "StringLiteral" ? text.slice(1, -1) : text,
				};
	};
	if (source.trim() === "")
		throw new Error("Empty entry-point signature XPath.");
	return node(tree.topNode);
}

function signatureXPathAttribute(
	tag: string,
	name: string,
	parent?: string,
): boolean {
	if (["datum", "instance-datum", "form"].includes(tag))
		return ["nodeset", "value", "function"].includes(name);
	if (tag === "command")
		return (
			name === "relevant" ||
			(name === "value" && (parent === "create" || parent === "push"))
		);
	if (["create", "push", "clear"].includes(tag)) return name === "if";
	if (tag === "rewind" || tag === "mark") return name === "value";
	if (tag === "post") return name === "relevant";
	if (tag === "data") return ["ref", "nodeset", "exclude"].includes(name);
	if (tag === "prompt")
		return ["default", "exclude", "required"].includes(name);
	if (tag === "itemset") return name === "nodeset";
	if (["label", "value", "sort"].includes(tag))
		return parent === "itemset" && name === "ref";
	return ["assert", "required", "validation"].includes(tag) && name === "test";
}

function comparisonNode(value: unknown, parent?: string): unknown {
	const node = signatureRecord(value);
	signatureKeys(node, ["tag", "attributes", "children"], ["value"]);
	const tag = signatureString(node.tag);
	if (
		!SIGNATURE_TAGS.has(tag) ||
		(Object.hasOwn(node, "value") && tag !== "form")
	)
		throw new Error("Unknown entry-point signature node.");
	const attributes = Object.fromEntries(
		Object.entries(signatureRecord(node.attributes)).map(([key, value]) => {
			const text = signatureString(value);
			return [
				key,
				signatureXPathAttribute(tag, key, parent) ? signatureXPath(text) : text,
			];
		}),
	);
	return {
		tag,
		attributes,
		children: signatureArray(node.children).map((child) =>
			comparisonNode(child, tag),
		),
		...(Object.hasOwn(node, "value")
			? { value: signatureString(node.value) }
			: {}),
	};
}

function comparisonSignature(source: string): string {
	const signature = signatureRecord(JSON.parse(source));
	signatureKeys(signature, ["endpoint", "definitions"]);
	const endpoint = signatureRecord(signature.endpoint);
	if (endpoint.tag !== "endpoint")
		throw new Error("Invalid signature endpoint.");
	const definitions = signatureArray(signature.definitions).map((value) => {
		const definition = signatureRecord(value);
		const id = signatureString(definition.id);
		if (Object.hasOwn(definition, "definition")) {
			signatureKeys(definition, ["id", "definition"]);
			if (
				!["entry", "remote-request"].includes(
					signatureString(signatureRecord(definition.definition).tag),
				)
			)
				throw new Error("Invalid signature definition.");
			return { id, definition: comparisonNode(definition.definition) };
		}
		if (Object.hasOwn(definition, "session")) {
			signatureKeys(definition, ["id", "session"]);
			return {
				id,
				session: signatureArray(definition.session).map((value) => {
					if (signatureRecord(value).tag !== "session")
						throw new Error("Invalid signature session.");
					return comparisonNode(value);
				}),
			};
		}
		signatureKeys(definition, [
			"tag",
			"id",
			"root",
			"relevant",
			"guards",
			"commands",
		]);
		if (definition.tag !== "menu") throw new Error("Invalid signature menu.");
		const relevant = signatureString(definition.relevant);
		return {
			tag: "menu",
			id,
			root: signatureString(definition.root),
			relevant: relevant === "" ? "" : signatureXPath(relevant),
			guards: signatureArray(definition.guards).map((value) => {
				if (
					!["assertions", "instance"].includes(
						signatureString(signatureRecord(value).tag),
					)
				)
					throw new Error("Invalid signature guard.");
				return comparisonNode(value, "menu");
			}),
			commands: signatureArray(definition.commands).map((value) => {
				const command = signatureRecord(value);
				signatureKeys(command, ["id", "relevant"]);
				const relevant = signatureString(command.relevant);
				return {
					id: signatureString(command.id),
					relevant: relevant === "" ? "" : signatureXPath(relevant),
				};
			}),
		};
	});
	return canonicalJsonText({ endpoint: comparisonNode(endpoint), definitions });
}

/** Published manifests retain the original canonical-JSON storage format.
 * Compare both old and current signatures through the same parsed XPath form;
 * an unknown shape or invalid expression supplies no release evidence. */
export function endpointSignaturesMatch(
	actual: string | undefined,
	published: string,
): boolean {
	if (actual === undefined) return false;
	try {
		return comparisonSignature(actual) === comparisonSignature(published);
	} catch {
		return false;
	}
}

const elements = (e: Element) => e.children.filter(isTag);
function canonical(e: Element, appIds: readonly string[] = []): unknown {
	// Display strings, generated resource versions and presentation are not the
	// endpoint navigation contract. HQ can omit Search title when its
	// enable_case_search_title_translation setting is false (RemoteRequestFactory).
	// Keep all session/filter/claim expressions.
	return {
		tag: e.name,
		...(e.name === "form" ? { value: textContent(e).trim() } : {}),
		attributes: Object.fromEntries(
			Object.entries(e.attribs)
				.map(([key, value]) => [key, normalizeRuntimeUrl(value, appIds)])
				.sort(([a], [b]) => a.localeCompare(b)),
		),
		children: elements(e)
			.filter(
				(c) => !["display", "text", "title", "description"].includes(c.name),
			)
			.map((child) => canonical(child, appIds)),
	};
}
function normalizeRuntimeUrl(value: string, appIds: readonly string[]): string {
	try {
		const url = new URL(value);
		const parts = url.pathname.split("/");
		// /a/<domain>/phone/search|case_fixture/<app>/
		if (
			parts.length === 7 &&
			parts[1] === "a" &&
			parts[3] === "phone" &&
			["search", "case_fixture"].includes(parts[4]) &&
			appIds.includes(decodeURIComponent(parts[5]))
		) {
			parts[5] = "__APP_ID__";
			url.pathname = parts.join("/");
			return url.toString();
		}
	} catch {
		/* Ordinary XPath attributes are not URLs. */
	}
	return value;
}
/** Undefined means absent or structurally ambiguous; callers fail closed. */
export function endpointSuiteSignature(
	xml: string,
	endpointId: string,
	options: { readonly appIds?: readonly string[] } = {},
): string | undefined {
	const appIds = options.appIds ?? [];
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return undefined;
	const { doc } = parsed;
	const top = doc.children.filter(isTag);
	if (top.length !== 1 || top[0].name !== "suite") return undefined;
	const suite = top[0];
	const roots = elements(suite);
	const endpoints = roots.filter(
		(e) => e.name === "endpoint" && e.attribs.id === endpointId,
	);
	if (endpoints.length !== 1) return undefined;
	const endpoint = endpoints[0];
	const commandIds = new Set<string>();
	const walk = (e: Element): void => {
		if (e.name === "command" && e.attribs.value) {
			const v = e.attribs.value;
			if (v.startsWith("'") && v.endsWith("'")) commandIds.add(v.slice(1, -1));
		}
		elements(e).forEach(walk);
	};
	walk(endpoint);
	const definitions: unknown[] = [];
	for (const id of [...commandIds].sort()) {
		const matches = roots.filter(
			(e) =>
				(e.name === "menu" && e.attribs.id === id) ||
				(["entry", "remote-request"].includes(e.name) &&
					elements(e).some((c) => c.name === "command" && c.attribs.id === id)),
		);
		if (matches.length !== 1) return undefined;
		const definition = matches[0];
		if (definition.name === "menu") {
			definitions.push({
				tag: "menu",
				id,
				root: definition.attribs.root ?? "",
				relevant: definition.attribs.relevant ?? "",
				guards: elements(definition)
					.filter((c) => c.name === "assertions" || c.name === "instance")
					.map((c) => canonical(c, appIds)),
				commands: elements(definition)
					.filter((c) => c.name === "command")
					.map((c) => ({
						id: c.attribs.id,
						relevant: c.attribs.relevant ?? "",
					})),
			});
			// A module destination's selection is determined by every menu entry.
			for (const command of elements(definition).filter(
				(c) => c.name === "command",
			))
				if (command.attribs.id) {
					const entries = roots.filter(
						(e) =>
							e.name === "entry" &&
							elements(e).some(
								(c) =>
									c.name === "command" && c.attribs.id === command.attribs.id,
							),
					);
					if (entries.length !== 1) return undefined;
					definitions.push({
						id: command.attribs.id,
						session: elements(entries[0])
							.filter((c) => c.name === "session")
							.map((child) => canonical(child, appIds)),
					});
				}
		} else {
			definitions.push({ id, definition: canonical(definition, appIds) });
		}
	}
	return canonicalJsonText({
		endpoint: canonical(endpoint, appIds),
		definitions,
	});
}
