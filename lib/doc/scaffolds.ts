// lib/doc/scaffolds.ts
//
// Pure `Mutation[]` builders for the builder's in-tree "add module / add form"
// affordances. They are the UI twin of the SA's `lib/agent/blueprintHelpers.ts`
// + `createModule` / `createForm` tools: every creation lands the entity TOGETHER
// with the minimal contents that make it valid, so the whole batch passes the
// commit gate (`mutationCommitVerdict`) as one candidate. Valid-by-construction
// forbids an empty shell — a lone `addModule` (of ANY kind) introduces
// `NO_FORMS_OR_CASE_LIST` (a module needs a form or a case list), a case-managing
// one adds `MISSING_CASE_LIST_COLUMNS`, and a lone `addForm` introduces
// `EMPTY_FORM` — so the defaults below aren't cosmetic, they're what keeps
// creation alive under the gate.
//
// The reducer applies a batch sequentially, so an `addForm` that names the
// module the same batch just added resolves against the live draft — the same
// shape the SA emits. uuids are minted here so the caller can navigate to the
// new entity after the gated commit.

import {
	asUuid,
	type BlueprintDoc,
	type CaseListConfig,
	type Field,
	type Form,
	type FormType,
	fieldCasePropertyOn,
	formTypeLabels,
	humanizeId,
	type Module,
	plainColumn,
	type TextField,
	type Uuid,
	uniqueSlug,
} from "@/lib/domain";
import { addModuleMutation, updateModuleMutation } from "./addModuleMutation";
import type { CaseTypeRetirement } from "./caseTypeRetirement";
import { orderedFormUuids, orderedModuleUuids } from "./fieldWalk";
import { sequenceOrderKeys } from "./order/append";
import { deriveKeyAtIndex, keyBetween } from "./order/keys";
import type { Mutation } from "./types";

/** The fractional `order` key for a module inserted at `index` (default
 *  append) in the app's DISPLAY sequence — so the "+" insertion renders at the
 *  requested slot under the order-key-sorted render. */
export function moduleOrderKeyAtIndex(
	doc: BlueprintDoc,
	index: number | undefined,
): string {
	const keys = orderedModuleUuids(doc)
		.map((uuid) => doc.modules[uuid]?.order)
		.filter((o): o is string => o !== undefined);
	return deriveKeyAtIndex(keys, index ?? keys.length);
}

/** The fractional `order` key for a form inserted at `index` (default append)
 *  in its module's DISPLAY sequence. */
export function formOrderKeyAtIndex(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	index: number | undefined,
): string {
	const keys = orderedFormUuids(doc, moduleUuid)
		.map((uuid) => doc.forms[uuid]?.order)
		.filter((o): o is string => o !== undefined);
	return deriveKeyAtIndex(keys, index ?? keys.length);
}

/**
 * The case-type DECLARATION chokepoint. A field writing to a case type absent
 * from the catalog prepends a granular `declareCaseType` — the reducer no
 * longer auto-creates the type on a field write (that would clobber a
 * concurrent declaration), so EVERY `case_property_on`-setting surface (the SA
 * add/edit assembly, the MCP field handlers via the shared tools, and the
 * builder's add/edit gestures) routes through this. A no-op when the field
 * writes no case or its type is already declared.
 */
export function declareCaseTypeForField(
	doc: BlueprintDoc,
	field: Field,
): Mutation[] {
	const caseType = fieldCasePropertyOn(field);
	if (caseType === undefined) return [];
	return declareCaseTypeMutations(doc, caseType);
}

/** Header for the `Name` column a new case module is born with. `case_name` is
 *  a CommCare standard property, so the column resolves (`columnReferences` →
 *  `augmentCaseType`) once the case type is in the catalog — which is why the
 *  viewer declares its type even when no form writes `case_name` yet. */
const NAME_COLUMN_HEADER = "Name";

/** The canonical starter case-list column — a plain `case_name`/"Name" column.
 *  Born WITH an `order` key (the first-member seed `keyBetween(null, null)`) so
 *  it sorts correctly the moment a keyed column is added beside it — the
 *  `store.load` backfill is a legacy safety net, not a substitute for minting
 *  the key at construction. */
function nameColumn() {
	return {
		...plainColumn(
			asUuid(crypto.randomUUID()),
			"case_name",
			NAME_COLUMN_HEADER,
		),
		order: keyBetween(null, null),
	};
}

/** A case-list config carrying a `Name` column, preserving an existing
 *  config's search inputs + filter. The single home of the "born with a Name
 *  column" shape every creation/case-type path seeds. */
