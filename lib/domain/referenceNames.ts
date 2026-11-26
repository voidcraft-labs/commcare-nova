// Identity to current authored names, shared by prose and expression projections.
// This module holds no expression representation or wire vocabulary.

import { HASHTAG_SEGMENT_SOURCE } from "./hashtagSegments";
import { ownRecordValue, recordFromEntries } from "./records";

export interface ReferenceNames {
	/**
	 * The target field's current id path from its form root
	 * (e.g. `["grp", "age"]`), or `undefined` when the uuid doesn't
	 * resolve to a field reachable from a form.
	 */
	fieldPathSegments(uuid: string): readonly string[] | undefined;
	/** The custom worker-information property's current saved name. */
	userPropertySlug(uuid: string): string | undefined;
	/** The Search prompt's current name, wherever its module is. */
	searchInputName(uuid: string, supplier?: string): string | undefined;
}

/**
 * The doc surface printing needs — structural so both `BlueprintDoc`
 * and raw persisted records satisfy it without this module importing
 * the blueprint schema (the field schemas import THIS package; the
 * blueprint imports the field schemas).
 */
export interface ReferenceNamesDoc {
	fields: Record<
		string,
		{ id: string; submissionPlacement?: { parent: string } } | undefined
	>;
	forms: Record<string, unknown>;
	fieldOrder: Record<string, readonly string[] | undefined>;
	userProperties?: Record<string, { slug: string } | undefined>;
	/** Modules, for the Search prompts a `search-answer-ref` names. */
	modules?: Record<
		string,
		| {
				id?: string;
				caseListConfig?: {
					searchInputs: readonly { uuid: string; name: string }[];
				};
		  }
		| undefined
	>;
	/** The maintained reverse index when present (in-memory docs);
	 *  printing derives its own from `fieldOrder` when absent. */
	fieldParent?: Record<string, string | null | undefined>;
}

const authoredSegment = new RegExp(`^${HASHTAG_SEGMENT_SOURCE}$`);

/** A menu's own id is the friendly address when unique. Its UUID gives duplicate
 * or imported ids a stable address in the same expression grammar. */
export function searchSupplierAddresses(modules: ReferenceNamesDoc["modules"]) {
	const entries = Object.entries(modules ?? {});
	const counts = new Map<string, number>();
	for (const [, menu] of entries) {
		if (menu?.id) counts.set(menu.id, (counts.get(menu.id) ?? 0) + 1);
	}
	return new Map(
		entries.map(([uuid, menu]) => {
			const id = menu?.id;
			return [
				uuid,
				id &&
				authoredSegment.test(id) &&
				counts.get(id) === 1 &&
				(id === uuid || !Object.hasOwn(modules ?? {}, id))
					? id
					: uuid,
			] as const;
		}),
	);
}

export function referenceNames(doc: ReferenceNamesDoc): ReferenceNames {
	let derivedParents: Record<string, string> | undefined;
	let searchMenus: ReturnType<typeof searchSupplierAddresses> | undefined;
	const parentOf = (uuid: string): string | undefined => {
		const placed = ownRecordValue(doc.fields, uuid)?.submissionPlacement;
		if (placed !== undefined) return placed.parent;
		const maintained = ownRecordValue(doc.fieldParent, uuid);
		if (typeof maintained === "string") return maintained;
		if (doc.fieldParent !== undefined && maintained !== undefined) {
			return undefined;
		}
		// Read-only widenings (compile, upload, preview) may carry no
		// fieldParent — derive a reverse map from fieldOrder once.
		if (derivedParents === undefined) {
			derivedParents = recordFromEntries([]);
			for (const [parent, children] of Object.entries(doc.fieldOrder)) {
				for (const child of children ?? []) derivedParents[child] = parent;
			}
		}
		return ownRecordValue(derivedParents, uuid);
	};

	const cache = new Map<string, readonly string[] | undefined>();
	return {
		fieldPathSegments(uuid) {
			const cached = cache.get(uuid);
			if (cached !== undefined || cache.has(uuid)) return cached;
			const segments: string[] = [];
			let result: readonly string[] | undefined;
			let cursor: string | undefined = uuid;
			const seen = new Set<string>();
			while (cursor !== undefined && !seen.has(cursor)) {
				const field = ownRecordValue(doc.fields, cursor);
				if (!field) break;
				seen.add(cursor);
				segments.unshift(field.id);
				const parent = parentOf(cursor);
				if (
					parent !== undefined &&
					ownRecordValue(doc.forms, parent) !== undefined
				) {
					result = segments;
					break;
				}
				cursor = parent;
			}
			cache.set(uuid, result);
			return result;
		},
		userPropertySlug(uuid) {
			return ownRecordValue(doc.userProperties, uuid)?.slug;
		},
		searchInputName(uuid, supplier) {
			if (supplier !== undefined) {
				const mod = ownRecordValue(doc.modules, supplier);
				const input = mod?.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === uuid,
				);
				searchMenus ??= searchSupplierAddresses(doc.modules);
				return input ? `${searchMenus.get(supplier)}/${input.name}` : undefined;
			}
			for (const mod of Object.values(doc.modules ?? {})) {
				const input = mod?.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === uuid,
				);
				if (input !== undefined) return input.name;
			}
			return undefined;
		},
	};
}
