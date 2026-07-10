/**
 * Shared drift computation for the scan-then-migrate pair
 * (`scan-schema-drift.ts` / `migrate-schema-drift.ts`).
 *
 * Derived property typing changed what `case_type_schemas` rows and
 * expression indexes are built FROM: `buildCaseTypeMap` reads the
 * materializable effective view (writer-derived `data_type`s filled),
 * where stored rows for pre-derivation apps were materialized from
 * the raw catalog (untyped declarations collapsed to `text`). The
 * runtime converges a row only when some later edit touches its case
 * type's diff — and `classifyCaseTypeChanges` diffs prior-vs-
 * prospective views that BOTH already carry the derived types, so
 * the stored-vs-derived delta is invisible to it. This module makes
 * that delta explicit: compare each stored schema row against the
 * freshly-derived one, property by property.
 *
 * Drift classes per case type:
 *   - `missingRow` — no stored row at all (the app predates schema
 *     materialization for this type); a plain re-sync creates it.
 *   - `added` — property in the derived schema only. No stored row
 *     can carry values for it (`additionalProperties: false`
 *     rejected writes), so a plain re-sync suffices.
 *   - `removed` — property in the stored row only (a declaration
 *     since deleted without a schema sync). Plain re-sync drops it.
 *   - `refined` — both sides carry the property, the DOMAIN type is
 *     unchanged, only the spec detail differs (an option-set edit, a
 *     bounds tweak). No per-row cast needed; plain re-sync converges.
 *   - `retyped` — both sides carry the property with different
 *     domain types. Rows may hold values in the OLD shape, so the
 *     migrate script runs `applySchemaChange` with a `retype` change
 *     — per-row cast, uncastable rows quarantined.
 *   - `unresolvable` — a stored spec this module can't invert to a
 *     `CasePropertyDataType` (schema drift from a future/foreign
 *     writer). Reported for an owner decision; never auto-migrated.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../lib/case-store/postgres/connection";
import type { PersistableDoc } from "../../lib/domain";
import type { CasePropertyDataType } from "../../lib/domain/casePropertyTypes";
import { materializableCaseTypes } from "../../lib/domain/effectiveCaseTypes";
import {
	type CaseTypePropertyJsonSchema,
	caseTypeToJsonSchema,
} from "../../lib/domain/predicate/jsonSchema";

export interface RetypedProperty {
	readonly property: string;
	readonly fromType: CasePropertyDataType;
	readonly toType: CasePropertyDataType;
	readonly fromSpec: string;
	readonly toSpec: string;
}

export interface CaseTypeDrift {
	readonly caseType: string;
	readonly missingRow: boolean;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly refined: readonly string[];
	readonly retyped: readonly RetypedProperty[];
	readonly unresolvable: readonly string[];
}

/**
 * Invert a stored per-property JSON Schema spec back to the
 * `CasePropertyDataType` that emitted it — the exact inverse of
 * `propertyToSchema` in `lib/domain/predicate/jsonSchema.ts`.
 * `text` and an option-less `single_select` both emit a bare
 * `{type:"string"}`; the inversion answers `text`, which is
 * cast-equivalent (both are Postgres text reads), so the retype
 * migration behaves identically. Returns `undefined` for a spec no
 * current arm emits.
 */
export function dataTypeFromSpec(
	spec: CaseTypePropertyJsonSchema,
): CasePropertyDataType | undefined {
	switch (spec.type) {
		case "integer":
			return "int";
		case "number":
			return "decimal";
		case "array":
			return "multi_select";
		case "string": {
			if (spec.enum !== undefined) return "single_select";
			if (spec.pattern !== undefined) return "geopoint";
			switch (spec.format) {
				case undefined:
					return "text";
				case "date":
					return "date";
				case "time":
					return "time";
				case "date-time":
					return "datetime";
				default:
					return undefined;
			}
		}
		default:
			return undefined;
	}
}

/**
 * Compare an app's stored `case_type_schemas` rows against the
 * schemas its blueprint derives today. Read-only. Returns one entry
 * per case type that drifts; an in-sync app returns `[]`.
 */
export async function computeSchemaDrift(
	db: Kysely<Database>,
	appId: string,
	blueprint: PersistableDoc,
): Promise<CaseTypeDrift[]> {
	const storedRows = await db
		.selectFrom("case_type_schemas")
		.select(["case_type", "schema"])
		.where("app_id", "=", appId)
		.execute();
	const storedByType = new Map(storedRows.map((r) => [r.case_type, r.schema]));

	const drifts: CaseTypeDrift[] = [];
	for (const ct of materializableCaseTypes(blueprint)) {
		const desired = caseTypeToJsonSchema(ct);
		const stored = storedByType.get(ct.name);
		if (stored === undefined) {
			if (Object.keys(desired.properties).length === 0) continue;
			drifts.push({
				caseType: ct.name,
				missingRow: true,
				added: Object.keys(desired.properties),
				removed: [],
				refined: [],
				retyped: [],
				unresolvable: [],
			});
			continue;
		}

		const storedProps =
			(stored as { properties?: Record<string, unknown> }).properties ?? {};
		const added: string[] = [];
		const removed: string[] = [];
		const refined: string[] = [];
		const retyped: RetypedProperty[] = [];
		const unresolvable: string[] = [];

		for (const [name, desiredSpec] of Object.entries(desired.properties)) {
			const storedSpec = storedProps[name];
			if (storedSpec === undefined) {
				added.push(name);
				continue;
			}
			const fromSpec = JSON.stringify(storedSpec);
			const toSpec = JSON.stringify(desiredSpec);
			if (fromSpec === toSpec) continue;
			const fromType = dataTypeFromSpec(
				storedSpec as CaseTypePropertyJsonSchema,
			);
			// An untyped derived entry validates as plain text, so a
			// stored typed spec LOOSENING to it is still a per-row cast
			// (a stored JSON number must stringify, or the row fails AJV
			// on its next update) — collapse absent to `text`, the same
			// value-semantics rule `effectiveDataType` applies.
			const toType =
				ct.properties.find((p) => p.name === name)?.data_type ?? "text";
			if (fromType === undefined) {
				unresolvable.push(name);
				continue;
			}
			if (fromType === toType) {
				refined.push(name);
				continue;
			}
			retyped.push({ property: name, fromType, toType, fromSpec, toSpec });
		}
		for (const name of Object.keys(storedProps)) {
			if (!(name in desired.properties)) removed.push(name);
		}

		if (
			added.length === 0 &&
			removed.length === 0 &&
			refined.length === 0 &&
			retyped.length === 0 &&
			unresolvable.length === 0
		) {
			continue;
		}
		drifts.push({
			caseType: ct.name,
			missingRow: false,
			added,
			removed,
			refined,
			retyped,
			unresolvable,
		});
	}
	return drifts;
}