function caseListConfigWithName(existing?: CaseListConfig): CaseListConfig {
	return {
		columns: [nameColumn()],
		searchInputs: existing?.searchInputs ?? [],
		...(existing?.filter && { filter: existing.filter }),
	};
}

function existingModuleIds(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();
	for (const uuid of doc.moduleOrder) {
		const mod = doc.modules[uuid];
		if (mod) ids.add(mod.id);
	}
	return ids;
}

function existingFormIds(doc: BlueprintDoc): Set<string> {
	const ids = new Set<string>();
	for (const list of Object.values(doc.formOrder)) {
		for (const uuid of list ?? []) {
			const form = doc.forms[uuid];
			if (form) ids.add(form.id);
		}
	}
	return ids;
}

/** A text field. Typed as `TextField` (not cast to `Field`) so the per-kind
 *  schema check still applies — a property the kind doesn't have won't compile,
 *  the guarantee `newFieldDefaults.ts` was created to keep. */
function textField(id: string, label: string, caseType?: string): TextField {
	return {
		kind: "text",
		uuid: asUuid(crypto.randomUUID()),
		id,
		label,
		...(caseType !== undefined && { case_property_on: caseType }),
	};
}

/** The field a registration form is born with: just the `case_name` writer
 *  (`NO_CASE_NAME_FIELD`). A name-only case create is valid across the whole
 *  wire (verified against commcare-hq / commcare-core / formplayer), so no
 *  extra "saved property" field is forced. */
function registrationFields(caseType: string | undefined): TextField[] {
	return [textField("case_name", "Name", caseType)];
}

/** A plain text question — the default first field for a non-registration
 *  form, so the form isn't born empty (`EMPTY_FORM`). */
function defaultQuestion(): TextField {
	return textField("question_1", "Question 1");
}

export interface CaseListModuleScaffold {
	/** The case type the module manages (existing or freshly-named). */
	caseType: string;
	/** Display name; defaults to the humanized case type. */
	name?: string;
	/** Insertion index in `moduleOrder`; appends when omitted. */
	index?: number;
}

/** Declare `caseType` in the catalog (empty properties) when it's new — a no-op
 *  for a type already present. A formless viewer (or a settings-set type) has no
 *  form to write `case_name`, so the type must be in the catalog for the `Name`
 *  column's standard property to resolve (`augmentCaseType`). Emits the granular
 *  `declareCaseType` (the reducer is idempotent), so a concurrent catalog edit
 *  merges. */
export function declareCaseTypeMutations(
	doc: BlueprintDoc,
	caseType: string,
): Mutation[] {
	const existing = doc.caseTypes ?? [];
	if (existing.some((ct) => ct.name === caseType)) return [];
	return [{ kind: "declareCaseType", caseType }];
}

/**
 * The catalog writes for a module case-type change: retire the orphaned OLD
 * type and/or declare the brand-NEW one. Both are granular kinds keyed by type
 * name, so emitting them separately merges a concurrent edit to a DIFFERENT
 * type. Returns `[]` when neither applies (an existing type set on a
 * still-owned module, or a non-case-type patch).
 */
export function caseTypeCatalogMutations(
	doc: BlueprintDoc,
	retirement: CaseTypeRetirement,
	nextCaseType: string | undefined,
): Mutation[] {
	const existing = doc.caseTypes ?? [];
	const isNew =
		typeof nextCaseType === "string" &&
		!existing.some((ct) => ct.name === nextCaseType);
	const mutations: Mutation[] = [];
	if (retirement.kind === "retire") {
		mutations.push({ kind: "retireCaseType", caseType: retirement.caseType });
	}
	if (isNew) {
		mutations.push({
			kind: "declareCaseType",
			caseType: nextCaseType as string,
		});
	}
	return mutations;
}

/**
 * A case-list module, born as a VIEWER (`caseListOnly`): the module + its case
 * type + a `Name` case-list column, and NO forms. A formless case module must
 * be `caseListOnly` (otherwise `NO_FORMS_OR_CASE_LIST`); the user adds a
 * registration form afterward via the form affordance, which flips the flag off
 * (`formScaffoldMutations`). The case type is declared in the catalog so the
 * Name column resolves before any form writes `case_name`.
 */
export function caseListModuleMutations(
	doc: BlueprintDoc,
	{ caseType, name, index }: CaseListModuleScaffold,
): { mutations: Mutation[]; moduleUuid: Uuid } {
	const moduleUuid = asUuid(crypto.randomUUID());
	const moduleName = name ?? humanizeId(caseType);
	const module: Module = {
		uuid: moduleUuid,
		id: uniqueSlug(moduleName, "module", existingModuleIds(doc)),
		name: moduleName,
		order: moduleOrderKeyAtIndex(doc, index),
		caseType,
		caseListOnly: true,
		caseListConfig: caseListConfigWithName(),
	};
	return {
		mutations: [
			...declareCaseTypeMutations(doc, caseType),
			addModuleMutation(module, index),
		],
		moduleUuid,
	};
}

