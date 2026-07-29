/**
 * Closed in-memory forensic repair for the exact reviewed production defects.
 *
 * It accepts the complete all-app snapshot, verifies every manifest source,
 * applies the two property projections + 42 deletions + three expression
 * repairs, and requires the ordinary frozen scanner to become clean. The SQL
 * writer persists this result and its repair horizons in one transaction.
 */

import { frozenEntityOccurrencesFor } from "./frozenOccurrenceManifest";
import {
	CANONICAL_IDENTITY_AFFECTED_APPS,
	CANONICAL_IDENTITY_CATALOG_CLEARS,
	CANONICAL_IDENTITY_LABEL_REPAIR,
	CANONICAL_IDENTITY_PROPERTY_PROJECTIONS,
	CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST,
	CANONICAL_IDENTITY_REPAIR_VERSION,
	CANONICAL_IDENTITY_ROW_DELETES,
} from "./frozenRepairManifest";
import {
	canonicalIdentityDigest,
	type LegacyAppSnapshot,
	type LegacyEntityRow,
	planCanonicalAppMigration,
} from "./frozenTransform";

const HASHTAG = /#([A-Za-z_][A-Za-z0-9_-]*)(\/[A-Za-z_][A-Za-z0-9_-]*)+/g;

type JsonRecord = Record<string, unknown>;
type MutableLegacyAppSnapshot = Omit<LegacyAppSnapshot, "rows"> & {
	rows: LegacyEntityRow[];
};

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition)
		throw new Error(`Canonical identity repair blocked: ${message}`);
}

function locateField(
	fieldUuid: string,
	rowsByUuid: ReadonlyMap<string, LegacyEntityRow>,
): { readonly formUuid?: string; readonly path: readonly string[] } {
	const path: string[] = [];
	const visited = new Set<string>();
	let current = rowsByUuid.get(fieldUuid);
	while (current?.kind === "field" && !visited.has(current.uuid)) {
		visited.add(current.uuid);
		if (typeof current.data.id === "string") path.unshift(current.data.id);
		if (current.parentUuid === null) return { path };
		const parent = rowsByUuid.get(current.parentUuid);
		if (parent?.kind === "form") return { formUuid: parent.uuid, path };
		current = parent;
	}
	return { path };
}

function deriveLabelReplacement(
	source: string,
	owner: LegacyEntityRow,
	rows: readonly LegacyEntityRow[],
): {
	readonly replacement: { readonly parts: readonly JsonRecord[] };
	readonly targetUuids: readonly string[];
	readonly clearedTokenIndex: number;
} {
	const rowsByUuid = new Map(rows.map((row) => [row.uuid, row] as const));
	const ownerForm = locateField(owner.uuid, rowsByUuid).formUuid;
	invariant(
		ownerForm !== undefined,
		"label repair owner is no longer in a form",
	);
	const fieldsByPath = new Map<string, string[]>();
	for (const row of rows) {
		if (row.kind !== "field") continue;
		const located = locateField(row.uuid, rowsByUuid);
		if (located.formUuid !== ownerForm) continue;
		const key = located.path.join("/");
		const matches = fieldsByPath.get(key) ?? [];
		matches.push(row.uuid);
		fieldsByPath.set(key, matches);
	}

	const parts: JsonRecord[] = [];
	const targetUuids: string[] = [];
	let clearedTokenIndex: number | undefined;
	let cursor = 0;
	let tokenIndex = 0;
	const appendText = (text: string): void => {
		if (text.length === 0) return;
		const previous = parts.at(-1);
		if (previous?.kind === "text" && typeof previous.text === "string") {
			previous.text += text;
		} else {
			parts.push({ kind: "text", text });
		}
	};

	for (const match of source.matchAll(HASHTAG)) {
		const start = match.index;
		invariant(start !== undefined, "label token has no source offset");
		appendText(source.slice(cursor, start));
		const token = match[0];
		const [namespace, ...segments] = token.slice(1).split("/");
		const matches =
			namespace === "form" ? (fieldsByPath.get(segments.join("/")) ?? []) : [];
		if (matches.length === 1) {
			const uuid = matches[0];
			invariant(uuid !== undefined, "exact label target disappeared");
			parts.push({ kind: "field-ref", uuid });
			targetUuids.push(uuid);
		} else {
			invariant(
				matches.length === 0 && clearedTokenIndex === undefined,
				"label repair target became ambiguous or gained a second miss",
			);
			clearedTokenIndex = tokenIndex;
		}
		cursor = start + token.length;
		tokenIndex++;
	}
	appendText(source.slice(cursor));
	invariant(
		tokenIndex === 6 &&
			targetUuids.length === 5 &&
			new Set(targetUuids).size === 5 &&
			clearedTokenIndex !== undefined,
		"label no longer has the reviewed five-target/one-clear shape",
	);
	return { replacement: { parts }, targetUuids, clearedTokenIndex };
}

