/**
 * Shared classifier and compare-and-set writer for the historical ordinary
 * extension-edge repair. `case_indices` has no source column: a `parent` edge
 * may come from a case type's ordinary child action or from an advanced case
 * operation whose authored relationship must win. Only receipt-proven ordinary
 * rows with no later operation touch or ancestry-catalog change are writable.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import type { Database } from "../../lib/case-store/postgres/connection";
import { parseSubmissionEnvelopeResult } from "../../lib/case-store/submission";
import type { AppDatabase } from "../../lib/db/pg";
import type { PersistableDoc } from "../../lib/domain";
import { loadPersistedBlueprintReadOnly } from "./loadPersistedBlueprint";

export type CaseParentRelationshipStanding =
	| "clean"
	| "repairable-ordinary"
	| "operation-touched"
	| "catalog-changed"
	| "unknown-origin"
	| "noncanonical-topology";

export interface CaseParentRelationshipFinding {
	readonly caseId: string;
	readonly caseType: string;
	readonly parentType: string;
	readonly parentCaseId: string;
	readonly standing: CaseParentRelationshipStanding;
	readonly detail: string;
}

export interface CaseParentRelationshipAppSnapshot {
	readonly appId: string;
	readonly appName: string;
	readonly projectId: string;
	readonly findings: readonly CaseParentRelationshipFinding[];
}

interface RelationshipRow {
	readonly case_id: string;
	readonly case_type: string;
	readonly parent_case_id: string;
	readonly ancestor_id: string | null;
	readonly relationship: string | null;
	readonly depth: number | null;
	readonly parent_type: string | null;
}

interface ReceiptProvenance {
	readonly appMutationSeq: bigint;
}

function decodeMutationArray(
	value: unknown,
): readonly Record<string, unknown>[] {
	const parsed =
		typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	if (!Array.isArray(parsed)) {
		throw new Error(
			"An app_changes row contains a non-array mutations payload.",
		);
	}
	return parsed.map((mutation) => {
		if (typeof mutation !== "object" || mutation === null) {
			throw new Error("An app_changes row contains a non-object mutation.");
		}
		return mutation as Record<string, unknown>;
	});
}

function changesAncestry(
	mutation: Readonly<Record<string, unknown>>,
	caseType: string,
): boolean {
	// `setCaseTypes` was the historical whole-catalog mutation. Permanent
	// app_changes rows can still contain it even though current writers only
	// emit granular catalog mutations. Because replacing the whole catalog
	// could have changed any current type's ancestry, every later occurrence is
	// conservatively ambiguous for every current extension type.
	if (mutation.kind === "setCaseTypes") return true;
	if (mutation.caseType !== caseType) return false;
	if (
		mutation.kind === "declareCaseType" ||
		mutation.kind === "retireCaseType"
	) {
		return true;
	}
	return (
		mutation.kind === "setCaseTypeMeta" &&
		(Object.hasOwn(mutation, "parent_type") ||
			Object.hasOwn(mutation, "relationship"))
	);
}

function topologyFinding(
	rows: readonly RelationshipRow[],
	parentType: string,
): CaseParentRelationshipFinding | undefined {
	const first = rows[0];
	if (first === undefined) return undefined;
	if (rows.length !== 1) {
		return {
			caseId: first.case_id,
			caseType: first.case_type,
			parentType,
			parentCaseId: first.parent_case_id,
			standing: "noncanonical-topology",
			detail: `expected one parent edge; found ${rows.length}`,
		};
	}
	if (
		first.ancestor_id !== first.parent_case_id ||
		first.depth !== 1 ||
		first.parent_type !== parentType ||
		(first.relationship !== "child" && first.relationship !== "extension")
	) {
		return {
			caseId: first.case_id,
			caseType: first.case_type,
			parentType,
			parentCaseId: first.parent_case_id,
			standing: "noncanonical-topology",
			detail:
				"the edge target, depth, relationship, or same-tenant parent type is noncanonical",
		};
	}
	return undefined;
}

export async function findCaseParentRelationshipFindings(
	db: Kysely<Database>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly blueprint: PersistableDoc;
	},
): Promise<readonly CaseParentRelationshipFinding[]> {
	const extensionTypes = new Map(
		(args.blueprint.caseTypes ?? [])
			.filter(
				(caseType) =>
					caseType.relationship === "extension" &&
					caseType.parent_type !== undefined,
			)
			.map((caseType) => [caseType.name, caseType.parent_type as string]),
	);
	if (extensionTypes.size === 0) return [];

	const relationshipRows = (await db
		.selectFrom("cases as child")
		.leftJoin("case_indices as edge", (join) =>
			join
				.onRef("edge.case_id", "=", "child.case_id")
				.on("edge.identifier", "=", "parent"),
		)
		.leftJoin("cases as parent", (join) =>
			join
				.onRef("parent.case_id", "=", "edge.ancestor_id")
				.onRef("parent.app_id", "=", "child.app_id")
				.onRef("parent.project_id", "=", "child.project_id"),
		)
		.select([
			"child.case_id",
			"child.case_type",
			"child.parent_case_id",
			"edge.ancestor_id",
			"edge.relationship",
			"edge.depth",
			"parent.case_type as parent_type",
		])
		.where("child.app_id", "=", args.appId)
		.where("child.project_id", "=", args.projectId)
		.where("child.case_type", "in", [...extensionTypes.keys()])
		.where("child.parent_case_id", "is not", null)
		.orderBy("child.case_id")
		.orderBy("edge.ancestor_id")
		.execute()) as RelationshipRow[];

	const receiptRows = await db
		.selectFrom("form_submission_intents")
		.select(["result", "app_mutation_seq"])
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("result", "is not", null)
		.execute();
	const ordinaryOrigin = new Map<string, ReceiptProvenance>();
	const operationTouches = new Set<string>();
	for (const receipt of receiptRows) {
		const result = parseSubmissionEnvelopeResult(receipt.result);
		const ordinaryChildCaseIds = [
			...result.createdChildren.map((child) => child.caseId),
			...(result.legacyChildCaseIds ?? []),
		];
		for (const caseId of ordinaryChildCaseIds) {
			const mutationSeq = BigInt(receipt.app_mutation_seq);
			const prior = ordinaryOrigin.get(caseId);
			if (prior === undefined || mutationSeq < prior.appMutationSeq) {
				ordinaryOrigin.set(caseId, {
					appMutationSeq: mutationSeq,
				});
			}
		}
		for (const operation of result.operations) {
			if (!operation.executed) continue;
			operationTouches.add(operation.caseId);
		}
	}

	const changeRows = await sql<{ seq: string; mutations: unknown }>`
		SELECT seq, mutations
		FROM app_changes
		WHERE app_id = ${args.appId}
		ORDER BY seq
	`.execute(db);
	const ancestryChangesByType = new Map<string, bigint[]>();
	for (const change of changeRows.rows) {
		for (const mutation of decodeMutationArray(change.mutations)) {
			for (const caseType of extensionTypes.keys()) {
				if (!changesAncestry(mutation, caseType)) continue;
				const sequences = ancestryChangesByType.get(caseType) ?? [];
				sequences.push(BigInt(change.seq));
				ancestryChangesByType.set(caseType, sequences);
			}
		}
	}

	const grouped = new Map<string, RelationshipRow[]>();
	for (const row of relationshipRows) {
		const rows = grouped.get(row.case_id) ?? [];
		rows.push(row);
		grouped.set(row.case_id, rows);
	}

	const findings: CaseParentRelationshipFinding[] = [];
	for (const rows of grouped.values()) {
		const first = rows[0];
		if (first === undefined) continue;
		const parentType = extensionTypes.get(first.case_type);
		if (parentType === undefined) continue;
		const topology = topologyFinding(rows, parentType);
		if (topology !== undefined) {
			findings.push(topology);
			continue;
		}
		if (first.relationship === "extension") {
			findings.push({
				caseId: first.case_id,
				caseType: first.case_type,
				parentType,
				parentCaseId: first.parent_case_id,
				standing: "clean",
				detail: "the canonical extension edge is already stored",
			});
			continue;
		}
		const origin = ordinaryOrigin.get(first.case_id);
		if (origin === undefined) {
			findings.push({
				caseId: first.case_id,
				caseType: first.case_type,
				parentType,
				parentCaseId: first.parent_case_id,
				standing: "unknown-origin",
				detail:
					"no completed submission receipt proves an ordinary child write",
			});
			continue;
		}
		if (operationTouches.has(first.case_id)) {
			findings.push({
				caseId: first.case_id,
				caseType: first.case_type,
				parentType,
				parentCaseId: first.parent_case_id,
				standing: "operation-touched",
				detail:
					"an executed advanced operation touched the case, so receipt provenance cannot prove the current relationship",
			});
			continue;
		}
		if (
			(ancestryChangesByType.get(first.case_type) ?? []).some(
				(sequence) => sequence > origin.appMutationSeq,
			)
		) {
			findings.push({
				caseId: first.case_id,
				caseType: first.case_type,
				parentType,
				parentCaseId: first.parent_case_id,
				standing: "catalog-changed",
				detail:
					"the case type ancestry declaration or historical whole-catalog replacement changed after the ordinary child receipt",
			});
			continue;
		}
		findings.push({
			caseId: first.case_id,
			caseType: first.case_type,
			parentType,
			parentCaseId: first.parent_case_id,
			standing: "repairable-ordinary",
			detail:
				"a completed ordinary child receipt proves the stale relationship and no later ambiguity exists",
		});
	}
	return findings;
}

/**
 * Reload the app placement and classify its rows from one caller-owned
 * REPEATABLE READ snapshot. App enumeration is only a work list: an app may
 * move Projects before this snapshot begins, so no metadata from that earlier
 * query is accepted here.
 */