/**
 * A survey/menu module — no case type — born WITH one survey form (a single
 * text question, so the form isn't empty either).
 *
 * The form is not optional padding: a module with no forms and no case list is
 * a HARD, build-blocking error in CommCare ("<menu> has no forms or case list"
 * — see `NO_FORMS_OR_CASE_LIST` in `rules/module.ts`), regardless of case type.
 * So a bare module is NOT a valid state, and this lands the module together
 * with the minimum that makes it exportable — the same valid-by-construction
 * shape as `caseListModuleMutations` (born a full viewer) and `formScaffoldMutations`
 * (born with a field). The reducer applies the batch sequentially, so the
 * `addForm` / `addField` naming this module resolve against the live draft.
 */
export function surveyModuleMutations(
	doc: BlueprintDoc,
	{ name, index }: { name?: string; index?: number } = {},
): { mutations: Mutation[]; moduleUuid: Uuid; formUuid: Uuid } {
	const moduleUuid = asUuid(crypto.randomUUID());
	const moduleName = name ?? "Survey";
	const module: Module = {
		uuid: moduleUuid,
		id: uniqueSlug(moduleName, "module", existingModuleIds(doc)),
		name: moduleName,
		order: moduleOrderKeyAtIndex(doc, index),
	};
	// The module is brand new, so both the form (first in the module) and the
	// field (first in the form) take the first key of a fresh order sequence.
	const [firstKey] = sequenceOrderKeys(1);
	const formUuid = asUuid(crypto.randomUUID());
	const formName = formTypeLabels.survey;
	const form: Form = {
		uuid: formUuid,
		id: uniqueSlug(formName, "form", existingFormIds(doc)),
		name: formName,
		order: firstKey,
		type: "survey",
	};
	const field: TextField = { ...defaultQuestion(), order: firstKey };
	return {
		mutations: [
			addModuleMutation(module, index),
			{ kind: "addForm", moduleUuid, form },
			{ kind: "addField", parentUuid: formUuid, field },
		],
		moduleUuid,
		formUuid,
	};
}

// ── Creation templates ───────────────────────────────────────────────
// What an app can be BORN holding, as opposed to what the builder adds to a
// live one. Fed to `createApp`'s `seedMutations`, which gates the batch and
// then refuses to create anything that isn't export-ready.

/**
 * The app name a blank app is born with.
 *
 * Deliberately NOT `UNTITLED_APP_NAME` (`lib/db/apps.ts`), which is the DISPLAY
 * fallback `denormalize` writes into the summary row when the in-doc name is
 * blank. This is a real, persisted `blueprint.appName`: a blank app has no SA
 * run to name it, and `EMPTY_APP_NAME` blocks export until something does. The
 * two strings coincide today; they are not the same concept, and collapsing
 * them would silently un-name every blank app.
 */
export const BLANK_APP_NAME = "Untitled";

/**
 * The blank app's contents — one survey module with one survey form (one text
 * question). Reuses `surveyModuleMutations`, so the blank app IS the builder's
 * "add survey module" shape.
 *
 * Paired with `BLANK_APP_NAME`, this is the smallest EXPORT-ready app, the bar
 * an app hand-built with no SA run behind it has to clear the moment it exists.
 * The form is what clears it: a module with no forms and no case list is a
 * hard, build-blocking error in CommCare (`NO_FORMS_OR_CASE_LIST`), so a bare
 * module is NOT exportable however tempting its simplicity. One module also
 * satisfies `docHasData`, without which the builder would bounce the user back
 * to the centered chat they just chose to skip.
 *
 * A case type instead of none would oblige case-list columns on top.
 */
export function blankAppMutations(doc: BlueprintDoc): Mutation[] {
	return surveyModuleMutations(doc).mutations;
}

/**
 * A new form of `type` in `moduleUuid`, born with a default first field:
 *   - `registration` → a `case_name` writer (needs the module's case type)
 *   - everything else → a plain text question
 *
 * A `caseListOnly` module can't hold forms (`CASE_LIST_ONLY_HAS_FORMS`), so the
 * batch first flips the flag off and seeds a `Name` column if the module has
 * none (a case-managing module with forms obliges one — `MISSING_CASE_LIST_COLUMNS`).
 * Returns `null` when the module doesn't exist.
 */
