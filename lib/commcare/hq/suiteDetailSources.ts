import { readWorkLimit } from "../reader/work";
import {
	chargeWork,
	currentWorkMeter,
	underMeter,
	WorkMeter,
} from "../workMeter";
import { elementChildren, elementNamespace } from "../xmlNamespaces";
import { tryParseXml } from "../xmlParse";

/** Detail IDs and tagged navigation scopes. A null scope was absent from
 * the suite. A null source is missing or ambiguous in that evaluator. */
export type SuiteDetailSources = ReadonlyMap<
	string,
	ReadonlyMap<string, string | null> | null
>;
export type SuiteDetailReads = ReadonlyMap<string, ReadonlySet<string>>;

/** HQ gives each menu contributor the commands of one physical module, even
 * when several contributors share the same rendered menu ID. */
export function suiteMenuScope(module: number): string {
	return `menu:m${module}`;
}

/** The ID of the entry evaluating a physical form command. */
export function suiteFormScope(module: number, form: number): string {
	return `entry:m${module}-f${form}`;
}

/** Intersect the scopes where the expression really runs. Never give a query
 * an instance declared only by another entry or by another build profile. */
export function sharedSources(
	scopes: readonly ReadonlyMap<string, string>[],
): ReadonlyMap<string, string> {
	if (scopes.length === 1) return scopes[0];
	const common = new Map(scopes[0]);
	for (const scope of scopes.slice(1)) {
		chargeWork("compare", common.size);
		for (const [id, src] of common)
			if (scope.get(id) !== src) common.delete(id);
	}
	return common;
}

/** InstancesHelper collects detail-select, -confirm, -inline and -persistent
 * from session datums. Only the direct declarations of the owning entry or
 * remote request can supply a source in that entry. */
export function readSuiteDetailSources(
	xml: string,
	reads: SuiteDetailReads,
	signal?: AbortSignal,
	menuInstances = true,
): SuiteDetailSources | undefined {
	return underMeter(
		new WorkMeter({
			limit: readWorkLimit(xml.length),
			parent: currentWorkMeter(),
			signal,
		}),
		() => sourcesIn(xml, reads, menuInstances),
	);
}

function sourcesIn(
	xml: string,
	reads: SuiteDetailReads,
	menuInstances: boolean,
): SuiteDetailSources | undefined {
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return;
	type Node = ReturnType<typeof elementChildren>[number];
	const roots = elementChildren(parsed.doc.children, new Map());
	const plain = (n: Node) => elementNamespace(n.element, n.scope) === null;
	if (
		roots.length !== 1 ||
		!plain(roots[0]) ||
		roots[0].element.name !== "suite"
	)
		return;
	const children = (n: Node) =>
		elementChildren(n.element.children, n.scope).filter(plain);
	const top = children(roots[0]);
	const details = new Set<string>();
	for (const n of top)
		if (n.element.name === "detail" && reads.has(n.element.attribs.id)) {
			if (details.has(n.element.attribs.id)) return;
			details.add(n.element.attribs.id);
		}
	const commandIds = (owned: readonly Node[]) =>
		owned.flatMap(({ element }) =>
			element.name === "command" && element.attribs.id
				? [element.attribs.id]
				: [],
		);
	const contributor = (commands: readonly string[]) => {
		const owners = new Set(
			commands
				.map((id) => /^(m[0-9]+)-/.exec(id)?.[1])
				.filter((owner): owner is string => owner !== undefined),
		);
		return owners.size === 1 ? `menu:${[...owners][0]}` : undefined;
	};

	// Before 2.54 HQ puts menu declarations on the entries reached by all
	// contributors that share the displayed menu ID.
	const menuScopesByCommand = new Map<string, Set<string>>();
	if (!menuInstances) {
		const menus = new Map<
			string,
			{ scopes: Set<string>; commands: string[] }
		>();
		for (const menu of top) {
			const {
				name,
				attribs: { id },
			} = menu.element;
			if (name !== "menu" || !id) continue;
			const commands = commandIds(children(menu));
			const record = menus.get(id) ?? {
				scopes: new Set<string>(),
				commands: [],
			};
			const scope = contributor(commands);
			if (scope && reads.has(scope)) record.scopes.add(scope);
			for (const command of commands) record.commands.push(command);
			menus.set(id, record);
		}
		for (const { scopes, commands } of menus.values()) {
			if (!scopes.size) continue;
			chargeWork("compare", commands.length * scopes.size);
			for (const id of commands) {
				const reached = menuScopesByCommand.get(id) ?? new Set<string>();
				for (const scope of scopes) reached.add(scope);
				menuScopesByCommand.set(id, reached);
			}
		}
	}
	const output = new Map<string, ReadonlyMap<string, string | null> | null>();
	const result = new Map<string, Map<string, string> | null>(
		Array.from(reads.keys(), (id) => [id, null]),
	);
	for (const entry of top) {
		const kind = entry.element.name;
		if (kind !== "entry" && kind !== "remote-request" && kind !== "menu")
			continue;
		const owned = children(entry);
		const used = new Set<string>();
		if (kind === "menu") {
			if (!menuInstances) continue;
			// A training or custom menu that mixes contributors supplies no
			// declaration for an ordinary module's expressions.
			const scope = contributor(commandIds(owned));
			if (scope && reads.has(scope)) used.add(scope);
		} else {
			const [command] = commandIds(owned);
			if (command) {
				const key = `entry:${command}`;
				if (kind === "entry" && reads.has(key)) used.add(key);
				for (const scope of menuScopesByCommand.get(command) ?? [])
					used.add(scope);
			}
		}

		for (const session of owned)
			if (session.element.name === "session") {
				for (const datum of children(session)) {
					if (
						datum.element.name !== "datum" &&
						datum.element.name !== "instance-datum"
					)
						continue;
					for (const attr of [
						"detail-select",
						"detail-confirm",
						"detail-inline",
						"detail-persistent",
					]) {
						const id = datum.element.attribs[attr];
						if (!reads.has(id)) continue;
						if (!details.has(id)) return;
						used.add(id);
					}
				}
			}
		if (!used.size) continue;
		const sources = new Map<string, string | null>();
		for (const n of owned)
			if (n.element.name === "instance") {
				const { id, src } = n.element.attribs;
				if (!id) continue;
				sources.set(id, sources.has(id) ? null : (src ?? null));
			}
		for (const detail of used) {
			const shared = result.get(detail);
			if (shared) {
				chargeWork("compare", shared.size);
				for (const [id, src] of shared)
					if (sources.get(id) !== src) shared.delete(id);
			} else {
				const current = new Map<string, string>();
				const names = reads.get(detail);
				if (!names) continue;
				chargeWork("compare", names.size);
				for (const id of names) {
					const src = sources.get(id);
					if (src) current.set(id, src);
				}
				result.set(detail, current);
			}
		}
	}
	for (const [detail, scope] of result)
		if (scope) {
			const answered = new Map<string, string | null>(scope);
			for (const id of reads.get(detail) ?? [])
				if (!scope.has(id)) answered.set(id, null);
			output.set(detail, answered);
		} else output.set(detail, null);
	return output;
}