export async function classifyCaseParentRelationshipsInSnapshot(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<CaseParentRelationshipAppSnapshot | null> {
	const app = await tx
		.selectFrom("apps")
		.select(["id", "app_name", "project_id"])
		.where("id", "=", appId)
		.executeTakeFirst();
	if (app === undefined) return null;

	const blueprint = await loadPersistedBlueprintReadOnly(tx, app.id);
	if (blueprint === null) {
		throw new Error(
			`App ${app.id} disappeared inside a repeatable-read relationship-repair snapshot.`,
		);
	}
	const findings = await findCaseParentRelationshipFindings(
		tx as unknown as Transaction<Database>,
		{
			appId: app.id,
			projectId: app.project_id,
			blueprint,
		},
	);
	return {
		appId: app.id,
		appName: app.app_name,
		projectId: app.project_id,
		findings,
	};
}

export async function repairCaseParentRelationships(
	db: Kysely<Database>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly caseType: string;
		readonly parentType: string;
		readonly caseIds: readonly string[];
	},
): Promise<readonly string[]> {
	if (args.caseIds.length === 0) return [];
	const result = await sql<{ case_id: string }>`
		UPDATE case_indices AS edge
		SET relationship = 'extension'
		FROM cases AS child
		JOIN cases AS parent
		  ON parent.case_id = child.parent_case_id
		 AND parent.app_id = child.app_id
		 AND parent.project_id = child.project_id
		WHERE edge.case_id = child.case_id
		  AND edge.ancestor_id = child.parent_case_id
		  AND edge.identifier = 'parent'
		  AND edge.depth = 1
		  AND edge.relationship = 'child'
		  AND child.app_id = ${args.appId}
		  AND child.project_id = ${args.projectId}
		  AND child.case_type = ${args.caseType}
		  AND parent.case_type = ${args.parentType}
		  AND edge.case_id = ANY(${sql.val(args.caseIds)}::text[])
		RETURNING edge.case_id
	`.execute(db);
	return result.rows.map((row) => row.case_id).toSorted();
}