export function formScaffoldMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	type: FormType,
	index?: number,
): { mutations: Mutation[]; formUuid: Uuid } | null {
	const mod = doc.modules[moduleUuid];
	if (!mod) return null;

	const formUuid = asUuid(crypto.randomUUID());
	const formName = formTypeLabels[type];
	const form: Form = {
		uuid: formUuid,
		id: uniqueSlug(formName, "form", existingFormIds(doc)),
		name: formName,
		order: formOrderKeyAtIndex(doc, moduleUuid, index),
		type,
	};
	// A registration form is born with just the `case_name` writer; every other
	// type gets one text question so it isn't born empty (`EMPTY_FORM`).
	const fields =
		type === "registration"
			? registrationFields(mod.caseType)
			: [defaultQuestion()];

	const mutations: Mutation[] = [];
	// Declare each case type a born field writes to BEFORE its addField. The
	// reducer no longer auto-mints the type, and `mod.caseType` can be ABSENT
	// from the catalog (dropped from the data model, or a retire-vs-add race) —
	// so a registration form's `case_name` writer would otherwise trip
	// `CASE_PROPERTY_ON_UNKNOWN_TYPE` and the form would silently not be created.
	// The same declare chokepoint every sibling case_property_on surface routes
	// through; idempotent (a no-op) when the type is already present.
	for (const field of fields) {
		mutations.push(...declareCaseTypeForField(doc, field));
	}
	if (mod.caseListOnly) {
		const patch: Partial<Omit<Module, "uuid">> = { caseListOnly: false };
		if ((mod.caseListConfig?.columns.length ?? 0) === 0) {
			patch.caseListConfig = caseListConfigWithName(mod.caseListConfig);
		}
		mutations.push(updateModuleMutation(moduleUuid, patch));
	}
	mutations.push({
		kind: "addForm",
		moduleUuid,
		form,
		...(index !== undefined && { index }),
	});
	// The born-with fields land in ascending display order — a fresh order-key
	// sequence (the form is new, so it seeds one).
	const orderKeys = sequenceOrderKeys(fields.length);
	for (let i = 0; i < fields.length; i++) {
		mutations.push({
			kind: "addField",
			parentUuid: formUuid,
			field: { ...fields[i], order: orderKeys[i] },
		});
	}
	return { mutations, formUuid };
}

/**
 * The module patch that SETS a case type on an existing module, born valid:
 *
 *   - No forms → a case-list-only VIEWER (`caseListOnly: true`) with a `Name`
 *     column, exactly like a born viewer (`caseListModuleMutations`). A formless
 *     case module is invalid (`NO_FORMS_OR_CASE_LIST`); the viewer is the only
 *     valid formless+typed shape, and adding a form later flips the flag off
 *     (`formScaffoldMutations`).
 *   - Has forms, no columns → seed a `Name` column (a form-bearing case module
 *     obliges one, `MISSING_CASE_LIST_COLUMNS`).
 *   - Has forms + columns → just the type.
 *
 * A brand-new `caseType` must ALSO be declared in the catalog so the `Name`
 * column resolves — that's the caller's job (`updateModule` prepends
 * `declareCaseTypeMutations`), not part of this module patch.
 *
 * Centralizing the born-valid decision here keeps the settings UI from
 * re-encoding the rule; callers pass the module + whether it has forms (both in
 * hand from their entity hooks) rather than the whole doc.
 */
export function caseTypeSetPatch(
	mod: Module,
	hasForms: boolean,
	caseType: string,
): Partial<Omit<Module, "uuid">> {
	if (!hasForms)
		return {
			caseType,
			caseListOnly: true,
			caseListConfig: caseListConfigWithName(mod.caseListConfig),
		};
	const hasColumns = (mod.caseListConfig?.columns.length ?? 0) > 0;
	return hasColumns
		? { caseType }
		: { caseType, caseListConfig: caseListConfigWithName(mod.caseListConfig) };
}

/**
 * The module patch that CLEARS a module's case type, turning it into a survey.
 * Drops the now-meaningless case-list + case-search config in the same patch —
 * a typeless module keeping its `caseSearchConfig` would trip
 * `caseSearchConfigRequiresCaseType`, and orphaned columns would resurface on
 * re-typing. ALSO drops `caseListOnly`: a viewer (the born case-list shape) is
 * `caseListOnly: true`, and clearing its type while keeping the flag leaves an
 * invalid typeless viewer (`CASE_LIST_ONLY_NO_CASE_TYPE`) — a survey has the
 * flag off. (Clears travel as `undefined` per the `updateModule` convention;
 * the wholesale snapshot save strips them, so absence is the cleared state.)
 */
export function caseTypeClearPatch(): Partial<Omit<Module, "uuid">> {
	return {
		caseType: undefined,
		caseListOnly: undefined,
		caseListConfig: undefined,
		caseSearchConfig: undefined,
	};
}
