import { hqHtmlUnescape } from "../hqInstanceScan";

// HQ derives missing instance declarations by scanning the entire rendered XForm
// (xform.py::add_missing_instances, suite_xml/post_process/instances.py::get_instance_names).
// A local ID and the source it names are separate namespaces.
const nativeSources = new Map([
	["commcaresession", "jr://instance/session"],
	["casedb", "jr://instance/casedb"],
	["ledgerdb", "jr://instance/ledgerdb"],
	["groups", "jr://fixture/user-groups"],
	["reports", "jr://fixture/commcare:reports"],
	["registry", "jr://instance/remote/registry"],
]);

const nativeIds = new Map(
	[...nativeSources].map(([id, source]) => [source, id]),
);
nativeIds.set("jr://fixture/locations", "locations");
nativeIds.set("jr://instance/search-input", "search-input");
const fixtureKinds = new Set([
	"commtrack",
	"schedule",
	"indicators",
	"case-search-fixture",
	"commcare-reports",
	"commcare-reports-filters",
]);

export type InstanceSource =
	| { kind: "table"; tag: string }
	| { kind: "selected"; datum: string }
	| { kind: "native"; id: string };

export function declaredInstance(source: string): InstanceSource | undefined {
	const native = nativeIds.get(source);
	if (native !== undefined) return { kind: "native", id: native };
	const fixture = "jr://fixture/";
	if (source.startsWith(fixture)) {
		const id = source.slice(fixture.length);
		if (id.startsWith("item-list:") && id.length > "item-list:".length)
			return { kind: "table", tag: id.slice("item-list:".length) };
		if (fixtureKinds.has(id.split(":")[0])) return { kind: "native", id };
	}
	const selected = "jr://instance/selected-entities/";
	if (source.startsWith(selected) && source.length > selected.length)
		return { kind: "selected", datum: source.slice(selected.length) };
	const remote = "jr://instance/remote/";
	if (source.startsWith(remote)) {
		const id = source.slice(remote.length);
		if (id === "results" || id.startsWith("results:"))
			return { kind: "native", id };
	}
	const search = "jr://instance/search-input/";
	if (source.startsWith(search) && source.length > search.length)
		return {
			kind: "native",
			id: `search-input:${source.slice(search.length)}`,
		};
	return undefined;
}

/** Facts of the source app and its HQ project space. An absent project fact is
 * unresolved. An explicit declaration resolves solely from its own source. */
export type ConditionalFactory = "locations" | "mobileReports";

export interface InstanceFactories {
	readonly observe?: (kind: ConditionalFactory, id: string) => void;
	readonly namedResults: ReadonlySet<string>;
	readonly scrubbedReportSlugs: ReadonlySet<string>;
	readonly locations?: "flat" | "hierarchical";
	readonly mobileReports?: boolean;
}

function validResults(id: string, facts?: InstanceFactories): boolean {
	return (
		id === "results" ||
		id === "results:inline" ||
		facts?.namedResults.has(id) === true
	);
}

function factorySource(
	id: string,
	facts?: InstanceFactories,
): string | undefined {
	const native = nativeSources.get(id);
	if (native !== undefined) return native;
	const colon = id.indexOf(":");
	const scheme = colon < 0 ? id : id.slice(0, colon);
	switch (scheme) {
		case "locations":
			facts?.observe?.("locations", id);
			if (facts?.locations === undefined) return undefined;
			return facts.locations === "flat"
				? `jr://fixture/${id}`
				: `jr://fixture/commtrack:${id}`;
		case "item-list":
		case "commtrack":
		case "schedule":
		case "indicators":
		case "case-search-fixture":
			return `jr://fixture/${id}`;
		case "commcare":
			if (id === "commcare:reports") facts?.observe?.("mobileReports", id);
			return id === "commcare:reports" && facts?.mobileReports
				? `jr://fixture/${id}`
				: undefined;
		case "commcare-reports":
		case "commcare-reports-filters": {
			if (colon >= 0) facts?.observe?.("mobileReports", id);
			if (!facts?.mobileReports || colon < 0) return undefined;
			const name = id.slice(colon + 1);
			return facts.scrubbedReportSlugs.has(name)
				? undefined
				: `jr://fixture/${scheme}:${name}`;
		}
		case "results":
			return validResults(id, facts) ? `jr://instance/remote/${id}` : undefined;
		case "search-input": {
			if (colon < 0) return "jr://instance/search-input";
			const name = id.slice(colon + 1);
			return validResults(name, facts)
				? `jr://instance/search-input/${name}`
				: undefined;
		}
		default:
			return scheme === "selected_cases" ||
				(colon < 0 && id.includes("selected_cases"))
				? `jr://instance/selected-entities/${id}`
				: undefined;
	}
}

// Python \s also includes four information separators in JSON XPath.
const pythonWhitespace = String.raw`[\p{White_Space}\u001c-\u001f]*`;
const instancePattern = new RegExp(
	String.raw`instance\(${pythonWhitespace}['"]([\p{L}\p{N}_:-]+)['"]${pythonWhitespace}\)`,
	"gu",
);

/** The factories HQ's scanner reaches in one rendered form or suite XPath.
 * Suite entries union scans of individual expressions, not concatenated text. */
export function scannedInstances(
	rendered: string,
	facts?: InstanceFactories,
	declaredIds?: ReadonlySet<string>,
	invalidPreset?: (id: string) => void,
): Iterable<readonly [string, string]> {
	return matchedFactories(
		hqHtmlUnescape(rendered),
		facts,
		declaredIds,
		invalidPreset,
	);
}

function* matchedFactories(
	text: string,
	facts?: InstanceFactories,
	declaredIds?: ReadonlySet<string>,
	invalidPreset?: (id: string) => void,
): Generator<readonly [string, string]> {
	for (const match of text.matchAll(instancePattern)) {
		const id = match[1];
		// HQ dispatches the scheme before checking declarations. Its preset
		// factory indexes the fixed dictionary by the entire matched ID.
		const colon = id.indexOf(":");
		if (colon >= 0 && nativeSources.has(id.slice(0, colon))) {
			invalidPreset?.(id);
			continue;
		}
		if (declaredIds?.has(id)) continue;
		const source = factorySource(id, facts);
		if (source !== undefined) yield [id, source];
	}
}

/** The secondary instances available to reads after HQ has built the form.
 * Declared IDs, even those with an inline root, always win over a factory. */
export function instanceSourcesAfterScan(
	declared: ReadonlyMap<string, string>,
	input: { rendered: string } | { xmlValue: string },
	declaredIds: ReadonlySet<string> = new Set(declared.keys()),
	facts?: InstanceFactories,
	invalidPreset?: (id: string) => void,
): ReadonlyMap<string, string> {
	const sources = new Map(declared);
	// In an XML value already decoded by its parser, the single unescape of
	// lxml's re-escaped value restores that exact value.
	const factories =
		"rendered" in input
			? scannedInstances(input.rendered, facts, declaredIds, invalidPreset)
			: matchedFactories(input.xmlValue, facts, declaredIds, invalidPreset);
	for (const [id, source] of factories) {
		if (!declaredIds.has(id)) sources.set(id, source);
	}
	return sources;
}

/** Suite reads use the factory registered for the ID. A form reads the
 * source already declared or supplied during its own build. */
export function instanceForRead(
	id: string,
	sources?: ReadonlyMap<string, string>,
): InstanceSource | undefined {
	const source = sources === undefined ? factorySource(id) : sources.get(id);
	return source === undefined ? undefined : declaredInstance(source);
}
