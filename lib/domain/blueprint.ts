// lib/domain/blueprint.ts
//
// The normalized blueprint document — single source of truth for the
// builder's domain state. This is the persisted shape (decomposed into
// per-entity rows and recomposed on load — no nested-tree conversion).
// In-memory representation matches the persisted one, minus the
// `fieldParent` reverse index which is rebuilt from `fieldOrder` on
// load.

import { z } from "zod";
import { automationNestedUuids, automationSchema } from "./automations";
import { authoredCasePropertyNameSchema } from "./casePropertyName";
import {
	type CasePropertyDataType,
	casePropertyDataTypeSchema,
	casePropertyDataTypes,
} from "./casePropertyTypes";
import { fieldSchema, isContainer } from "./fields";
import { formSchema } from "./forms";
import { appLocalizationSchema } from "./localization";
import { isOwnerOnlyCaseSearchConfig, moduleSchema } from "./modules";
import { mediaAssetIdSchema } from "./multimedia";
import {
	locationPropertySchema,
	organizationLevelSchema,
} from "./organization";
import { proseTemplateSchema } from "./prose";
import { ownRecordSchema } from "./records";
import type { ReferenceIndex } from "./referenceIndex";
import { personaSchema, userPropertySchema, userTypeSchema } from "./users";
import { type Uuid, uuidSchema } from "./uuid";
import { xpathExpressionSchema } from "./xpath";

// Re-exports — `casePropertyDataTypes` / `CasePropertyDataType` /
// `casePropertyDataTypeSchema` live at the leaf
// `./casePropertyTypes` so the predicate AST + the structured
// `Module` schema can pull them without a cycle through the rest
// of the case-type definitions in this file. Surfaced from the
// blueprint barrel so existing `@/lib/domain` consumers see the
// same names without an import-path migration.
export {
	type CasePropertyDataType,
	casePropertyDataTypeSchema,
	casePropertyDataTypes,
};

// Case type schemas — moved verbatim from lib/schemas/blueprint.ts.

export const casePropertySchema = z
	.object({
		name: authoredCasePropertyNameSchema,
		label: proseTemplateSchema,
		data_type: casePropertyDataTypeSchema.optional(),
		hint: proseTemplateSchema.optional(),
		required: xpathExpressionSchema.optional(),
		validation: xpathExpressionSchema.optional(),
		validation_msg: proseTemplateSchema.optional(),
		options: z
			.array(
				z.object({ value: z.string(), label: proseTemplateSchema }).strict(),
			)
			.optional(),
	})
	.strict();
export type CaseProperty = z.infer<typeof casePropertySchema>;

export const caseTypeSchema = z
	.object({
		name: z.string(),
		properties: z.array(casePropertySchema),
		parent_type: z.string().optional(),
		relationship: z.enum(["child", "extension"]).optional(),
	})
	.strict();
export type CaseType = z.infer<typeof caseTypeSchema>;

export const CONNECT_TYPES = ["learn", "deliver"] as const;
export type ConnectType = (typeof CONNECT_TYPES)[number];

/** The one user-facing name of each Connect mode, shared by every surface. */
export const CONNECT_TYPE_LABELS: Readonly<Record<ConnectType, string>> = {
	learn: "Learn",
	deliver: "Deliver",
};

/**
 * The name an app carries when its creator supplied no non-blank one.
 *
 * A real authored name, written through the same `setAppName` mutation as every
 * later rename — never a display fallback applied at read time. The validator's
 * `EMPTY_APP_NAME` soundness rule is what makes a blank name impossible to
 * commit, so every reader can print `appName` without a blank-name branch.
 */
export const APP_GENESIS_FALLBACK_NAME = "Untitled";

