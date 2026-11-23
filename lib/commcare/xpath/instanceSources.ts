// HQ derives missing instance declarations by scanning the entire rendered XForm
// (xform.py::add_missing_instances, suite_xml/post_process/instances.py::get_instance_names).
// A local ID and the source it names are separate namespaces.
const nativeSources = new Map([
	["commcaresession", "jr://instance/session"],
	["casedb", "jr://instance/casedb"],
	["ledgerdb", "jr://instance/ledgerdb"],
	["groups", "jr://fixture/user-groups"],
	["locations", "jr://fixture/locations"],
	["reports", "jr://fixture/commcare:reports"],
	["registry", "jr://instance/remote/registry"],
	["search-input", "jr://instance/search-input"],
]);

const nativeIds = new Map(
	[...nativeSources].map(([id, source]) => [source, id]),
);
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

function factorySource(id: string): string | undefined {
	const native = nativeSources.get(id);
	if (native !== undefined) return native;
	const scheme = id.split(":")[0];
	if (
		scheme === "item-list" ||
		fixtureKinds.has(scheme) ||
		id === "commcare:reports"
	)
		return `jr://fixture/${id}`;
	if (scheme === "results") return `jr://instance/remote/${id}`;
	if (scheme === "search-input")
		return `jr://instance/search-input/${id.slice("search-input:".length)}`;
	if (
		scheme === "selected_cases" ||
		(!id.includes(":") && id.includes("selected_cases"))
	)
		return `jr://instance/selected-entities/${id}`;
	return undefined;
}

/** The factories HQ's scanner reaches in one rendered form or suite XPath.
 * Suite entries union scans of individual expressions, not concatenated text. */
export function* scannedInstances(
	text: string,
): Generator<readonly [string, string]> {
	// Python also admits U+001C..U+001F as whitespace. XML 1.0 cannot contain them.
	for (const match of text.matchAll(
		/instance\(\p{White_Space}*['"]([\p{L}\p{N}_:-]+)['"]\p{White_Space}*\)/gu,
	)) {
		const id = match[1];
		const source = factorySource(id);
		if (source !== undefined) yield [id, source];
	}
}

/** The secondary instances available to reads after HQ has built the form.
 * Declared IDs, even those with an inline root, always win over a factory. */
export function formInstanceSources(
	declared: ReadonlyMap<string, string>,
	rendered: string,
	declaredIds: ReadonlySet<string> = new Set(declared.keys()),
): ReadonlyMap<string, string> {
	const sources = new Map(declared);
	for (const [id, source] of scannedInstances(rendered)) {
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
