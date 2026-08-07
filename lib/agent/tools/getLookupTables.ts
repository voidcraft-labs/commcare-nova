import { z } from "zod";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupDataType } from "@/lib/lookup/types";
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";

export const getLookupTablesInputSchema = z.object({}).strict();
export type GetLookupTablesInput = z.infer<typeof getLookupTablesInputSchema>;

export type GetLookupTablesResult =
	| {
			readonly tables: readonly {
				readonly id: LookupTableId;
				readonly name: string;
				readonly tag: string;
				readonly columns: readonly {
					readonly id: LookupColumnId;
					readonly wireName: string;
					readonly label: string;
					readonly dataType: LookupDataType;
				}[];
			}[];
	  }
	| { readonly error: string };

/** Rows-free Project data catalog. UUIDs are identity; names, tags, labels,
 * and wire names are current readable/external projections. */
export const getLookupTablesTool = {
	description:
		"List this app Project's data tables and columns. Copy table and column uuids into lookup-backed fields and expressions; names, tags, labels, and wire names are metadata.",
	inputSchema: getLookupTablesInputSchema,
	async execute(
		_input: GetLookupTablesInput,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<GetLookupTablesResult>> {
		if (ctx.lookupCatalog === undefined) {
			return {
				kind: "read",
				data: { error: "Project data definitions are unavailable." },
			};
		}
		const catalog = await ctx.lookupCatalog();
		return {
			kind: "read",
			data: {
				tables: catalog.definitions.map((table) => ({
					id: table.id,
					name: table.name,
					tag: table.tag,
					columns: table.columns.map((column) => ({
						id: column.id,
						wireName: column.wireName,
						label: column.label,
						dataType: column.dataType,
					})),
				})),
			},
		};
	},
};
