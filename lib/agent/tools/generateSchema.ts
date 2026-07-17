/**
 * SA tool: `generateSchema` — record the app's data model (the
 * case-type catalog) ON the app, in one gated batch.
 *
 * It commits the design's structural skeleton: per case type,
 * `declareCaseType` → `setCaseTypeMeta` (parent link) → one
 * `addCaseProperty` per property. From then on the catalog is doc
 * state: `createModule` references a case type by NAME, and the field
 * assembly's catalog defaulting (`applyDefaults`) seeds every
 * case-bound field's label / hint / options / validation from the
 * record — the model is stated once, here, and inherited everywhere.
 *
 * The app's NAME is deliberately not an input: naming lives on
 * `updateApp` alone. A required name here would force an existing
 * app's callers to echo the current name to keep it — one paraphrase
 * and the app silently renames as a side effect of declaring a case
 * type. One slot, one home, no echo contract.
 *
 * Committing records AHEAD of their modules is legal by design: the
 * every-written-type-needs-a-module rule (MISSING_CHILD_CASE_MODULE)
 * keys on form WRITERS, not on the catalog, so a planned record sits
 * clean until a form actually creates cases of it.
 *
 * Additive over AUTHORED content: a case type whose record already
 * carries authored detail (a parent link, or any property beyond the
 * bare `{name, label: name, data_type?}` shape the declaration
 * chokepoint's `ensureCatalogProperty` auto-registers) is rejected —
 * re-declaring would silently replace definitions fields were seeded
 * from. A bare, chokepoint-declared record (a module case-type flip or
 * a field write landed before the model was recorded) is ENRICHED in
 * place instead (`setCaseProperty` / `setCaseTypeMeta`) — otherwise no
 * tool could ever author that type's model and field inheritance would
 * permanently miss it. In edit mode this is how a NEW case type enters
 * the app (declare it here, then create its module).
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import { caseTypesOutputSchema, cleanCaseTypeRecord } from "../planningSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const generateSchemaInputSchema = z
	.object({
		caseTypes: caseTypesOutputSchema.shape.case_types,
	})
	.strict();

export type GenerateSchemaInput = z.infer<typeof generateSchemaInputSchema>;

/** Human-readable success string or an error record. */
export type GenerateSchemaResult = MutationSuccess | { error: string };

