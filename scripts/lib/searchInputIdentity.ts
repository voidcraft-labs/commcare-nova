/**
 * Pure legacy Search-input identity scan/transform.
 *
 * Before Search references became identity-backed, an input term stored the
 * input's mutable saved name. A module row contains both the reference-bearing
 * ASTs and that module's Search-input definitions, so it is the only safe
 * conversion scope: resolve each legacy name to exactly one definition UUID,
 * or refuse. There is deliberately no runtime compatibility parser.
 */

import { updateModuleMutation } from "@/lib/doc/addModuleMutation";
import { caseSearchConfigPatchMutations } from "@/lib/doc/caseSearchConfigPatchMutations";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import { type CaseSearchConfig, moduleSchema, type Uuid } from "@/lib/domain";

export interface LegacySearchInputRef {
	readonly path: string;
	readonly name: string;
}

export interface SearchInputIdentityIssue extends LegacySearchInputRef {
	readonly reason: "missing-definition" | "ambiguous-definition";
	readonly candidateUuids: readonly string[];
}

export interface SearchInputIdentityTransform {
	readonly record: Record<string, unknown>;
	readonly converted: readonly LegacySearchInputRef[];
	readonly issues: readonly SearchInputIdentityIssue[];
}

export interface SearchInputIdentityMigrationPlan
	extends SearchInputIdentityTransform {
	readonly mutations: readonly Mutation[];
}

