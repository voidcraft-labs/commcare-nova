/**
 * Test fixtures for the Project lookup catalog every commit verdict runs
 * under: rows-free table definitions and the `available` validation context
 * built over them. Shared by the SA/MCP workspace suites (`lib/agent`) and the
 * builder's gate suites (`lib/routing`, `lib/session`) so one fixture shape
 * describes a lookup table on every surface.
 */

import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { SelectOptionsSource } from "@/lib/domain";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupTableDefinition } from "@/lib/lookup/types";

/** A rows-free text-column table definition. */
export function lookupTableDefinition(args: {
	readonly id: LookupTableId;
	readonly name: string;
	readonly tag: string;
	readonly columns: readonly {
		readonly id: LookupColumnId;
		readonly wireName: string;
		readonly label: string;
	}[];
}): LookupTableDefinition {
	return {
		id: args.id,
		name: args.name,
		tag: args.tag,
		definitionRevision: parseLookupRevision("1"),
		columns: args.columns.map((column) => ({
			...column,
			dataType: "text" as const,
		})),
	};
}

/** The `available` lookup context a commit verdict resolves the given
 *  definitions through — what the builder holds once its catalog is ready and
 *  what a host's `lookupDefinitions` read produces. */
export function availableLookupContext(
	definitions: readonly LookupTableDefinition[],
	projectId = "project-test",
): LookupValidationContext {
	return {
		kind: "available",
		projectId,
		projectRevision: parseLookupRevision("1"),
		definitions,
	};
}

/** One ready-made table — `Destinations`, a `code` value column and a `name`
 *  label column — with the select source that binds to it, for suites whose
 *  subject is "a doc that carries a lookup reference" rather than the table. */
export const DESTINATIONS_LOOKUP = (() => {
	const tableId = lookupTableIdSchema.parse(
		"01912d68-783e-7000-8000-00000000a001",
	);
	const valueColumnId = lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c001",
	);
	const labelColumnId = lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c002",
	);
	const optionsSource: SelectOptionsSource = {
		kind: "lookup",
		tableId,
		valueColumnId,
		labelColumnId,
	};
	return {
		tableId,
		valueColumnId,
		labelColumnId,
		definition: lookupTableDefinition({
			id: tableId,
			name: "Destinations",
			tag: "destinations",
			columns: [
				{ id: valueColumnId, wireName: "code", label: "Code" },
				{ id: labelColumnId, wireName: "name", label: "Name" },
			],
		}),
		optionsSource,
	} as const;
})();
