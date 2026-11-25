import type { PersistableDoc } from "./blueprint";
import type { Expression } from "./expression/types";
import type { ConnectActivityField } from "./fields/connectActivity";
import { ownRecordValue } from "./records";
import type { Uuid } from "./uuid";

/** A submitted activity uses its field id at its authored position. Its
 * enclosing groups control whether it contributes, and its enclosing repeats
 * control how many occurrences can contribute to this submission. */
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
	const visit = (parent: Uuid) => {
		for (const uuid of ownRecordValue(doc.fieldOrder, parent) ?? []) {
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
