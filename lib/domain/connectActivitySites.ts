import type { PersistableDoc } from "./blueprint";
import type { Expression } from "./expression/types";
import type {
	ConnectActivityField,
	ConnectRole,
} from "./fields/connectActivity";
import { ownRecordValue } from "./records";
import { submissionLayout } from "./submissionLayout";
import type { Uuid } from "./uuid";

/** A submitted activity uses its field id at its submitted place. The groups
 * enclosing that place control whether it contributes, and its enclosing
 * repeats how many occurrences can contribute to this submission: Core takes a
 * node's relevance and repetition from its data ancestors, which a submitted
 * placement can make other than the screen's (`submissionLayout`). */
export interface ConnectActivitySite {
	readonly field: ConnectActivityField;
	readonly path: readonly Uuid[];
	readonly guards: readonly Expression[];
	readonly repeats: readonly Uuid[];
}

export function connectActivitySites(
	doc: PersistableDoc,
	formUuid: Uuid,
): ConnectActivitySite[] {
	const sites: ConnectActivitySite[] = [];
	const path: Uuid[] = [];
	const guards: Expression[] = [];
	const repeats: Uuid[] = [];
	const { children } = submissionLayout(formUuid, doc.fields, doc.fieldOrder);
	const visit = (parent: Uuid) => {
		for (const uuid of children.get(parent) ?? []) {
			const field = ownRecordValue(doc.fields, uuid);
			if (field === undefined || path.includes(uuid)) continue;
			path.push(uuid);
			const guard = "relevant" in field ? field.relevant : undefined;
			if (guard !== undefined) guards.push(guard);
			if (field.kind === "connect_activity") {
				sites.push({
					field,
					path: [...path],
					guards: [...guards],
					repeats: [...repeats],
				});
			} else if (
				field.kind === "group" ||
				field.kind === "repeat" ||
				field.kind === "section"
			) {
				if (field.kind === "repeat") repeats.push(uuid);
				visit(uuid);
				if (field.kind === "repeat") repeats.pop();
			}
			if (guard !== undefined) guards.pop();
			path.pop();
		}
	};
	visit(formUuid);
	return sites;
}

const RECEIVER_NAMES: Record<ConnectRole, ReadonlySet<string>> = {
	learn: new Set(["module", "assessment"]),
	deliver: new Set(["deliver", "task", "work_area_update"]),
};

/** HQ forwards the ancestors of each Connect element. The receiver searches
 * those names at every depth and expects a Connect namespace on every match. */
export function connectForwardedAncestorPaths(
	doc: PersistableDoc,
	sites: readonly ConnectActivitySite[],
): ReadonlyMap<Uuid, readonly Uuid[]> {
	const conflicts = new Map<Uuid, readonly Uuid[]>();
	for (const { path } of sites) {
		for (const [index, uuid] of path.slice(0, -1).entries()) {
			const field = doc.fields[uuid];
			if (doc.connectRoles.some((role) => RECEIVER_NAMES[role].has(field.id)))
				conflicts.set(uuid, path.slice(0, index + 1));
		}
	}
	return conflicts;
}