const blueprintDocObjectSchema = z
	.object({
		appId: z.string(),
		appName: z.string(),
		connectType: z.enum(CONNECT_TYPES).nullable(),
		caseTypes: z.array(caseTypeSchema).nullable(),
		/**
		 * Optional app-level target-language overlay. Absence is the exact legacy
		 * single-English state; canonical source strings stay on their ordinary
		 * owning entities rather than being duplicated here.
		 */
		localization: appLocalizationSchema.optional(),

		modules: ownRecordSchema(uuidSchema, moduleSchema),
		forms: ownRecordSchema(uuidSchema, formSchema),
		fields: ownRecordSchema(uuidSchema, fieldSchema),

		moduleOrder: z.array(uuidSchema),
		formOrder: ownRecordSchema(uuidSchema, z.array(uuidSchema)),
		fieldOrder: ownRecordSchema(uuidSchema, z.array(uuidSchema)),

		/**
		 * App-level logo for the web-apps surface. A single image —
		 * no audio, no per-language variants — shown on the login
		 * and home screens. Android-only logo slots are out of scope
		 * for Nova's web-apps target.
		 */
		logo: mediaAssetIdSchema.optional(),

		/**
		 * Who runs the app (`./users.ts`): the user-data property catalog,
		 * the user types built on it, and the named preview personas that
		 * act as those types.
		 *
		 * Each is a UUID-keyed record paired with a membership array that IS
		 * its sequence, the same shape `moduleOrder` / `formOrder` use. Both
		 * slots are OPTIONAL and omitted when empty, so an app that declares
		 * none serializes byte-identically to one authored before they
		 * existed. Read them through `userPropertiesOf` / `userTypesOf` /
		 * `personasOf` rather than defaulting at the call site.
		 *
		 * The record and its array cannot silently disagree: `assembleBlueprint`
		 * throws on exactly that mismatch, which is the guard the hierarchical
		 * collections have always relied on.
		 */
		userProperties: ownRecordSchema(uuidSchema, userPropertySchema).optional(),
		userPropertyOrder: z.array(uuidSchema).optional(),
		userTypes: ownRecordSchema(uuidSchema, userTypeSchema).optional(),
		userTypeOrder: z.array(uuidSchema).optional(),
		personas: ownRecordSchema(uuidSchema, personaSchema).optional(),
		personaOrder: z.array(uuidSchema).optional(),

		/** The app-authored shape of its organization. Location rows live in
		 * the app-scoped organization store, not in BlueprintDoc. */
		organizationLevels: ownRecordSchema(
			uuidSchema,
			organizationLevelSchema,
		).optional(),
		organizationLevelOrder: z.array(uuidSchema).optional(),
		locationProperties: ownRecordSchema(
			uuidSchema,
			locationPropertySchema,
		).optional(),
		locationPropertyOrder: z.array(uuidSchema).optional(),

		/** Human-applied HQ rules and alerts. Preview only evaluates current
		 * matches; it never runs these schedules. */
		automations: ownRecordSchema(uuidSchema, automationSchema).optional(),
		automationOrder: z.array(uuidSchema).optional(),

		// fieldParent is NOT persisted — derived from fieldOrder on load.
	})
	.strict();

type BlueprintTopologyInput = z.output<typeof blueprintDocObjectSchema>;

export interface BlueprintTopologyIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

function topologyIssue(
	issues: BlueprintTopologyIssue[],
	path: readonly (string | number)[],
	message: string,
): void {
	issues.push({ path, message });
}

/**
 * The one normalized-document closure proof.
 *
 * Records own identity; membership arrays own both parentage and sequence.
 * This function deliberately reports every deterministic finding in collection
 * order so the domain parser, commit gate, validator, assembly, and
 * decomposition cannot disagree about which topology is constructible.
 */