function snapshotDigest(snapshot: LegacyAppSnapshot): string {
	return planCanonicalAppMigration(snapshot).beforeDigest;
}

function visitAtPath(
	node: unknown,
	segments: readonly string[],
	visit: (value: unknown) => void,
): void {
	const head = segments[0];
	if (head === undefined || !isRecord(node)) return;
	const fanout = head.endsWith("[]");
	const key = fanout ? head.slice(0, -2) : head;
	const value = node[key];
	const rest = segments.slice(1);
	if (fanout) {
		if (!Array.isArray(value)) return;
		for (const child of value) visitAtPath(child, rest, visit);
		return;
	}
	if (rest.length === 0) {
		if (value !== undefined) visit(value);
		return;
	}
	visitAtPath(value, rest, visit);
}

function typedUuidReferences(surface: string, value: unknown): string[] {
	if (surface === "entity-uuid") {
		if (typeof value === "string") return [value];
		if (!isRecord(value)) return [];
		return [value.moduleUuid, value.formUuid].filter(
			(candidate): candidate is string => typeof candidate === "string",
		);
	}
	if (surface === "xpath-ast" || surface === "prose") {
		if (!isRecord(value) || !Array.isArray(value.parts)) return [];
		return value.parts.flatMap((part) => {
			if (!isRecord(part)) return [];
			if (
				(part.kind === "field-ref" || part.kind === "path-ref") &&
				typeof part.uuid === "string"
			) {
				return [part.uuid];
			}
			return [];
		});
	}
	if (surface !== "predicate-ast") return [];
	const references: string[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (!isRecord(node)) return;
		if (node.kind === "field" && typeof node.uuid === "string") {
			references.push(node.uuid);
		}
		for (const child of Object.values(node)) visit(child);
	};
	visit(value);
	return references;
}

export interface FrozenRepairResult {
	readonly version: typeof CANONICAL_IDENTITY_REPAIR_VERSION;
	readonly snapshots: readonly LegacyAppSnapshot[];
	readonly affected: readonly {
		readonly appId: string;
		readonly appDigest: string;
		readonly beforeDigest: string;
		readonly afterDigest: string;
	}[];
	readonly deletedRows: number;
	readonly appendedProperties: number;
	readonly repairedLabelTokens: number;
	readonly clearedCatalogSlots: number;
	readonly resultDigest: string;
}