function childPath(parent: string, key: string | number): string {
	return typeof key === "number"
		? `${parent}[${key}]`
		: parent.length === 0
			? key
			: `${parent}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchInputIdentityIndex(
	moduleRecord: Record<string, unknown>,
): ReadonlyMap<string, readonly string[]> {
	const config = isRecord(moduleRecord.caseListConfig)
		? moduleRecord.caseListConfig
		: undefined;
	const definitions = Array.isArray(config?.searchInputs)
		? config.searchInputs
		: [];
	const mutable = new Map<string, string[]>();
	for (const definition of definitions) {
		if (
			!isRecord(definition) ||
			typeof definition.name !== "string" ||
			typeof definition.uuid !== "string"
		) {
			continue;
		}
		const candidates = mutable.get(definition.name) ?? [];
		candidates.push(definition.uuid);
		mutable.set(definition.name, candidates);
	}
	return mutable;
}

/** Find legacy `{ kind: "input", name }` leaves without changing a value. */
export function findLegacySearchInputRefs(
	value: unknown,
): readonly LegacySearchInputRef[] {
	const found: LegacySearchInputRef[] = [];
	const visited = new WeakSet<object>();
	const visit = (node: unknown, path: string): void => {
		if (typeof node !== "object" || node === null) return;
		if (visited.has(node)) return;
		visited.add(node);
		if (Array.isArray(node)) {
			node.forEach((child, index) => {
				visit(child, childPath(path, index));
			});
			return;
		}
		const record = node as Record<string, unknown>;
		if (record.kind === "input" && typeof record.name === "string") {
			found.push({ path, name: record.name });
		}
		for (const [key, child] of Object.entries(record)) {
			visit(child, childPath(path, key));
		}
	};
	visit(value, "");
	return found;
}

/**
 * Convert every legacy input reference in one raw module entity.
 *
 * The result is always a detached clone. Mixed legacy/canonical leaves are
 * treated as legacy and normalized only when the name resolves uniquely.
 */
export function migrateModuleSearchInputRefs(
	moduleRecord: Record<string, unknown>,
): SearchInputIdentityTransform {
	const byName = searchInputIdentityIndex(moduleRecord);
	const record = structuredClone(moduleRecord);
	const converted: LegacySearchInputRef[] = [];
	const issues: SearchInputIdentityIssue[] = [];
	const visited = new WeakSet<object>();

	const visit = (node: unknown, path: string): void => {
		if (typeof node !== "object" || node === null) return;
		if (visited.has(node)) return;
		visited.add(node);
		if (Array.isArray(node)) {
			node.forEach((child, index) => {
				visit(child, childPath(path, index));
			});
			return;
		}
		const current = node as Record<string, unknown>;
		if (current.kind === "input" && typeof current.name === "string") {
			const ref = { path, name: current.name };
			const candidates = byName.get(current.name) ?? [];
			if (candidates.length !== 1) {
				issues.push({
					...ref,
					reason:
						candidates.length === 0
							? "missing-definition"
							: "ambiguous-definition",
					candidateUuids: candidates,
				});
			} else {
				delete current.name;
				current.searchInputUuid = candidates[0];
				converted.push(ref);
			}
		}
		for (const [key, child] of Object.entries(current)) {
			visit(child, childPath(path, key));
		}
	};
	visit(record, "");
	return { record, converted, issues };
}

/**
 * Build the canonical durable-log mutations for one transformed module row.
 *
 * The raw transform exists because the final parser rejects the former leaf.
 * Once transformed, however, the entire module must parse canonically and the
 * permanent mutation row must describe every changed Blueprint slot. A
 * `kind:"migration"` stream entry makes live clients reload, but it is not an
 * excuse to put an empty batch behind a real document change.
 */
export function planModuleSearchInputIdentityMigration(
	moduleRecord: Record<string, unknown>,
): SearchInputIdentityMigrationPlan {
	const transformed = migrateModuleSearchInputRefs(moduleRecord);
	if (transformed.converted.length === 0 || transformed.issues.length > 0) {
		return { ...transformed, mutations: [] };
	}

	const module = moduleSchema.parse(transformed.record);
	const moduleUuid = module.uuid as Uuid;
	const changedTopLevelSlots = new Set(
		transformed.converted.map((ref) => ref.path.split(".", 1)[0]),
	);
	const unsupported = [...changedTopLevelSlots].filter(
		(slot) =>
			slot !== "caseListConfig" &&
			slot !== "caseSearchConfig" &&
			slot !== "displayCondition",
	);
	if (unsupported.length > 0) {
		throw new Error(
			`Module ${module.uuid} has legacy Search-input references in unsupported top-level slot(s): ${unsupported.join(", ")}`,
		);
	}

	const modulePatch: Extract<Mutation, { kind: "updateModule" }>["patch"] = {};
	if (changedTopLevelSlots.has("caseListConfig")) {
		if (module.caseListConfig === undefined) {
			throw new Error(
				`Module ${module.uuid} resolved a caseListConfig reference without a caseListConfig`,
			);
		}
		modulePatch.caseListConfig = module.caseListConfig;
	}
	if (changedTopLevelSlots.has("displayCondition")) {
		if (module.displayCondition === undefined) {
			throw new Error(
				`Module ${module.uuid} resolved a displayCondition reference without a displayCondition`,
			);
		}
		modulePatch.displayCondition = module.displayCondition;
	}

	const mutations: Mutation[] = [];
	if (Object.keys(modulePatch).length > 0) {
		mutations.push(updateModuleMutation(moduleUuid, modulePatch));
	}
	if (changedTopLevelSlots.has("caseSearchConfig")) {
		if (module.caseSearchConfig === undefined) {
			throw new Error(
				`Module ${module.uuid} resolved a caseSearchConfig reference without a caseSearchConfig`,
			);
		}
		const currentCaseSearch = isRecord(moduleRecord.caseSearchConfig)
			? (moduleRecord.caseSearchConfig as CaseSearchConfig)
			: undefined;
		mutations.push(
			...caseSearchConfigPatchMutations(
				moduleUuid,
				currentCaseSearch,
				module.caseSearchConfig,
			),
		);
	}
	for (const mutation of mutations) mutationSchema.parse(mutation);
	if (mutations.length === 0) {
		throw new Error(
			`Module ${module.uuid} converted ${transformed.converted.length} Search-input reference(s) without producing a durable mutation`,
		);
	}
	return { ...transformed, mutations };
}