export function blueprintTopologyIssues(
	doc: BlueprintTopologyInput,
): readonly BlueprintTopologyIssue[] {
	const issues: BlueprintTopologyIssue[] = [];
	const globalIdentities = new Map<string, string>();
	const registerIdentity = (
		uuid: string,
		kind: string,
		path: readonly (string | number)[],
	): void => {
		const previous = globalIdentities.get(uuid);
		if (previous !== undefined) {
			topologyIssue(
				issues,
				path,
				`Authored uuid ${uuid} appears in both ${previous} and ${kind}.`,
			);
		} else {
			globalIdentities.set(uuid, kind);
		}
	};
	const registerRecord = (
		recordName: string,
		record: Readonly<Record<string, { readonly uuid: string }>>,
	): void => {
		for (const [key, entity] of Object.entries(record)) {
			if (key !== entity.uuid) {
				topologyIssue(
					issues,
					[recordName, key, "uuid"],
					`${recordName} record key ${key} must equal embedded uuid ${entity.uuid}.`,
				);
			}
			registerIdentity(entity.uuid, recordName, [recordName, key]);
		}
	};

	registerRecord("modules", doc.modules);
	registerRecord("forms", doc.forms);
	registerRecord("fields", doc.fields);
	registerRecord("userProperties", doc.userProperties ?? {});
	registerRecord("userTypes", doc.userTypes ?? {});
	registerRecord("personas", doc.personas ?? {});
	registerRecord("organizationLevels", doc.organizationLevels ?? {});
	registerRecord("locationProperties", doc.locationProperties ?? {});
	registerRecord("automations", doc.automations ?? {});

	for (const [moduleUuid, module] of Object.entries(doc.modules)) {
		if (
			isOwnerOnlyCaseSearchConfig(module.caseSearchConfig) &&
			(module.caseListConfig?.searchInputs.length ?? 0) > 0
		) {
			topologyIssue(
				issues,
				["modules", moduleUuid, "caseSearchConfig", "searchActionEnabled"],
				"Owner-only case availability cannot coexist with Search inputs.",
			);
		}
		const caseListConfig = module.caseListConfig;
		for (const [index, column] of (caseListConfig?.columns ?? []).entries()) {
			registerIdentity(column.uuid, "case-list column", [
				"modules",
				moduleUuid,
				"caseListConfig",
				"columns",
				index,
				"uuid",
			]);
		}
		if (caseListConfig !== undefined) {
			const columnUuids = new Set(
				caseListConfig.columns.map((column) => column.uuid),
			);
			const validateColumnOrder = (
				orderName: "listColumnOrder" | "detailColumnOrder",
				order: readonly Uuid[],
			): void => {
				const seen = new Set<Uuid>();
				for (const [index, uuid] of order.entries()) {
					const path = [
						"modules",
						moduleUuid,
						"caseListConfig",
						orderName,
						index,
					] as const;
					if (seen.has(uuid)) {
						topologyIssue(
							issues,
							path,
							`${orderName} contains duplicate column ${uuid}.`,
						);
					}
					seen.add(uuid);
					if (!columnUuids.has(uuid)) {
						topologyIssue(
							issues,
							path,
							`${orderName} member ${uuid} does not exist in columns.`,
						);
					}
				}
				for (const column of caseListConfig.columns) {
					if (!seen.has(column.uuid)) {
						topologyIssue(
							issues,
							["modules", moduleUuid, "caseListConfig", "columns", column.uuid],
							`Column ${column.uuid} is absent from ${orderName}.`,
						);
					}
				}
			};
			validateColumnOrder("listColumnOrder", caseListConfig.listColumnOrder);
			validateColumnOrder(
				"detailColumnOrder",
				caseListConfig.detailColumnOrder,
			);
		}
		for (const [index, input] of (
			caseListConfig?.searchInputs ?? []
		).entries()) {
			registerIdentity(input.uuid, "Search input", [
				"modules",
				moduleUuid,
				"caseListConfig",
				"searchInputs",
				index,
				"uuid",
			]);
		}
	}
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		for (const [index, operation] of (form.caseOperations ?? []).entries()) {
			registerIdentity(operation.uuid, "case operation", [
				"forms",
				formUuid,
				"caseOperations",
				index,
				"uuid",
			]);
		}
		for (const [index, link] of (form.formLinks ?? []).entries()) {
			registerIdentity(link.uuid, "form link", [
				"forms",
				formUuid,
				"formLinks",
				index,
				"uuid",
			]);
		}
	}
	for (const [fieldUuid, field] of Object.entries(doc.fields)) {
		if (!("optionsSource" in field) || field.optionsSource.kind !== "inline") {
			continue;
		}
		for (const [index, option] of field.optionsSource.options.entries()) {
			registerIdentity(option.uuid, "select option", [
				"fields",
				fieldUuid,
				"optionsSource",
				"options",
				index,
				"uuid",
			]);
		}
	}
	for (const [automationUuid, automation] of Object.entries(
		doc.automations ?? {},
	)) {
		for (const [index, uuid] of automationNestedUuids(automation).entries()) {
			registerIdentity(uuid, "automation child", [
				"automations",
				automationUuid,
				"children",
				index,
			]);
		}
	}

	const connectIds = new Map<string, string>();
	const connectKinds = [
		"learn_module",
		"assessment",
		"deliver_unit",
		"task",
	] as const;
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		const connect = form.connect;
		if (connect === undefined) continue;
		const isLearn = "learn_module" in connect || "assessment" in connect;
		if (doc.connectType === null || (doc.connectType === "learn") !== isLearn) {
			topologyIssue(
				issues,
				["forms", formUuid, "connect"],
				"Form Connect configuration must match the app Connect mode.",
			);
		}
		const blocks = connect as Partial<
			Record<(typeof connectKinds)[number], { readonly id: string }>
		>;
		for (const kind of connectKinds) {
			const block = blocks[kind];
			if (block === undefined) continue;
			const site = `forms.${formUuid}.connect.${kind}`;
			const previous = connectIds.get(block.id);
			if (previous !== undefined) {
				topologyIssue(
					issues,
					["forms", formUuid, "connect", kind, "id"],
					`Connect id ${block.id} appears in both ${previous} and ${site}.`,
				);
			} else {
				connectIds.set(block.id, site);
			}
		}
	}

	const exactSequence = (
		recordName: string,
		record: Readonly<Record<string, unknown>>,
		sequenceName: string,
		sequence: readonly string[],
	): void => {
		const seen = new Set<string>();
		for (const [index, uuid] of sequence.entries()) {
			if (seen.has(uuid)) {
				topologyIssue(
					issues,
					[sequenceName, index],
					`${sequenceName} contains duplicate member ${uuid}.`,
				);
			}
			seen.add(uuid);
			if (!Object.hasOwn(record, uuid)) {
				topologyIssue(
					issues,
					[sequenceName, index],
					`${sequenceName} member ${uuid} does not exist in ${recordName}.`,
				);
			}
		}
		for (const uuid of Object.keys(record)) {
			if (!seen.has(uuid)) {
				topologyIssue(
					issues,
					[recordName, uuid],
					`${recordName} member ${uuid} is absent from ${sequenceName}.`,
				);
			}
		}
	};

	exactSequence("modules", doc.modules, "moduleOrder", doc.moduleOrder);

	const expectedFormParents = new Set(Object.keys(doc.modules));
	for (const parentUuid of Object.keys(doc.formOrder)) {
		if (!expectedFormParents.has(parentUuid)) {
			topologyIssue(
				issues,
				["formOrder", parentUuid],
				`formOrder key ${parentUuid} is not a module.`,
			);
		}
	}
	for (const moduleUuid of expectedFormParents) {
		if (!Object.hasOwn(doc.formOrder, moduleUuid)) {
			topologyIssue(
				issues,
				["formOrder"],
				`Module ${moduleUuid} has no formOrder membership array.`,
			);
		}
	}
	const seenForms = new Map<string, string>();
	for (const moduleUuid of doc.moduleOrder) {
		for (const [index, formUuid] of (
			doc.formOrder[moduleUuid] ?? []
		).entries()) {
			const previousParent = seenForms.get(formUuid);
			if (previousParent !== undefined) {
				topologyIssue(
					issues,
					["formOrder", moduleUuid, index],
					`Form ${formUuid} appears under both ${previousParent} and ${moduleUuid}.`,
				);
			} else {
				seenForms.set(formUuid, moduleUuid);
			}
			if (!Object.hasOwn(doc.forms, formUuid)) {
				topologyIssue(
					issues,
					["formOrder", moduleUuid, index],
					`formOrder member ${formUuid} does not exist in forms.`,
				);
			}
		}
	}
	for (const formUuid of Object.keys(doc.forms)) {
		if (!seenForms.has(formUuid)) {
			topologyIssue(
				issues,
				["forms", formUuid],
				`Form ${formUuid} is absent from every formOrder membership array.`,
			);
		}
	}

	const containerUuids = new Set(
		Object.entries(doc.fields)
			.filter(([, field]) => isContainer(field))
			.map(([uuid]) => uuid),
	);
	const expectedFieldParents = new Set([
		...Object.keys(doc.forms),
		...containerUuids,
	]);
	for (const parentUuid of Object.keys(doc.fieldOrder)) {
		if (!expectedFieldParents.has(parentUuid)) {
			topologyIssue(
				issues,
				["fieldOrder", parentUuid],
				`fieldOrder key ${parentUuid} is neither a form nor a container field.`,
			);
		}
	}
	for (const parentUuid of expectedFieldParents) {
		if (!Object.hasOwn(doc.fieldOrder, parentUuid)) {
			topologyIssue(
				issues,
				["fieldOrder"],
				`Field parent ${parentUuid} has no fieldOrder membership array.`,
			);
		}
	}
	const fieldParent = new Map<string, string>();
	for (const parentUuid of expectedFieldParents) {
		for (const [index, fieldUuid] of (
			doc.fieldOrder[parentUuid] ?? []
		).entries()) {
			const previousParent = fieldParent.get(fieldUuid);
			if (previousParent !== undefined) {
				topologyIssue(
					issues,
					["fieldOrder", parentUuid, index],
					`Field ${fieldUuid} appears under both ${previousParent} and ${parentUuid}.`,
				);
			} else {
				fieldParent.set(fieldUuid, parentUuid);
			}
			if (!Object.hasOwn(doc.fields, fieldUuid)) {
				topologyIssue(
					issues,
					["fieldOrder", parentUuid, index],
					`fieldOrder member ${fieldUuid} does not exist in fields.`,
				);
			}
		}
	}
	for (const fieldUuid of Object.keys(doc.fields)) {
		if (!fieldParent.has(fieldUuid)) {
			topologyIssue(
				issues,
				["fields", fieldUuid],
				`Field ${fieldUuid} is absent from every fieldOrder membership array.`,
			);
		}
	}
	for (const fieldUuid of Object.keys(doc.fields)) {
		const ancestors = new Set<string>([fieldUuid]);
		let parent = fieldParent.get(fieldUuid);
		while (parent !== undefined && containerUuids.has(parent)) {
			if (ancestors.has(parent)) {
				topologyIssue(
					issues,
					["fields", fieldUuid],
					`Field membership cycle reaches ${parent}.`,
				);
				break;
			}
			ancestors.add(parent);
			parent = fieldParent.get(parent);
		}
	}

	exactSequence(
		"userProperties",
		doc.userProperties ?? {},
		"userPropertyOrder",
		doc.userPropertyOrder ?? [],
	);
	exactSequence(
		"userTypes",
		doc.userTypes ?? {},
		"userTypeOrder",
		doc.userTypeOrder ?? [],
	);
	exactSequence(
		"personas",
		doc.personas ?? {},
		"personaOrder",
		doc.personaOrder ?? [],
	);
	exactSequence(
		"organizationLevels",
		doc.organizationLevels ?? {},
		"organizationLevelOrder",
		doc.organizationLevelOrder ?? [],
	);
	exactSequence(
		"locationProperties",
		doc.locationProperties ?? {},
		"locationPropertyOrder",
		doc.locationPropertyOrder ?? [],
	);
	exactSequence(
		"automations",
		doc.automations ?? {},
		"automationOrder",
		doc.automationOrder ?? [],
	);

	return issues;
}