export function applyFrozenCanonicalIdentityRepair(
	input: readonly LegacyAppSnapshot[],
): FrozenRepairResult {
	const snapshots = cloneJson(input) as MutableLegacyAppSnapshot[];
	const byDigest = new Map<string, MutableLegacyAppSnapshot>();
	for (const snapshot of snapshots) {
		const digest = canonicalIdentityDigest(snapshot.appId);
		invariant(!byDigest.has(digest), `app digest collision at ${digest}`);
		byDigest.set(digest, snapshot);
	}

	const expectedAffected = new Map(
		CANONICAL_IDENTITY_AFFECTED_APPS.map(
			([appDigest, beforeDigest, afterDigest]) => [
				appDigest,
				{ beforeDigest, afterDigest },
			],
		),
	);
	for (const [appDigest, { beforeDigest }] of expectedAffected) {
		const snapshot = byDigest.get(appDigest);
		invariant(snapshot !== undefined, `missing affected app ${appDigest}`);
		invariant(
			snapshotDigest(snapshot) === beforeDigest,
			`affected app ${appDigest} before digest drifted`,
		);
	}

	const preFindings = snapshots.flatMap((snapshot) =>
		planCanonicalAppMigration(snapshot).findings.map((finding) => ({
			appDigest: canonicalIdentityDigest(snapshot.appId),
			...finding,
		})),
	);
	const preCounts = new Map<string, number>();
	for (const finding of preFindings) {
		preCounts.set(finding.code, (preCounts.get(finding.code) ?? 0) + 1);
	}
	invariant(preFindings.length === 66, "pre-repair finding count is not 66");
	invariant(preCounts.get("invalid-topology") === 42, "topology count drifted");
	invariant(
		preCounts.get("unresolved-reference") === 22,
		"unresolved-reference count drifted",
	);
	invariant(
		preCounts.get("hidden-reference") === 2,
		"catalog hidden-reference count drifted",
	);
	invariant(preCounts.size === 3, "a new pre-repair finding class appeared");

	const deleteTargetsByApp = new Map<string, Set<string>>();
	for (const [appDigest, rowUuid] of CANONICAL_IDENTITY_ROW_DELETES) {
		const targets = deleteTargetsByApp.get(appDigest) ?? new Set<string>();
		targets.add(rowUuid);
		deleteTargetsByApp.set(appDigest, targets);
	}
	for (const [appDigest, targets] of deleteTargetsByApp) {
		const snapshot = byDigest.get(appDigest);
		invariant(snapshot !== undefined, "consumer-audit app disappeared");
		for (const row of snapshot.rows) {
			if (targets.has(row.uuid)) continue;
			for (const occurrence of frozenEntityOccurrencesFor(row.kind)) {
				visitAtPath(row.data, occurrence.path.split("."), (value) => {
					for (const reference of typedUuidReferences(
						occurrence.surface,
						value,
					)) {
						invariant(
							!targets.has(reference),
							`reachable ${occurrence.id} points at deleted row ${reference}`,
						);
					}
				});
			}
		}
	}

	for (const projection of CANONICAL_IDENTITY_PROPERTY_PROJECTIONS) {
		const snapshot = byDigest.get(projection.appDigest);
		invariant(snapshot !== undefined, "property projection app disappeared");
		const sourceRows = projection.sourceRowUuids.map((uuid) =>
			snapshot.rows.find((row) => row.uuid === uuid),
		);
		invariant(
			sourceRows.every((row): row is LegacyEntityRow => row !== undefined),
			"property projection source row disappeared",
		);
		invariant(
			canonicalIdentityDigest(sourceRows) === projection.sourceRowsDigest,
			"property projection source rows drifted",
		);
		const first = sourceRows[0];
		invariant(first !== undefined, "property projection has no source row");
		const caseTypeName = first.data.case_property_on;
		const propertyName = first.data.id;
		invariant(
			typeof caseTypeName === "string" && typeof propertyName === "string",
			"property projection source declarations drifted",
		);
		invariant(
			sourceRows.every(
				(row) =>
					row.data.case_property_on === caseTypeName &&
					row.data.id === propertyName,
			),
			"property projection source rows no longer agree",
		);
		const projectionValue = {
			name: propertyName,
			label: { parts: [{ kind: "text", text: propertyName }] },
		};
		invariant(
			canonicalIdentityDigest(projectionValue) === projection.projectionDigest,
			"derived property projection drifted",
		);
		invariant(Array.isArray(snapshot.caseTypes), "case catalog disappeared");
		const caseType = snapshot.caseTypes.find(
			(value) => isRecord(value) && value.name === caseTypeName,
		);
		invariant(
			isRecord(caseType) && Array.isArray(caseType.properties),
			"property projection destination disappeared",
		);
		invariant(
			!caseType.properties.some(
				(value) => isRecord(value) && value.name === propertyName,
			),
			"property projection destination is no longer absent",
		);
		caseType.properties.push(projectionValue);
	}

	for (const [
		appDigest,
		rowUuid,
		rowDigest,
	] of CANONICAL_IDENTITY_ROW_DELETES) {
		const snapshot = byDigest.get(appDigest);
		invariant(
			snapshot !== undefined,
			`row-delete app ${appDigest} disappeared`,
		);
		const row = snapshot.rows.find((candidate) => candidate.uuid === rowUuid);
		invariant(row !== undefined, `row-delete source ${rowUuid} disappeared`);
		invariant(
			canonicalIdentityDigest(row) === rowDigest,
			`row-delete source ${rowUuid} drifted`,
		);
		invariant(
			row.kind === "field" && row.parentUuid === null,
			`row-delete source ${rowUuid} is no longer the reviewed orphan`,
		);
		snapshot.rows = snapshot.rows.filter(
			(candidate) => candidate.uuid !== rowUuid,
		);
	}

	{
		const repair = CANONICAL_IDENTITY_LABEL_REPAIR;
		const snapshot = byDigest.get(repair.appDigest);
		invariant(snapshot !== undefined, "label repair app disappeared");
		const owner = snapshot.rows.find((row) => row.uuid === repair.fieldUuid);
		invariant(owner?.kind === "field", "label repair field disappeared");
		const source = owner.data.label;
		invariant(typeof source === "string", "label repair source shape drifted");
		invariant(
			Buffer.byteLength(source) === repair.sourceBytes &&
				canonicalIdentityDigest(source) === repair.sourceDigest,
			"label repair source bytes drifted",
		);
		const derived = deriveLabelReplacement(source, owner, snapshot.rows);
		invariant(
			derived.clearedTokenIndex === repair.clearedTokenIndex,
			"label clear occurrence drifted",
		);
		invariant(
			JSON.stringify(derived.targetUuids) ===
				JSON.stringify(repair.exactTargetUuids),
			"label exact target identities drifted",
		);
		invariant(
			canonicalIdentityDigest(derived.replacement) === repair.replacementDigest,
			"label replacement AST drifted",
		);
		owner.data.label = derived.replacement;
	}

	for (const clear of CANONICAL_IDENTITY_CATALOG_CLEARS) {
		const snapshot = byDigest.get(clear.appDigest);
		invariant(snapshot !== undefined, "catalog clear app disappeared");
		invariant(Array.isArray(snapshot.caseTypes), "catalog clear root drifted");
		const caseType = snapshot.caseTypes[clear.caseTypeIndex];
		const property =
			isRecord(caseType) && Array.isArray(caseType.properties)
				? caseType.properties[clear.propertyIndex]
				: undefined;
		invariant(isRecord(property), "catalog clear property drifted");
		const source = property[clear.slot];
		invariant(
			typeof source === "string" &&
				Buffer.byteLength(source) === clear.sourceBytes &&
				canonicalIdentityDigest(source) === clear.sourceDigest,
			"catalog clear source bytes drifted",
		);
		delete property[clear.slot];
	}

	const postFindings = snapshots.flatMap((snapshot) =>
		planCanonicalAppMigration(snapshot).findings.map((finding) => ({
			appDigest: canonicalIdentityDigest(snapshot.appId),
			...finding,
		})),
	);
	invariant(postFindings.length === 0, "repair result is not scanner-clean");

	const affected = [...expectedAffected].map(
		([appDigest, { beforeDigest, afterDigest }]) => {
			const snapshot = byDigest.get(appDigest);
			invariant(snapshot !== undefined, "affected result app disappeared");
			const actualAfterDigest = snapshotDigest(snapshot);
			invariant(
				actualAfterDigest === afterDigest,
				`affected app ${appDigest} repaired digest drifted`,
			);
			return {
				appId: snapshot.appId,
				appDigest,
				beforeDigest,
				afterDigest: actualAfterDigest,
			};
		},
	);
	const resultDigest = canonicalIdentityDigest(
		affected.map(({ appDigest, afterDigest }) => ({
			appDigest,
			afterDigest,
		})),
	);
	invariant(
		resultDigest === CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST,
		"complete repair result digest drifted",
	);
	return {
		version: CANONICAL_IDENTITY_REPAIR_VERSION,
		snapshots,
		affected,
		deletedRows: CANONICAL_IDENTITY_ROW_DELETES.length,
		appendedProperties: CANONICAL_IDENTITY_PROPERTY_PROJECTIONS.length,
		repairedLabelTokens: 1,
		clearedCatalogSlots: CANONICAL_IDENTITY_CATALOG_CLEARS.length,
		resultDigest,
	};
}
