import "server-only";

import { sql } from "kysely";
import { type DesignId, designIdSchema } from "@/lib/agent/design/ids";
import {
	type DesignLookupBinding,
	designLookupMaterializationPayloadSchema,
} from "@/lib/agent/design/lookupMaterializationTypes";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { getAppDb } from "@/lib/db/pg";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	ChangeSetIntegrityError,
	ChangeSetStagingRejectedError,
} from "./errors";
import type { DesignChangeSet } from "./types";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function hasExactly(value: JsonRecord, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function bindingKey(kind: DesignLookupBinding["kind"], id: string): string {
	return `${kind}:${id}`;
}

/** Resolve accepted lookup references while composing the execution brief.
 * Shared tool reads and writes then use the actual Project identities. */
export class DesignLookupReferenceResolver {
	private readonly lookupIdByDesign = new Map<string, string>();
	private readonly boundLookupIds = new Set<string>();

	constructor(bindings: readonly DesignLookupBinding[]) {
		const seenDesignIds = new Set<DesignId>();
		for (const binding of bindings) {
			const designKey = bindingKey(binding.kind, binding.designId);
			const lookupKey = bindingKey(binding.kind, binding.lookupId);
			if (
				seenDesignIds.has(binding.designId) ||
				this.lookupIdByDesign.has(designKey) ||
				this.boundLookupIds.has(lookupKey)
			) {
				throw new ChangeSetIntegrityError(
					"The accepted lookup materialization contains duplicate identity bindings.",
				);
			}
			seenDesignIds.add(binding.designId);
			this.lookupIdByDesign.set(designKey, binding.lookupId);
			this.boundLookupIds.add(lookupKey);
		}
	}

	private requireBinding(
		kind: "lookup-table" | "lookup-column",
		value: unknown,
	): string {
		const designId = designIdSchema.safeParse(value);
		if (!designId.success) {
			throw new ChangeSetStagingRejectedError(
				"TOOL_INPUT_INVALID",
				"An accepted designed lookup reference has an invalid semantic identity.",
			);
		}
		const lookupId = this.lookupIdByDesign.get(bindingKey(kind, designId.data));
		if (lookupId === undefined) {
			throw new ChangeSetStagingRejectedError(
				"TOOL_INPUT_INVALID",
				"An accepted designed lookup reference is not present in this design's materialization receipt.",
			);
		}
		return lookupId;
	}

	resolveInput(value: unknown): unknown {
		const walk = (member: unknown): unknown => {
			if (Array.isArray(member)) return member.map(walk);
			const object = record(member);
			if (object === null) return member;
			if (
				object.kind === "designed-project-lookup" &&
				hasExactly(object, [
					"kind",
					"tableId",
					"valueColumnId",
					"labelColumnId",
				])
			) {
				return {
					kind: "lookup",
					tableId: lookupTableIdSchema.parse(
						this.requireBinding("lookup-table", object.tableId),
					),
					valueColumnId: lookupColumnIdSchema.parse(
						this.requireBinding("lookup-column", object.valueColumnId),
					),
					labelColumnId: lookupColumnIdSchema.parse(
						this.requireBinding("lookup-column", object.labelColumnId),
					),
				};
			}
			if (
				object.kind === "existing-project-lookup" &&
				hasExactly(object, [
					"kind",
					"tableId",
					"valueColumnId",
					"labelColumnId",
				])
			) {
				const tableId = lookupTableIdSchema.safeParse(object.tableId);
				const valueColumnId = lookupColumnIdSchema.safeParse(
					object.valueColumnId,
				);
				const labelColumnId = lookupColumnIdSchema.safeParse(
					object.labelColumnId,
				);
				if (
					!tableId.success ||
					!valueColumnId.success ||
					!labelColumnId.success
				) {
					throw new ChangeSetStagingRejectedError(
						"TOOL_INPUT_INVALID",
						"An existing Project lookup reference must use the stable table and column identities returned by the catalog.",
					);
				}
				return {
					kind: "lookup",
					tableId: tableId.data,
					valueColumnId: valueColumnId.data,
					labelColumnId: labelColumnId.data,
				};
			}
			return Object.fromEntries(
				Object.entries(object).map(([key, nested]) => [key, walk(nested)]),
			);
		};
		return walk(value);
	}
}

/** Load only from the immutable receipt bound to this exact change-set
 * lineage. No caller or model may supply a mapping. */
export async function loadDesignLookupReferenceResolver(
	changeSet: DesignChangeSet,
): Promise<DesignLookupReferenceResolver> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_lookup_materializations")
		.select([
			"design_session_id",
			"design_revision_id",
			"design_revision_digest",
			"project_id",
			"result_digest",
		])
		.select(
			sql<string>`${sql.ref("design_lookup_materializations.mapping")}::text`.as(
				"mapping_text",
			),
		)
		.where("design_revision_id", "=", changeSet.designRevisionId)
		.executeTakeFirst();
	if (row === undefined) return new DesignLookupReferenceResolver([]);
	if (
		row.design_session_id !== changeSet.designSessionId ||
		row.design_revision_id !== changeSet.designRevisionId ||
		row.design_revision_digest !== changeSet.designRevisionDigest ||
		row.project_id !== changeSet.baseProjectId
	) {
		throw new ChangeSetIntegrityError(
			"The accepted lookup materialization does not match this change set's exact design lineage.",
		);
	}
	const payload = designLookupMaterializationPayloadSchema.parse(
		parsePersistedJsonText(
			row.mapping_text,
			`design_lookup_materializations.mapping for change set ${changeSet.id}`,
		),
	);
	if (
		payload.designRevisionId !== changeSet.designRevisionId ||
		payload.designRevisionDigest !== changeSet.designRevisionDigest ||
		payload.projectId !== changeSet.baseProjectId ||
		canonicalJsonDigest(payload) !== row.result_digest
	) {
		throw new ChangeSetIntegrityError(
			"The accepted lookup materialization payload does not match its lineage or result digest.",
		);
	}
	return new DesignLookupReferenceResolver(payload.bindings);
}
