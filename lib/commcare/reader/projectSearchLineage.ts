import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { projectSearchOf } from "@/lib/domain/modules";
import type { HqAppSource } from "../hq/appSource";
import { isProjectSearchId } from "../hq/projectSearch";
import type { ProjectSearchBinding, WireIdentity } from "../wireIdentity";
import { isJsonObject } from "./jsonCursor";

/** Read only the identity carried by a menu that offers a search. An inactive
 * shell can retain a stale id and supplies no evidence about an app's search. */
function menuServices(source: HqAppSource): Map<string, number> {
	const byMenu = new Map<string, number>();
	if (!Array.isArray(source.raw.modules)) return byMenu;
	for (const [index, raw] of source.raw.modules.entries()) {
		const menu = source.modules[index];
		if (!menu?.caseType || !menu.uniqueId || !isJsonObject(raw)) continue;
		const config = raw.search_config;
		if (
			!isJsonObject(config) ||
			!isProjectSearchId(config.case_search_endpoint_id)
		)
			continue;
		if (
			[config.properties, config.default_properties].some(
				(entries) => Array.isArray(entries) && entries.length,
			)
		)
			byMenu.set(menu.uniqueId, config.case_search_endpoint_id);
	}
	return byMenu;
}

/** Before reading an edited app, recover the published logical-to-physical
 * mapping from this baseline's own menus. A contributor may already have
 * chosen a different service for the next publish to this destination. */
export function baselineSearchBindings(
	doc: BlueprintDoc,
	source: HqAppSource,
	wire: WireIdentity,
	stored: readonly ProjectSearchBinding[],
): ProjectSearchBinding[] {
	const byMenu = menuServices(source);
	const ids = new Map<number, Set<Uuid>>();
	const uuids = new Map<Uuid, Set<number>>();
	for (const module of Object.values(doc.modules)) {
		const uuid = projectSearchOf(module)?.searchUuid;
		const id = byMenu.get(wire.moduleUniqueId(module.uuid));
		if (uuid === undefined || id === undefined) continue;
		const group = ids.get(id) ?? new Set<Uuid>();
		group.add(uuid);
		ids.set(id, group);
		const keys = uuids.get(uuid) ?? new Set<number>();
		keys.add(id);
		uuids.set(uuid, keys);
	}
	const bindings: ProjectSearchBinding[] = [];
	for (const [endpointId, owners] of ids) {
		const [searchUuid] = owners;
		if (owners.size === 1 && searchUuid && uuids.get(searchUuid)?.size === 1)
			bindings.push({ endpointId, searchUuid });
	}
	return [
		...bindings,
		...stored.filter(
			(binding) =>
				!ids.has(binding.endpointId) && !uuids.has(binding.searchUuid),
		),
	];
}

/** Keep a known service at its exact id. A change to an id with no known
 * owner can continue the logical search when both sides of the menu lineage
 * identify exactly one service. A split or convergence without an exact id
 * gives the new dependency its own identity. No labels participate. */
export function projectSearchLineage(
	known: readonly ProjectSearchBinding[],
	before: HqAppSource,
	after: HqAppSource,
): ProjectSearchBinding[] {
	const previously = menuServices(before);
	const current = menuServices(after);
	const offered = new Set(current.values());
	const owner = new Map(known.map((row) => [row.endpointId, row.searchUuid]));
	const nextIds = new Map<number, Set<number>>();
	const priorIds = new Map<number, Set<number>>();
	for (const [menu, id] of current) {
		const old = previously.get(menu);
		if (old === undefined) continue;
		const next = nextIds.get(old) ?? new Set<number>();
		const prior = priorIds.get(id) ?? new Set<number>();
		next.add(id);
		prior.add(old);
		nextIds.set(old, next);
		priorIds.set(id, prior);
	}
	const result = new Map<Uuid, number>(
		known.map((row) => [row.searchUuid, row.endpointId]),
	);
	for (const [id, priors] of priorIds) {
		if (owner.has(id) || priors.size !== 1) continue;
		const [old] = priors;
		const uuid = old === undefined ? undefined : owner.get(old);
		if (
			old !== undefined &&
			uuid &&
			!offered.has(old) &&
			nextIds.get(old)?.size === 1
		)
			result.set(uuid, id);
	}
	return Array.from(result, ([searchUuid, endpointId]) => ({
		searchUuid,
		endpointId,
	}));
}
