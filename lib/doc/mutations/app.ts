import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type { CaseType } from "@/lib/domain";

/**
 * App-level mutations: name, connect mode, case-type catalog, logo. The
 * scalar setters are single-field assignments with no cascading side
 * effects. The granular catalog kinds (`declareCaseType` / `retireCaseType`
 * / `addCaseProperty` / `setCaseProperty` / `removeCaseProperty` /
 * `setCaseTypeMeta`) key by `(case-type name, property name)` and never
 * rewrite the whole `caseTypes` array, so two members concurrently editing
 * different types / properties merge by construction. They are total:
 * targeting an absent type is a no-op (the commit gate adjudicates a field
 * left writing to it via `CASE_PROPERTY_ON_UNKNOWN_TYPE`, and the guarded
 * writer's `batchTargetsMissing` rejects a catalog edit against a
 * concurrently-retired type).
 */
export function applyAppMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "setAppName"
				| "setConnectType"
				| "setCaseTypes"
				| "setAppLogo"
				| "declareCaseType"
				| "retireCaseType"
				| "addCaseProperty"
				| "setCaseProperty"
				| "removeCaseProperty"
				| "setCaseTypeMeta";
		}
	>,
): void {
	switch (mut.kind) {
		case "setAppName":
			draft.appName = mut.name;
			return;
		case "setConnectType":
			draft.connectType = mut.connectType;
			return;
		case "setCaseTypes":
			draft.caseTypes = mut.caseTypes;
			return;
		case "setAppLogo":
			// The doc's `logo` slot is `.optional()`, not `.nullable()`, so
			// a cleared logo must drop off the doc — not persist as a
			// literal `null` the schema would reject. The payload carries
			// `null` to mean "clear"; map it to `undefined` so Immer's
			// assignment removes the key. An asset id sets it verbatim.
			draft.logo = mut.logo ?? undefined;
			return;
		case "declareCaseType": {
			// Idempotent: an existing declaration is left untouched (its
			// properties + ancestry survive a re-declare).
			draft.caseTypes ??= [];
			if (!draft.caseTypes.some((ct) => ct.name === mut.caseType)) {
				draft.caseTypes.push({ name: mut.caseType, properties: [] });
			}
			return;
		}
		case "retireCaseType": {
			if (!draft.caseTypes) return;
			const kept = draft.caseTypes.filter((ct) => ct.name !== mut.caseType);
			// An emptied catalog stores as `null` — the canonical spelling a fresh
			// app is born with (matches `caseTypeRetirement` / `scaffolds`), so the
			// diff round-trip reproduces `null`, not `[]`.
			draft.caseTypes = kept.length > 0 ? kept : null;
			return;
		}
		case "addCaseProperty": {
			// Append to an EXISTING declared type only; idempotent on the
			// property name (two concurrent `addCaseProperty` for different
			// names both land). An absent type is a no-op.
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			if (!ct.properties.some((p) => p.name === mut.property.name)) {
				ct.properties.push(mut.property);
			}
			return;
		}
		case "setCaseProperty": {
			// Replace a property by name (append if absent) — the diff's
			// content-change emission for a property whose data_type/label/…
			// shifted.
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			const idx = ct.properties.findIndex((p) => p.name === mut.property.name);
			if (idx === -1) ct.properties.push(mut.property);
			else ct.properties[idx] = mut.property;
			return;
		}
		case "removeCaseProperty": {
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			ct.properties = ct.properties.filter((p) => p.name !== mut.property);
			return;
		}
		case "setCaseTypeMeta": {
			// Type-level ancestry (`parent_type` / `relationship`). A `null`
			// clears the slot; an omitted (`undefined`) slot is left untouched —
			// a clear must travel as an explicit `null` because JSON drops
			// `undefined`-valued keys.
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			if (mut.parent_type !== undefined) {
				if (mut.parent_type === null) delete ct.parent_type;
				else ct.parent_type = mut.parent_type;
			}
			if (mut.relationship !== undefined) {
				if (mut.relationship === null) delete ct.relationship;
				else ct.relationship = mut.relationship;
			}
			return;
		}
	}
}

/** Resolve a case-type record by name on the draft catalog. */
function findCaseType(
	draft: Draft<BlueprintDoc>,
	name: string,
): Draft<CaseType> | undefined {
	return draft.caseTypes?.find((ct) => ct.name === name);
}