export const generateSchemaTool = {
	description:
		"Record the app's data model — every case type with its properties — onto the app, in one call. The first call of a build (after the design is reasoned through); also how a NEW case type enters an existing app. A case type with an already-authored record is rejected — pass only new ones (a bare auto-declared type is fine: its record is filled in). createModule then references a case type by name, and fields writing a recorded property inherit its label, options, and validation.",
	inputSchema: generateSchemaInputSchema,
	async execute(
		input: GenerateSchemaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<GenerateSchemaResult>> {
		try {
			// One entry per type name WITHIN the call — two entries for the same
			// name would otherwise silently merge (declare no-ops, properties
			// land first-wins, a later entry's parent link overwrites) into a
			// chimera record no single entry described.
			const seenInInput = new Set<string>();
			const dupInInput = new Set<string>();
			for (const ct of input.caseTypes) {
				if (seenInInput.has(ct.name)) dupInInput.add(ct.name);
				seenInInput.add(ct.name);
			}
			if (dupInInput.size > 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Nothing was recorded — the call lists ${[...dupInInput]
							.map((d) => `"${d}"`)
							.join(
								", ",
							)} more than once. Each case type is one entry; merge the duplicates into a single record and re-issue.`,
					},
				};
			}

			// A record with authored content may not be redefined — fields were
			// seeded from it. A BARE record (the declaration chokepoint's shape:
			// no parent meta, every property exactly the auto-registered
			// `{name, label: name, data_type?}`) carries nothing authored, so
			// the call ENRICHES it in place — this is the only tool that writes
			// property records, and a module flip or field write may have
			// declared the type before the model was recorded.
			const existingByName = new Map(
				(doc.caseTypes ?? []).map((ct) => [ct.name, ct]),
			);
			// `external` is deliberately NOT authored content for bareness: a
			// markPropertyExternal on an auto-declared type must not lock the
			// record out of ever receiving its model. The marking survives
			// enrichment instead — carried forward onto a restated property
			// below.
			const isBare = (ct: CaseType): boolean =>
				ct.parent_type === undefined &&
				ct.relationship === undefined &&
				ct.properties.every(
					(p) =>
						p.label === p.name &&
						p.hint === undefined &&
						p.required === undefined &&
						p.validation === undefined &&
						p.validation_msg === undefined &&
						p.options === undefined,
				);
			const authored = input.caseTypes
				.map((ct) => existingByName.get(ct.name))
				.filter((ct): ct is CaseType => ct !== undefined && !isBare(ct))
				.map((ct) => ct.name);
			if (authored.length > 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Nothing was recorded — the app already carries an authored record for ${authored
							.map((d) => `"${d}"`)
							.join(
								", ",
							)}, and re-declaring would replace definitions existing fields were seeded from. Re-issue with only the new case types; if none remain, the model is already on the app and nothing needs recording.`,
					},
				};
			}

			const mutations: Mutation[] = [];
			const enriched: string[] = [];
			for (const raw of input.caseTypes) {
				// Collapse the record's null slots to absence BEFORE it touches
				// the catalog — a null hint/parent_type on a stored CaseProperty
				// fails the next load's Zod gate.
				const record = cleanCaseTypeRecord(raw) as CaseType;
				const bareExisting = existingByName.has(record.name);
				if (bareExisting) enriched.push(record.name);
				mutations.push({ kind: "declareCaseType", caseType: record.name });
				if (record.parent_type != null || record.relationship != null) {
					mutations.push({
						kind: "setCaseTypeMeta",
						caseType: record.name,
						parent_type: record.parent_type ?? null,
						relationship: record.relationship ?? null,
					});
				}
				// Hoisted per record: the stored properties (the marking
				// carry-forward's source) and the input's EXPLICIT
				// `external: null`s — `cleanCaseTypeRecord` collapses null to
				// absence, but on the enrichment path null means CLEAR (the
				// edit-path law), so the distinction is read off the parsed
				// input before the collapse.
				const storedByName = bareExisting
					? new Map(
							(existingByName.get(record.name)?.properties ?? []).map((p) => [
								p.name,
								p,
							]),
						)
					: undefined;
				const explicitClears = new Set(
					raw.properties.filter((p) => p.external === null).map((p) => p.name),
				);
				for (const prop of record.properties) {
					// A restated property REPLACES the stored one by name — carry
					// an existing external marking forward when the incoming
					// record neither sets its own nor explicitly clears it, so
					// enriching a bare declaration never silently un-marks a
					// property (and an explicit clear actually clears).
					const carried = storedByName?.get(prop.name)?.external;
					const property =
						carried !== undefined &&
						prop.external === undefined &&
						!explicitClears.has(prop.name)
							? { ...prop, external: carried }
							: prop;
					mutations.push(
						// `setCaseProperty` replaces a bare auto-registered property
						// by name (and appends a new one); `addCaseProperty` would
						// first-wins no-op against it and silently drop the authored
						// detail. Auto-registered properties the call doesn't restate
						// survive — declared properties outlive their writers.
						bareExisting
							? { kind: "setCaseProperty", caseType: record.name, property }
							: { kind: "addCaseProperty", caseType: record.name, property },
					);
				}
			}

			const commit = await guardedMutate(ctx, doc, mutations, "schema");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}

			const typeNames = input.caseTypes.map((ct) => ct.name);
			const propertyCount = input.caseTypes.reduce(
				(n, ct) => n + ct.properties.length,
				0,
			);
			const summary: ToolCallSummary = {
				subject: typeNames.join(", "),
				count: input.caseTypes.length,
			};
			return {
				kind: "mutate" as const,
				mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Recorded the data model: ${typeNames.length} case type${typeNames.length === 1 ? "" : "s"} (${typeNames.join(", ")}) with ${propertyCount} properties.${enriched.length > 0 ? ` ${enriched.map((n) => `"${n}"`).join(", ")} existed as a bare declaration and now carries the recorded model.` : ""} createModule now references these by name; fields writing a recorded property inherit its label, options, and validation.`,
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
