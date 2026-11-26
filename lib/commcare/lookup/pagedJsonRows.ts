import { HQ_LOOKUP_DEFINITION_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import {
	lookupRowJsonBody,
	lookupTableJsonBody,
} from "@/lib/commcare/hq/lookupJson";
import type {
	ArchiveRow,
	StreamingLookupTable,
} from "@/lib/lookup/archiveRows";
import { slotFromStoragePath } from "@/lib/lookup/fixtureValues";
import { lookupRowContentSchema } from "@/lib/lookup/schema";
import { xmlTextIssue } from "../xmlText";
import { MAX_LOOKUP_FIXTURE_BYTES, MAX_LOOKUP_FIXTURE_ROWS } from "./fixtures";
import {
	type LookupJsonRowContent,
	lookupJsonDefinition,
	lookupJsonRowContent,
} from "./jsonRows";
import type { LookupTableWireNaming } from "./naming";
import {
	LOOKUP_RUNTIME_STRING_LIMIT_LINE,
	lookupRuntimeStringTooLong,
} from "./runtimeStrings";

export interface PagedLookupJsonRow {
	readonly novaRowId: string;
	readonly content: LookupJsonRowContent;
}

/** Separate from the workbook threshold. Limit a direct publish's temporary
 * row bodies to the existing bounded fixture workspace. */
export const PAGED_LOOKUP_JSON_ROWS = MAX_LOOKUP_FIXTURE_ROWS;
export const PAGED_LOOKUP_JSON_BYTES = MAX_LOOKUP_FIXTURE_BYTES;

const OVER_BUDGET =
	"The lookup table exceeds the temporary workspace for sending its rows individually.";

async function restoreRow(input: ArchiveRow, budget: number) {
	const row = {
		id: input.row.id,
		values: { ...input.row.values },
		...lookupRowContentSchema.parse({
			attributes: input.row.attributes,
			occurrences: input.row.occurrences,
		}),
	};
	for (const [path, meta] of input.external) {
		if (meta.bytes > budget) return null;
		const slot = slotFromStoragePath(JSON.parse(path));
		const stream = input.read({ slot });
		if (!stream)
			throw new Error(
				"A lookup value lost its source during publish preparation.",
			);
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		const parts: string[] = [];
		let seen = 0;
		for await (const bytes of stream) {
			seen += bytes.byteLength;
			if (seen > meta.bytes)
				throw new Error("The lookup value changed while Nova read it.");
			parts.push(decoder.decode(bytes, { stream: true }));
		}
		if (seen !== meta.bytes)
			throw new Error("The lookup value changed while Nova read it.");
		parts.push(decoder.decode());
		const value = parts.join("");
		budget -= seen;
		if (slot.kind === "cell") row.values[slot.columnId] = value;
		else if (slot.kind === "attribute" && row.attributes)
			row.attributes[slot.attributeId] = value;
		else if (slot.kind === "occurrence" || slot.kind === "property") {
			const item = row.occurrences?.[slot.columnId]?.[slot.index];
			if (!item)
				throw new Error(
					"A lookup occurrence lost its source during publish preparation.",
				);
			if (slot.kind === "occurrence") item.text = value;
			else item.properties[slot.propertyId] = value;
		} else
			throw new Error(
				"A lookup row detail lost its source during publish preparation.",
			);
	}
	return row;
}

/** Consume the complete authorized revision in order. The one request body
 * calculation includes JSON escaping, repeated properties, and the largest
 * native rank. On overflow the iteration stops before opening later pages. */
export async function stagePagedLookupJson(
	table: StreamingLookupTable,
	naming: LookupTableWireNaming,
	budget: { readonly rows: number; readonly bytes: number },
): Promise<
	| { readonly rows: readonly PagedLookupJsonRow[]; readonly bytes: number }
	| {
			readonly issue: string;
			readonly excess?: "workspace" | "definition";
			problem?: "runtime-value-length";
	  }
> {
	if (table.count > budget.rows)
		return { issue: OVER_BUDGET, excess: "workspace" };
	const rows: PagedLookupJsonRow[] = [];
	let bytes = Buffer.byteLength(
		JSON.stringify(lookupTableJsonBody(lookupJsonDefinition(naming))),
	);
	const requestIssue = {
		issue:
			"The lookup table definition is too large to verify from CommCare HQ.",
		excess: "definition" as const,
	};
	if (bytes > HQ_LOOKUP_DEFINITION_MAX_BYTES) return requestIssue;
	if (bytes > budget.bytes) return { issue: OVER_BUDGET, excess: "workspace" };
	for await (const input of table.reader.rows()) {
		const remaining = budget.bytes - bytes;
		const row = await restoreRow(input, remaining);
		if (!row) return { issue: OVER_BUDGET, excess: "workspace" };
		const content = lookupJsonRowContent(naming, row);
		const values = [
			...Object.values(content.itemAttributes),
			...Object.values(content.fields).flatMap((field) =>
				field.flatMap((item) => [
					item.value,
					...Object.values(item.properties),
				]),
			),
		];
		if (values.some((value) => xmlTextIssue(value)))
			return {
				issue:
					"A lookup value contains a character that cannot be installed on a worker’s phone.",
			};
		if (values.some(lookupRuntimeStringTooLong))
			return {
				issue: LOOKUP_RUNTIME_STRING_LIMIT_LINE,
				problem: "runtime-value-length",
			};

		const rowBytes = Buffer.byteLength(
			JSON.stringify(
				lookupRowJsonBody("0".repeat(32), {
					...content,
					sortKey: 2_147_483_647,
				}),
			),
		);
		bytes += rowBytes;
		if (bytes > budget.bytes)
			return { issue: OVER_BUDGET, excess: "workspace" };
		rows.push({ novaRowId: row.id, content });
	}
	if (rows.length !== table.count)
		throw new Error("The lookup table changed while Nova prepared its rows.");
	return { rows, bytes };
}
