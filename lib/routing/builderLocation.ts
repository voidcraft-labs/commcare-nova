/** Shared semantic snapshots of the URL against each live document store.
 * Multiple projections share one parse; scalar edits do not invalidate it. */
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { parsePathToLocation } from "./location";
import type { Location } from "./types";

export function createBuilderLocationSource(path: {
	getSegments(): string[];
	subscribe(callback: () => void): () => void;
}) {
	interface CachedBuilderLocation {
		readonly pathKey: string;
		readonly moduleOrder: BlueprintDoc["moduleOrder"];
		readonly formOrder: BlueprintDoc["formOrder"];
		readonly fieldOrder: BlueprintDoc["fieldOrder"];
		readonly location: Location;
	}

	/** One parsed location per Builder store/path/topology snapshot. Route
	 * projections are intentionally numerous; without this shared cache every
	 * subscriber independently scans `fieldOrder` to resolve the same selected
	 * field on one navigation. */
	const builderLocationCache = new WeakMap<
		BlueprintDocStore,
		CachedBuilderLocation
	>();

	function getSnapshot(docApi: BlueprintDocStore): Location {
		const segments = path.getSegments();
		const pathKey = segments.join("/");
		const doc = docApi.getState();
		const cached = builderLocationCache.get(docApi);
		if (
			cached !== undefined &&
			cached.pathKey === pathKey &&
			cached.moduleOrder === doc.moduleOrder &&
			cached.formOrder === doc.formOrder &&
			cached.fieldOrder === doc.fieldOrder
		) {
			return cached.location;
		}
		const location = parsePathToLocation(segments, doc);
		builderLocationCache.set(docApi, {
			pathKey,
			moduleOrder: doc.moduleOrder,
			formOrder: doc.formOrder,
			fieldOrder: doc.fieldOrder,
			location,
		});
		return location;
	}

	/** Location semantics depend on entity topology, not on field labels, values,
	 * case writes, or any other scalar document content. All structural mutations
	 * replace at least one of these three immutable collections. */
	function subscribe(
		docApi: BlueprintDocStore,
		onStoreChange: () => void,
	): () => void {
		const unsubscribePath = path.subscribe(onStoreChange);
		const unsubscribeDoc = docApi.subscribe(
			(doc) => [doc.moduleOrder, doc.formOrder, doc.fieldOrder] as const,
			onStoreChange,
			{
				equalityFn: (left, right) =>
					left[0] === right[0] && left[1] === right[1] && left[2] === right[2],
			},
		);
		return () => {
			unsubscribePath();
			unsubscribeDoc();
		};
	}

	return { getSnapshot, subscribe };
}

export function selectedModuleUuid(location: Location): Uuid | undefined {
	return "moduleUuid" in location ? location.moduleUuid : undefined;
}

export function selectedFormUuid(location: Location): Uuid | undefined {
	return location.kind === "form" ||
		location.kind === "form-condition" ||
		location.kind === "form-operations" ||
		location.kind === "form-links"
		? location.formUuid
		: undefined;
}

export function selectedFieldUuid(location: Location): Uuid | undefined {
	return location.kind === "form" ? location.selectedUuid : undefined;
}

export function locationKind(location: Location): Location["kind"] {
	return location.kind;
}

export function selectedProjectDataTableId(
	location: Location,
): LookupTableId | undefined {
	return location.kind === "project-data" ? location.tableId : undefined;
}

export function hasSelectedField(location: Location): boolean {
	return location.kind === "form" && location.selectedUuid !== undefined;
}

export function selectedFormOperationUuid(
	location: Location,
): Uuid | undefined {
	return location.kind === "form-operations"
		? location.operationUuid
		: undefined;
}

export function selectedFormLinkUuid(location: Location): Uuid | undefined {
	return location.kind === "form-links" ? location.linkUuid : undefined;
}
