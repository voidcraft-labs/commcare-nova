/** Released endpoint verification follows reachable runtime definitions, not labels. */
import { type Element, isTag } from "domhandler";
import { textContent } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

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
	if (XMLValidator.validate(xml) !== true) return undefined;
	const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
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