export const blueprintDocSchema = blueprintDocObjectSchema.superRefine(
	(doc, ctx) => {
		for (const issue of blueprintTopologyIssues(doc)) {
			ctx.addIssue({
				code: "custom",
				path: [...issue.path],
				message: issue.message,
			});
		}
	},
);

/**
 * The persisted shape of the blueprint doc.
 *
 * This is the direct Zod-inferred type from `blueprintDocSchema`. It does NOT
 * include `fieldParent` — that field is derived from `fieldOrder` on load and
 * is never stored.
 *
 * Use `BlueprintDoc` for in-memory / store state (includes `fieldParent`);
 * use `PersistableDoc` at persistence read/write boundaries.
 */
export type PersistableDoc = z.infer<typeof blueprintDocSchema>;

/**
 * The blueprint as it crosses the persistence boundary — a
 * `PersistableDoc` PROVABLY free of the in-memory derived state.
 *
 * `BlueprintDoc` is structurally assignable to `PersistableDoc` (extra
 * properties don't break TS assignability), so a writer parameter typed
 * `PersistableDoc` would happily accept an unstripped in-memory doc and
 * serialize `fieldParent` + the reference index into the stored rows. The
 * `never`-typed slots are the compile-time wall: a value whose TYPE
 * declares either property is rejected at the call site, while the
 * output of `toPersistableDoc` (and any Zod-parsed wire payload)
 * passes untouched. Every direct blueprint writer takes this shape, so
 * the strip chokepoint is type-enforced rather than discipline.
 */
export type PersistedBlueprint = PersistableDoc & {
	fieldParent?: never;
	refIndex?: never;
};

export type BlueprintDoc = PersistableDoc & {
	/** Reverse index: field uuid → parent uuid (form or container). Maintained
	 *  atomically by every mutation that touches fieldOrder. Rebuilt by
	 *  rebuildFieldParent() on load. Not persisted. */
	fieldParent: Record<Uuid, Uuid>;
	/**
	 * The reference + declarations index (`lib/domain/referenceIndex.ts`)
	 * — derived state, never persisted. Seeded by every apply entry
	 * point (`lib/doc/mutations`' `applyMutation(s)` build it on first
	 * contact) and by the hydration boundaries (`store.load`, the MCP
	 * blueprint load, the chat route's working doc), then maintained
	 * incrementally per mutation. Optional so the many read-only
	 * `PersistableDoc → BlueprintDoc` widenings (compile, upload,
	 * preview) stay valid without paying a build they never read;
	 * reference operations go through `lib/doc/referenceIndex.ts`'s
	 * accessor, which falls back to a fresh build when the slot is
	 * absent.
	 */
	refIndex?: ReferenceIndex;
};
