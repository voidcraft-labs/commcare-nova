import type { LookupColumnId, LookupMemberId } from "@/lib/domain/lookupIds";
import type {
	LookupValueReadRequest,
	LookupValueSlot,
} from "@/lib/lookup/largeValues/input";
import type {
	LookupRevision,
	LookupRowPatch,
	LookupRowsPage,
} from "@/lib/lookup/types";
import type { RowDraftCell } from "./projectDataModel";

export type LargeRowEdit =
	| {
			kind: "patch";
			fieldId: string;
			title: string;
			revision: LookupRevision;
			change: LookupRowPatch;
			cell?: RowDraftCell;
	  }
	| {
			kind: "slice";
			fieldId: string;
			title: string;
			target: LookupValueReadRequest;
			initialOffset: number;
			text?: string;
			file?: File;
			whole?: boolean;
			operationId?: string;
			upload?: {
				baseDigest: string;
				startByte: number;
				endByte: number;
				replacement: Blob;
			};
	  };

export type DisplayPart =
	| { kind: "count"; count: number }
	| {
			kind: "value";
			slot: LookupValueSlot;
			value: string | number;
			byteOffset: number;
			totalBytes?: number;
	  };

/** Turn the two supported row-page shapes into the same identity-bearing
 * coordinates. An empty list is a count. A missing value has no part. */
export function displayedParts(
	row: LookupRowsPage["rows"][number],
): DisplayPart[] {
	if (row.parts)
		return row.parts.map((part) => {
			if (part.kind === "occurrences")
				return { kind: "count", count: part.count };
			if (part.kind === "number")
				return {
					kind: "value",
					slot: { kind: "cell", columnId: part.columnId },
					value: part.value,
					byteOffset: 0,
				};
			const {
				text,
				offset: _offset,
				byteOffset,
				totalBytes,
				valueDigest: _digest,
				...slot
			} = part;
			return { kind: "value", slot, value: text, byteOffset, totalBytes };
		});
	const parts: DisplayPart[] = row.cells.map(({ columnId, value }) => ({
		kind: "value",
		slot: { kind: "cell", columnId },
		value,
		byteOffset: 0,
	}));
	for (const [id, value] of Object.entries(row.attributes ?? {}))
		if (value !== undefined)
			parts.push({
				kind: "value",
				slot: { kind: "attribute", attributeId: id as LookupMemberId },
				value,
				byteOffset: 0,
			});
	for (const [id, list] of Object.entries(row.occurrences ?? {})) {
		if (!list) continue;
		const columnId = id as LookupColumnId;
		parts.push({ kind: "count", count: list.length });
		for (const [index, item] of list.entries()) {
			parts.push({
				kind: "value",
				slot: { kind: "occurrence", columnId, index },
				value: item.text,
				byteOffset: 0,
			});
			for (const [id, value] of Object.entries(item.properties))
				if (value !== undefined)
					parts.push({
						kind: "value",
						slot: {
							kind: "property",
							columnId,
							index,
							propertyId: id as LookupMemberId,
						},
						value,
						byteOffset: 0,
					});
		}
	}
	return parts;
}

/** Textarea positions use UTF-16. Compare whole Unicode code points before
 * converting just the changed span to storage byte offsets. */
export function changedLookupText(
	before: string,
	after: string,
	byteOffset: number,
) {
	const old = Array.from(before),
		next = Array.from(after);
	let start = 0,
		endOld = old.length,
		endNew = next.length;
	while (start < endOld && start < endNew && old[start] === next[start])
		start++;
	while (
		endOld > start &&
		endNew > start &&
		old[endOld - 1] === next[endNew - 1]
	) {
		endOld--;
		endNew--;
	}
	const utf8 = new TextEncoder();
	const startByte =
		byteOffset + utf8.encode(old.slice(0, start).join("")).length;
	return {
		startByte,
		endByte: startByte + utf8.encode(old.slice(start, endOld).join("")).length,
		replacement: next.slice(start, endNew).join(""),
	};
}
