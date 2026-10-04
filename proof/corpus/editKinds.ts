/**
 * One candidate-batch generator per mutation kind the reducer defines.
 *
 * `EDIT_KIND_GENERATORS` is typed `satisfies Record<Mutation["kind"],
 * KindGenerator>`, so a kind added to `lib/doc/types.ts::mutationSchema`
 * fails the typecheck until a generator here draws it.
 *
 * Every generator targets entities of the document it is given, never
 * constants. Where an editor composes a kind, the batch comes from that
 * editor's production planner (the Builder's `lib/doc` planners, or the
 * SA/MCP compositions in `lib/agent/blueprintHelpers.ts`), so a batch carries
 * the companions an editor would send.
 *
 * Where the document has nothing for an addition, an update or a move to act
 * on, the batch starts with the birth of what it needs (a case type, a
 * case-list module, a form, a persona, a language), and the rest of the batch
 * is planned against the document that prefix leaves. A removal only ever
 * removes something the document holds: removing an entity the same batch
 * gave birth to leaves the document as it was, so a removal kind whose
 * document holds no target proposes nothing there.
 *
 * A generator proposes up to `MAX_TARGETS` candidates; the caller keeps the
 * first one the commit gate and Nova's publish checks admit.
 */

import {
	addColumnsMutation,
	addFieldMutations,
	addSearchInputsMutation,
	removeColumnMutation,
	removeFieldMutations,
	removeFormMutations,
	removeModuleMutations,
	removeSearchInputMutation,
	reorderColumnsMutation,
	reorderSearchInputsMutation,
	setAppLogoMutations,
	setFieldMediaMutations,
	setFormMediaMutations,
	setModuleMediaMutations,
	updateColumnMutation,
	updateFieldMutations,
	updateFormMutations,
	updateSearchInputMutation,
} from "@/lib/agent/blueprintHelpers";
import {
	addCaseOperationMutations,
	removeCaseOperationMutation,
	updateCaseOperationMutations,
} from "@/lib/doc/caseOperationMutations";
import { enableCaseSearchMutation } from "@/lib/doc/caseSearchConfigMutations";
import { caseSearchConfigPatchMutations } from "@/lib/doc/caseSearchConfigPatchMutations";
import { planCaseSelectionChange } from "@/lib/doc/caseSelectionMutations";
import { planCaseTypeRetirementOnRemove } from "@/lib/doc/caseTypeRetirement";
import { planConnectTargetState } from "@/lib/doc/connectTargetState";
import { automationChangesForUpdate } from "@/lib/doc/diffDocsToMutations";
import {
	setFormDisplayConditionMutation,
	setModuleDisplayConditionMutation,
} from "@/lib/doc/displayConditionMutations";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import {
	planEntryPointAdd,
	planEntryPointRemove,
	planEntryPointUpdate,
} from "@/lib/doc/entryPointMutations";
import { planFormLinkDependentsOnRemove } from "@/lib/doc/formLinkDependents";
import {
	planFormLinkAdd,
	planFormLinkMove,
	planFormLinkRemove,
	planFormLinkUpdate,
	planSetFallback,
} from "@/lib/doc/formLinkMutations";
import { splitIntoSections } from "@/lib/doc/formSectionMutations";
import {
	fieldPlacementVerdict,
	formIsSectioned,
} from "@/lib/doc/formSectionVerdicts";
import { planKindConversion } from "@/lib/doc/kindConversionCascade";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import { planModuleChildDependentsOnRemove } from "@/lib/doc/moduleDependents";
import {
	addLocationPropertyMutations,
	addOrganizationLevelMutations,
	removeLocationPropertyMutations,
	removeOrganizationLevelPlan,
} from "@/lib/doc/organizationMutations";
import { referencingCarrierUuids } from "@/lib/doc/referenceIndex";
import {
	caseListModuleMutations,
	declareCaseTypeMutations,
	formScaffoldMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import { noMatchesRegistrationFormMutations } from "@/lib/doc/searchNoMatchesForm";
import type { Mutation } from "@/lib/doc/types";
import { unusedCasePropertyError } from "@/lib/doc/unusedCaseProperty";
import {
	addPersonaMutations,
	addUserPropertyMutations,
	addUserTypeMutations,
	removePersonaMutations,
	removeUserPropertyPlan,
	removeUserTypePlan,
	updatePersonaMutations,
	updateUserTypeMutations,
} from "@/lib/doc/userMutations";
import {
	type AppLanguageIdentity,
	type Automation,
	automationMessageText,
	automationsOf,
	type BlueprintDoc,
	CASE_SCALAR_PROPERTY_NAMES,
	type CaseOperation,
	type Column,
	canonicalProseTemplate,
	caseTypeTargetKey,
	collectTranslationUnits,
	convertNeedsOptionSeed,
	type EntryPointTarget,
	effectiveAppLocalization,
	effectiveCaseSearchConfig,
	entityTargetKey,
	entryPointAt,
	entryPointInventory,
	type Field,
	type FieldKind,
	type FieldPatchFor,
	type FormLink,
	fieldKindDeclaresKey,
	getConvertibleTypes,
	isContainer,
	isOwnerOnlyCaseSearchConfig,
	isStandardCaseListProperty,
	type LanguageTag,
	languageTag,
	locationPropertiesOf,
	type Module,
	opaqueXPathExpression,
	organizationLevelsOf,
	type ProseTemplate,
	personasOf,
	plainColumn,
	proseText,
	type SearchInputDef,
	type SelectOption,
	simpleSearchInputDef,
	type TranslationEntry,
	type TranslationUnit,
	translationValueIntegrityIssue,
	type Uuid,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	sessionUser,
	term,
} from "@/lib/domain/predicate";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import {
	docAfter,
	type FieldAt,
	fieldParentsInOrder,
	fieldsInOrder,
	formsInOrder,
	type Minter,
	type Rng,
} from "./editContext";

/** What a generator draws with. */
export interface GenContext {
	/**
	 * The document the generator plans against: the hydrated admitted
	 * document, its reference index built, or, inside `hosted`, the document
	 * a host's birth leaves.
	 */
	readonly doc: BlueprintDoc;
	/**
	 * Every identity the admitted document holds (and its Project lookup
	 * data), so a generator can tell the document's own entities from ones
	 * its batch gives birth to.
	 */
	readonly known: ReadonlySet<string>;
	readonly rng: Rng;
	readonly mint: Minter;
	/** The Project's lookup tables the document is edited against, if any. */
	readonly lookup?: LookupFixtureDataSnapshot;
}

/**
 * One proposed batch, or the refusal of the production planner asked to
 * compose it (named `planner:<reason>` in the census).
 */
export type Candidate =
	| { readonly mutations: readonly Mutation[] }
	| { readonly refused: string };

/** Up to `MAX_TARGETS` candidates; none means the kind has no target here. */
export type KindGenerator = (ctx: GenContext) => readonly Candidate[];

/** Targets tried per kind per document. */
export const MAX_TARGETS = 3;

// ── Small helpers ────────────────────────────────────────────────────

const batch = (mutations: readonly Mutation[]): Candidate => ({ mutations });
const refusal = (reason: string): Candidate => ({
	refused: `planner:${reason}`,
});

/**
 * A seeded order of `items`, the ones `prefer` picks first. Generators
 * prefer entities the reference index says something reads, so a batch
 * reaches the readers a locality check looks at whenever the document has
 * any.
 */
function ordered<T>(
	ctx: GenContext,
	items: readonly T[],
	prefer?: (item: T) => boolean,
): T[] {
	const shuffled = ctx.rng.shuffle(items);
	if (prefer === undefined) return shuffled;
	return [
		...shuffled.filter((item) => prefer(item)),
		...shuffled.filter((item) => !prefer(item)),
	];
}

/** A seeded choice of up to `n` items. */
function take<T>(
	ctx: GenContext,
	items: readonly T[],
	n = MAX_TARGETS,
	prefer?: (item: T) => boolean,
): T[] {
	return ordered(ctx, items, prefer).slice(0, n);
}

/** Candidates from targets, stopping once `MAX_TARGETS` are proposed. */
function forTargets<T>(
	ctx: GenContext,
	targets: readonly T[],
	propose: (target: T) => Candidate | undefined,
	prefer?: (target: T) => boolean,
): Candidate[] {
	const out: Candidate[] = [];
	for (const target of ordered(ctx, targets, prefer)) {
		const candidate = propose(target);
		if (candidate !== undefined) out.push(candidate);
		if (out.length >= MAX_TARGETS) break;
	}
	return out;
}

/** Extend a prerequisite prefix with the batch planned on what it leaves. */
function withPrefix(
	prefix: readonly Mutation[],
	candidate: Candidate,
): Candidate {
	if ("refused" in candidate) return candidate;
	return batch([...prefix, ...candidate.mutations]);
}

function edited(text: string): string {
	return `${text} (edited)`;
}

function proseSource(template: ProseTemplate | undefined): string {
	return (template?.parts ?? [])
		.map((part) => (part.kind === "text" ? part.text : ""))
		.join("")
		.trim();
}

function modulesInOrder(doc: BlueprintDoc): Module[] {
	return doc.moduleOrder.flatMap((uuid) => doc.modules[uuid] ?? []);
}

function rootModules(doc: BlueprintDoc): Module[] {
	return modulesInOrder(doc).filter((m) => m.parentModuleUuid === undefined);
}

function childrenOf(doc: BlueprintDoc, parent: Uuid): Module[] {
	return modulesInOrder(doc).filter((m) => m.parentModuleUuid === parent);
}

/** Modules with a case list the Search and column editors act on. */
function caseListModules(doc: BlueprintDoc): Module[] {
	return modulesInOrder(doc).filter(
		(m) => m.caseType !== undefined && m.caseListConfig !== undefined,
	);
}

function caseTypeNames(doc: BlueprintDoc): string[] {
	return (doc.caseTypes ?? []).map((ct) => ct.name);
}

/** Authored (non-standard) catalog properties of a case type. */
function authoredProperties(doc: BlueprintDoc, caseType: string) {
	return (
		doc.caseTypes?.find((ct) => ct.name === caseType)?.properties ?? []
	).filter(
		(p) =>
			!isStandardCaseListProperty(p.name) &&
			!CASE_SCALAR_PROPERTY_NAMES.has(p.name),
	);
}

/** Text-typed catalog properties a text column or input can read. */
function textPropertiesOf(doc: BlueprintDoc, caseType: string): string[] {
	const catalog =
		doc.caseTypes?.find((ct) => ct.name === caseType)?.properties ?? [];
	return [
		"case_name",
		...catalog
			.filter(
				(p) =>
					p.name !== "case_name" &&
					(p.data_type === undefined || p.data_type === "text"),
			)
			.map((p) => p.name),
	];
}

function inlineOptionsOf(field: Field): readonly SelectOption[] | undefined {
	if (!("optionsSource" in field)) return undefined;
	const source = field.optionsSource;
	return source.kind === "inline" ? source.options : undefined;
}

function freshOption(ctx: GenContext): SelectOption {
	const value = ctx.mint.name("edit_option");
	return { uuid: ctx.mint.uuid(), value, label: proseText("Edited option") };
}

function freshTextField(ctx: GenContext): Field {
	return {
		kind: "text",
		uuid: ctx.mint.uuid(),
		id: ctx.mint.name("edit_question"),
		label: proseText("Edited question"),
	};
}

/** Leaf input fields (not containers), in document order. */
function leafFields(doc: BlueprintDoc): FieldAt[] {
	return fieldsInOrder(doc).filter((at) => !isContainer(at.field));
}

/** Whether anything in the reference index reads this entity. */
function isRead(doc: BlueprintDoc, uuid: Uuid): boolean {
	return referencingCarrierUuids(doc, entityTargetKey(uuid)).length > 0;
}

const readField =
	(ctx: GenContext) =>
	(at: FieldAt): boolean =>
		isRead(ctx.doc, at.field.uuid);
const readModule =
	(ctx: GenContext) =>
	(m: Module): boolean =>
		isRead(ctx.doc, m.uuid);
const readForm =
	(ctx: GenContext) =>
	(at: { readonly formUuid: Uuid }): boolean =>
		isRead(ctx.doc, at.formUuid);

/** Whether the admitted document holds this entity (it is not a birth). */
const held =
	(ctx: GenContext) =>
	(uuid: string): boolean =>
		ctx.known.has(uuid);

// ── Hosts ────────────────────────────────────────────────────────────

/** What a kind needs the document to hold, and the birth that supplies it. */
interface Host {
	readonly holds: (doc: BlueprintDoc) => boolean;
	/** The birth, planned as the editor that creates it plans it. */
	readonly birth: (ctx: GenContext) => readonly Mutation[];
}

/**
 * A case-list module of a new case type: the Builder's case-list scaffold
 * (`caseListModuleMutations`), which declares the type with it.
 */
function caseListBirth(ctx: GenContext): readonly Mutation[] {
	return caseListModuleMutations(ctx.doc, {
		caseType: ctx.mint.name("edit_type"),
		name: "Edited list",
	}).mutations;
}

const CASE_TYPE_HOST: Host = {
	holds: (doc) => caseTypeNames(doc).length > 0,
	birth: (ctx) => declareCaseTypeMutations(ctx.doc, ctx.mint.name("edit_type")),
};

const CASE_LIST_HOST: Host = {
	holds: (doc) => caseListModules(doc).length > 0,
	birth: caseListBirth,
};

const SEARCH_HOST: Host = {
	holds: (doc) => searchableModules(doc).length > 0,
	birth: caseListBirth,
};

/** Automations run on a case type some module lists. */
const CASE_MODULE_HOST: Host = {
	holds: (doc) => modulesInOrder(doc).some((m) => m.caseType !== undefined),
	birth: caseListBirth,
};

/**
 * A question of a kind `accepts` takes; its birth is a text question in the
 * first open parent (`addFieldMutations`).
 */
function questionHost(accepts: (field: Field) => boolean): Host {
	return {
		holds: (doc) => fieldsInOrder(doc).some((at) => accepts(at.field)),
		birth: (ctx) => {
			const parent = take(ctx, openFieldParents(ctx.doc), 1)[0];
			return parent === undefined
				? []
				: addFieldMutations(ctx.doc, {
						parentUuid: parent.parentUuid,
						field: freshTextField(ctx),
					});
		},
	};
}

const CONVERTIBLE_HOST = questionHost(
	(field) => getConvertibleTypes(field.kind).length > 0,
);

const LABEL_MEDIA_HOST = questionHost((field) =>
	fieldKindDeclaresKey(field.kind, "label_media"),
);

/** A survey menu born with its form and one question (`surveyModuleMutations`). */
const FORM_HOST: Host = {
	holds: (doc) => formsInOrder(doc).length > 0,
	birth: (ctx) =>
		surveyModuleMutations(ctx.doc, { name: "Edited survey" }).mutations,
};

/**
 * The generator run against a document that holds the host it needs. Where
 * the document holds none, every candidate starts with the host's birth and
 * the generator plans the rest against the document that birth leaves.
 */
function hosted(host: Host, generate: KindGenerator): KindGenerator {
	return (ctx) => {
		if (host.holds(ctx.doc)) return generate(ctx);
		const prefix = host.birth(ctx);
		if (prefix.length === 0) return [];
		const doc = docAfter(ctx.doc, prefix);
		if (!host.holds(doc)) return [];
		return generate({ ...ctx, doc }).map((candidate) =>
			withPrefix(prefix, candidate),
		);
	};
}

// ── Entry points ─────────────────────────────────────────────────────

function openEntryPointTargets(doc: BlueprintDoc): EntryPointTarget[] {
	const targets: EntryPointTarget[] = [];
	for (const m of modulesInOrder(doc)) {
		targets.push({ kind: "module", moduleUuid: m.uuid });
		if (m.caseListConfig !== undefined) {
			targets.push({ kind: "case-list", moduleUuid: m.uuid });
		}
	}
	for (const at of formsInOrder(doc)) {
		targets.push({ kind: "form", ...at });
	}
	return targets.filter((target) => entryPointAt(doc, target) === undefined);
}

function planEntryPointBirth(
	ctx: GenContext,
	target: EntryPointTarget,
): Candidate {
	const plan = planEntryPointAdd(ctx.doc, target, {
		uuid: ctx.mint.uuid(),
		id: ctx.mint.name("edit_link"),
	});
	return plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind);
}

/** Existing entry points, or the batch prefix that creates one. */
function entryPointSubjects(
	ctx: GenContext,
): { prefix: readonly Mutation[]; doc: BlueprintDoc; uuids: Uuid[] }[] {
	const existing = entryPointInventory(ctx.doc).map((e) => e.entryPoint.uuid);
	if (existing.length > 0) {
		return [{ prefix: [], doc: ctx.doc, uuids: existing }];
	}
	return take(ctx, openEntryPointTargets(ctx.doc), 2).flatMap((target) => {
		const birth = planEntryPointBirth(ctx, target);
		if ("refused" in birth) return [];
		const after = docAfter(ctx.doc, birth.mutations);
		return [
			{
				prefix: birth.mutations,
				doc: after,
				uuids: entryPointInventory(after).map((e) => e.entryPoint.uuid),
			},
		];
	});
}

const addEntryPoint: KindGenerator = (ctx) =>
	forTargets(ctx, openEntryPointTargets(ctx.doc), (target) =>
		planEntryPointBirth(ctx, target),
	);

const updateEntryPoint: KindGenerator = (ctx) =>
	entryPointSubjects(ctx).flatMap(({ prefix, doc, uuids }) =>
		take(ctx, uuids, 2).map((uuid) => {
			const item = entryPointInventory(doc).find(
				(e) => e.entryPoint.uuid === uuid,
			);
			const patch =
				item?.target.kind === "form" &&
				item.entryPoint.ignoreDisplayConditions === undefined &&
				ctx.rng.next() < 0.5
					? { ignoreDisplayConditions: true as const }
					: { id: ctx.mint.name("edit_link") };
			const plan = planEntryPointUpdate(doc, uuid, patch);
			return withPrefix(
				prefix,
				plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind),
			);
		}),
	);

const removeEntryPoint: KindGenerator = (ctx) =>
	take(
		ctx,
		entryPointInventory(ctx.doc).map((e) => e.entryPoint.uuid),
	).map((uuid) => {
		const plan = planEntryPointRemove(ctx.doc, uuid);
		return plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind);
	});

// ── App, languages, translations ─────────────────────────────────────

/** Well-known living languages the generator adds, in seeded order. */
const LANGUAGE_POOL: readonly AppLanguageIdentity[] = [
	{ language: "spa" },
	{ language: "fra" },
	{ language: "por" },
	{ language: "hin" },
	{ language: "swh" },
];

function freshLanguages(ctx: GenContext): AppLanguageIdentity[] {
	const present = new Set(
		effectiveAppLocalization(ctx.doc.localization).languageOrder,
	);
	return ctx.rng
		.shuffle(LANGUAGE_POOL)
		.filter((identity) => !present.has(languageTag(identity)));
}

/** A target language (not the source), or the prefix that adds one. */
function targetLanguages(
	ctx: GenContext,
): { prefix: readonly Mutation[]; doc: BlueprintDoc; tag: LanguageTag }[] {
	const localization = effectiveAppLocalization(ctx.doc.localization);
	const existing = localization.languageOrder.filter(
		(tag) => tag !== localization.sourceLanguage,
	);
	if (existing.length > 0) {
		return take(ctx, existing, 2).map((tag) => ({
			prefix: [],
			doc: ctx.doc,
			tag,
		}));
	}
	return freshLanguages(ctx)
		.slice(0, 1)
		.map((language) => {
			const prefix: Mutation[] = [{ kind: "addLanguage", language }];
			return {
				prefix,
				doc: docAfter(ctx.doc, prefix),
				tag: languageTag(language),
			};
		});
}

function translatedValue(
	unit: TranslationUnit,
	tag: LanguageTag,
): TranslationEntry["value"] {
	if (unit.valueKind === "text") {
		const source = typeof unit.source === "string" ? unit.source : "";
		return `${source} [${tag}]`.trim();
	}
	const source = unit.source as ProseTemplate;
	return canonicalProseTemplate([
		...source.parts,
		{ kind: "text", text: ` [${tag}]` },
	]);
}

function translationEntryFor(
	doc: BlueprintDoc,
	unit: TranslationUnit,
	tag: LanguageTag,
): TranslationEntry {
	return {
		value: translatedValue(unit, tag),
		sourceFingerprint: unit.sourceFingerprint,
		origin: "human",
		review: "needs-review",
		translatedFrom: effectiveAppLocalization(doc.localization).sourceLanguage,
	};
}

const setAppName: KindGenerator = (ctx) => [
	batch([{ kind: "setAppName", name: edited(ctx.doc.appName) }]),
];

const setConnectType: KindGenerator = (ctx) => {
	if (ctx.doc.connectType !== null) {
		const plan = planConnectTargetState(ctx.doc, { mode: null });
		return [plan.ok ? batch(plan.mutations) : refusal("connect-target")];
	}
	return take(ctx, formsInOrder(ctx.doc)).map(({ formUuid }) => {
		const learn = ctx.rng.next() < 0.5;
		const plan = planConnectTargetState(
			ctx.doc,
			learn
				? {
						mode: "learn",
						participants: [
							{
								formUuid,
								connect: {
									learn_module: {
										id: ctx.mint.name("edit_learn"),
										name: "Edited learning",
										description: "Edited learning module",
										time_estimate: 5,
									},
								},
							},
						],
					}
				: {
						mode: "deliver",
						participants: [
							{
								formUuid,
								connect: {
									deliver_unit: {
										id: ctx.mint.name("edit_deliver"),
										name: "Edited delivery",
									},
								},
							},
						],
					},
		);
		return plan.ok ? batch(plan.mutations) : refusal("connect-target");
	});
};

const setAppLogo: KindGenerator = (ctx) => [
	...(ctx.doc.logo !== undefined ? [batch(setAppLogoMutations(null))] : []),
	batch(setAppLogoMutations(ctx.mint.mediaId())),
];

/**
 * The source language is relabelled only while it is the app's one language
 * (`relabelSourceLanguage` applies to a single-language app), so a
 * multilingual app first makes the source its default and drops every other
 * language.
 */
const relabelSourceLanguage: KindGenerator = (ctx) => {
	const { sourceLanguage, defaultLanguage, languageOrder } =
		effectiveAppLocalization(ctx.doc.localization);
	const prefix: Mutation[] = [
		...(sourceLanguage === defaultLanguage
			? []
			: [{ kind: "setDefaultLanguage" as const, code: sourceLanguage }]),
		...languageOrder
			.filter((tag) => tag !== sourceLanguage)
			.map((code) => ({ kind: "removeLanguage" as const, code })),
	];
	return freshLanguages(ctx)
		.slice(0, 2)
		.map((language) =>
			batch([...prefix, { kind: "relabelSourceLanguage", language }]),
		);
};

const addLanguage: KindGenerator = (ctx) =>
	freshLanguages(ctx)
		.slice(0, MAX_TARGETS)
		.map((language) => batch([{ kind: "addLanguage", language }]));

const removeLanguage: KindGenerator = (ctx) => {
	const localization = effectiveAppLocalization(ctx.doc.localization);
	const removable = localization.languageOrder.filter(
		(tag) =>
			tag !== localization.sourceLanguage &&
			tag !== localization.defaultLanguage,
	);
	return take(ctx, removable).map((code) =>
		batch([{ kind: "removeLanguage", code }]),
	);
};

const setDefaultLanguage: KindGenerator = (ctx) => {
	const localization = effectiveAppLocalization(ctx.doc.localization);
	const others = localization.languageOrder.filter(
		(tag) => tag !== localization.defaultLanguage,
	);
	if (others.length > 0) {
		return take(ctx, others).map((code) =>
			batch([{ kind: "setDefaultLanguage", code }]),
		);
	}
	return freshLanguages(ctx)
		.slice(0, 1)
		.map((language) =>
			batch([
				{ kind: "addLanguage", language },
				{ kind: "setDefaultLanguage", code: languageTag(language) },
			]),
		);
};

const setTranslation: KindGenerator = (ctx) =>
	targetLanguages(ctx).flatMap(({ prefix, doc, tag }) =>
		take(ctx, collectTranslationUnits(doc), 2).flatMap((unit) => {
			const entry = translationEntryFor(doc, unit, tag);
			if (translationValueIntegrityIssue(unit, entry.value) !== undefined) {
				return [];
			}
			return [
				batch([
					...prefix,
					{ kind: "setTranslation", language: tag, unitId: unit.id, entry },
				]),
			];
		}),
	);

const reviewTranslation: KindGenerator = (ctx) =>
	targetLanguages(ctx).flatMap(({ prefix, doc, tag }) => {
		const stored =
			effectiveAppLocalization(doc.localization).translations[tag] ?? {};
		return take(ctx, collectTranslationUnits(doc), 2).flatMap((unit) => {
			const existing = stored[unit.id];
			const entry = existing ?? translationEntryFor(doc, unit, tag);
			if (translationValueIntegrityIssue(unit, entry.value) !== undefined) {
				return [];
			}
			const write: Mutation[] =
				existing === undefined
					? [{ kind: "setTranslation", language: tag, unitId: unit.id, entry }]
					: [];
			return [
				batch([
					...prefix,
					...write,
					{
						kind: "reviewTranslation",
						language: tag,
						unitId: unit.id,
						expectedSourceFingerprint: entry.sourceFingerprint,
						sourceFingerprint: unit.sourceFingerprint,
						value: entry.value,
					},
				]),
			];
		});
	});

// ── Case-type catalog ────────────────────────────────────────────────

const declareCaseType: KindGenerator = (ctx) => [
	batch([{ kind: "declareCaseType", caseType: ctx.mint.name("edit_type") }]),
];

const retireCaseType: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const moduleTypes = new Set(modulesInOrder(doc).map((m) => m.caseType));
	const unreferenced = caseTypeNames(doc).filter(
		(name) =>
			!moduleTypes.has(name) &&
			referencingCarrierUuids(doc, caseTypeTargetKey(name)).length === 0,
	);
	const out: Candidate[] = take(ctx, unreferenced, 1).map((caseType) =>
		batch([{ kind: "retireCaseType", caseType }]),
	);
	// The editors retire a type as the cascade of removing the module that
	// last manages it (`planCaseTypeRetirementOnRemove`). An app keeps at
	// least one module, so an only module gives way to a new survey menu.
	const birth =
		doc.moduleOrder.length > 1
			? []
			: surveyModuleMutations(doc, { name: "Edited survey" }).mutations;
	const after = docAfter(doc, birth);
	for (const m of take(ctx, modulesInOrder(doc))) {
		const retirement = planCaseTypeRetirementOnRemove(doc, m.uuid);
		if (retirement.kind !== "retire") continue;
		if (planModuleChildDependentsOnRemove(doc, m.uuid).kind !== "clear") {
			continue;
		}
		if (
			planFormLinkDependentsOnRemove(doc, {
				kind: "module",
				moduleUuid: m.uuid,
			}).kind !== "none"
		) {
			continue;
		}
		out.push(
			batch([
				...birth,
				...removeModuleMutations(after, m.uuid),
				...retirement.mutations,
			]),
		);
	}
	return out.slice(0, MAX_TARGETS);
};

const addCaseProperty: KindGenerator = (ctx) =>
	take(ctx, caseTypeNames(ctx.doc)).map((caseType) =>
		batch([
			{
				kind: "addCaseProperty",
				caseType,
				property: {
					name: ctx.mint.name("edit_property"),
					label: proseText("Edited property"),
					data_type: "text",
				},
			},
		]),
	);

const setCaseProperty: KindGenerator = (ctx) => {
	const existing = (ctx.doc.caseTypes ?? []).flatMap((ct) =>
		ct.properties.map((property) => ({ caseType: ct.name, property })),
	);
	if (existing.length === 0) {
		// A type with no property yet gains one, then has it relabelled.
		return take(ctx, caseTypeNames(ctx.doc), 1).map((caseType) => {
			const property = {
				name: ctx.mint.name("edit_property"),
				label: proseText("Edited property"),
			};
			return batch([
				{ kind: "addCaseProperty", caseType, property },
				{
					kind: "setCaseProperty",
					caseType,
					property: {
						...property,
						label: proseText(edited("Edited property")),
					},
				},
			]);
		});
	}
	return forTargets(ctx, existing, ({ caseType, property }) =>
		batch([
			{
				kind: "setCaseProperty",
				caseType,
				property: {
					...structuredClone(property),
					label: proseText(
						edited(proseSource(property.label) || property.name),
					),
				},
			},
		]),
	);
};

const removeCaseProperty: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const unused = (doc.caseTypes ?? []).flatMap((ct) =>
		ct.properties
			.filter(
				(p) => unusedCasePropertyError(doc, ct.name, p.name) === undefined,
			)
			.map((p) => ({ caseType: ct.name, property: p.name })),
	);
	return take(ctx, unused).map(({ caseType, property }) =>
		batch([{ kind: "removeCaseProperty", caseType, property }]),
	);
};

const setCaseTypeMeta: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const out: Candidate[] = [];
	for (const ct of take(ctx, doc.caseTypes ?? [])) {
		if (ct.parent_type !== undefined && ct.relationship === undefined) {
			out.push(
				batch([
					{
						kind: "setCaseTypeMeta",
						caseType: ct.name,
						relationship: "child",
					},
				]),
			);
		}
	}
	const parents = caseTypeNames(doc);
	for (const parent of take(ctx, parents, 1)) {
		const child = ctx.mint.name("edit_type");
		out.push(
			batch([
				{ kind: "declareCaseType", caseType: child },
				{
					kind: "setCaseTypeMeta",
					caseType: child,
					parent_type: parent,
					relationship: "child",
				},
			]),
		);
	}
	return out.slice(0, MAX_TARGETS);
};

const renameCaseProperties: KindGenerator = (ctx) =>
	forTargets(
		ctx,
		(ctx.doc.caseTypes ?? []).flatMap((ct) =>
			authoredProperties(ctx.doc, ct.name).map((p) => ({
				caseType: ct.name,
				from: p.name,
			})),
		),
		({ caseType, from }) =>
			batch([
				{
					kind: "renameCaseProperties",
					renames: [{ caseType, from, to: ctx.mint.name("renamed") }],
				},
			]),
	);

// ── Modules and the case list ────────────────────────────────────────

const addModule: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const out: Candidate[] = [
		batch(surveyModuleMutations(doc, { name: "Edited survey" }).mutations),
	];
	for (const caseType of take(ctx, caseTypeNames(doc), 1)) {
		out.push(batch(caseListModuleMutations(doc, { caseType }).mutations));
	}
	for (const root of take(ctx, rootModules(doc), 1)) {
		out.push(
			batch(
				surveyModuleMutations(doc, {
					name: "Edited child survey",
					parentModuleUuid: root.uuid,
				}).mutations,
			),
		);
	}
	return ctx.rng.shuffle(out);
};

/** The removal batch the SA and Builder compose, or their refusal. */
function moduleRemoval(doc: BlueprintDoc, m: Module): Candidate {
	if (planModuleChildDependentsOnRemove(doc, m.uuid).kind !== "clear") {
		return refusal("module-has-children");
	}
	const retirement = planCaseTypeRetirementOnRemove(doc, m.uuid);
	if (retirement.kind === "blocked") return refusal("case-type-referenced");
	if (
		planFormLinkDependentsOnRemove(doc, { kind: "module", moduleUuid: m.uuid })
			.kind !== "none"
	) {
		return refusal("form-link-dependents");
	}
	return batch([
		...removeModuleMutations(doc, m.uuid),
		...(retirement.kind === "retire" ? retirement.mutations : []),
	]);
}

const removeModule: KindGenerator = (ctx) => {
	const { doc } = ctx;
	if (doc.moduleOrder.length > 1) {
		return forTargets(ctx, modulesInOrder(doc), (m) => moduleRemoval(doc, m));
	}
	// An app keeps at least one module: the only one gives way to a new one.
	const birth = surveyModuleMutations(doc, { name: "Edited survey" }).mutations;
	const after = docAfter(doc, birth);
	return modulesInOrder(doc).map((m) =>
		withPrefix(birth, moduleRemoval(after, m)),
	);
};

const moveModule: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const roots = rootModules(doc);
	const out: Candidate[] = [];
	const last = roots.at(-1);
	if (roots.length >= 2 && last !== undefined) {
		out.push(batch([{ kind: "moveModule", uuid: last.uuid, after: null }]));
	}
	const leafRoots = roots.filter((m) => childrenOf(doc, m.uuid).length === 0);
	for (const mover of take(ctx, leafRoots, 1)) {
		const parent = roots.find((m) => m.uuid !== mover.uuid);
		if (parent === undefined) continue;
		out.push(
			batch([
				{
					kind: "moveModule",
					uuid: mover.uuid,
					parentModuleUuid: parent.uuid,
					after: null,
				},
			]),
		);
	}
	const children = modulesInOrder(doc).filter(
		(m) => m.parentModuleUuid !== undefined,
	);
	for (const child of take(ctx, children, 1)) {
		out.push(
			batch([
				{
					kind: "moveModule",
					uuid: child.uuid,
					parentModuleUuid: null,
					after: roots.at(-1)?.uuid ?? null,
				},
			]),
		);
	}
	if (out.length > 0) return ctx.rng.shuffle(out);
	// A lone module has nowhere to go: land a sibling, then move it after.
	return roots.slice(0, 1).map((m) => {
		const birth = surveyModuleMutations(doc, { name: "Edited survey" });
		return batch([
			...birth.mutations,
			{ kind: "moveModule", uuid: m.uuid, after: birth.moduleUuid },
		]);
	});
};

const renameModule: KindGenerator = (ctx) =>
	take(ctx, modulesInOrder(ctx.doc), MAX_TARGETS, readModule(ctx)).map((m) =>
		batch([{ kind: "renameModule", uuid: m.uuid, newId: edited(m.name) }]),
	);

const updateModule: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const arms: Candidate[] = [];
	for (const m of take(ctx, modulesInOrder(doc), 1, readModule(ctx))) {
		arms.push(
			batch([
				{
					kind: "updateModule",
					uuid: m.uuid,
					patch: { purpose: "Edited purpose" },
				},
			]),
		);
		arms.push(
			batch([
				setModuleDisplayConditionMutation(
					m.uuid,
					eq(sessionUser("user_type"), literal("standard")),
				),
			]),
		);
	}
	for (const m of take(ctx, caseListModules(doc), 1, readModule(ctx))) {
		const search = effectiveCaseSearchConfig(m);
		if (
			search === undefined &&
			!isOwnerOnlyCaseSearchConfig(m.caseSearchConfig)
		) {
			arms.push(batch([enableCaseSearchMutation(m.uuid, m.caseSearchConfig)]));
		} else if (search !== undefined) {
			arms.push(
				batch(
					caseSearchConfigPatchMutations(m.uuid, m.caseSearchConfig, {
						...search,
						searchScreenTitle: "Find records",
					}),
				),
			);
		}
	}
	for (const m of take(
		ctx,
		modulesInOrder(doc).filter(
			(m) => m.caseType !== undefined && m.caseListConfig === undefined,
		),
		1,
	)) {
		arms.push(
			batch([
				{
					kind: "updateModule",
					uuid: m.uuid,
					patch: {},
					ensureCaseListConfig: true,
				},
			]),
		);
	}
	return ctx.rng.shuffle(arms).slice(0, MAX_TARGETS);
};

const setModuleMedia: KindGenerator = (ctx) =>
	take(ctx, modulesInOrder(ctx.doc), MAX_TARGETS, readModule(ctx)).map((m) =>
		batch(
			ctx.rng.next() < 0.5
				? setModuleMediaMutations(
						m.uuid,
						ctx.mint.mediaId(),
						m.audioLabel ?? null,
					)
				: setModuleMediaMutations(m.uuid, m.icon ?? null, ctx.mint.mediaId()),
		),
	);

function freshColumn(ctx: GenContext, m: Module): Column {
	const field = ctx.rng.shuffle(textPropertiesOf(ctx.doc, m.caseType ?? ""))[0];
	return plainColumn(ctx.mint.uuid(), field ?? "case_name", "Edited column");
}

const addColumn: KindGenerator = (ctx) =>
	take(ctx, caseListModules(ctx.doc)).map((m) =>
		batch(addColumnsMutation(m, [freshColumn(ctx, m)]).mutations),
	);

const updateColumn: KindGenerator = (ctx) =>
	forTargets(
		ctx,
		caseListModules(ctx.doc).flatMap((m) =>
			(m.caseListConfig?.columns ?? []).map((column) => ({ m, column })),
		),
		({ m, column }) => {
			const priorities = (m.caseListConfig?.columns ?? []).flatMap((c) =>
				c.sort === undefined ? [] : [c.sort.priority],
			);
			const arm = ctx.rng.int(3);
			const replacement: Column =
				arm === 0 && "header" in column
					? { ...structuredClone(column), header: edited(column.header) }
					: arm === 1 && column.sort === undefined
						? {
								...structuredClone(column),
								sort: {
									direction: "desc",
									priority: Math.max(-1, ...priorities) + 1,
								},
							}
						: {
								...structuredClone(column),
								visibleInDetail: column.visibleInDetail === false,
							};
			const plan = updateColumnMutation(m, column.uuid, replacement);
			return "error" in plan ? refusal("column") : batch(plan.mutations);
		},
	);

const removeColumn: KindGenerator = (ctx) =>
	forTargets(ctx, caseListModules(ctx.doc), (m) => {
		const columns = m.caseListConfig?.columns ?? [];
		if (columns.length >= 2) {
			const column = ctx.rng.shuffle(columns)[0] as Column;
			const plan = removeColumnMutation(m, column.uuid);
			return "error" in plan ? refusal("column") : batch(plan.mutations);
		}
		const added = freshColumn(ctx, m);
		const prefix = addColumnsMutation(m, [added]).mutations;
		const after = docAfter(ctx.doc, prefix).modules[m.uuid];
		const first = columns[0];
		if (after === undefined || first === undefined) return undefined;
		const plan = removeColumnMutation(after, first.uuid);
		return withPrefix(
			prefix,
			"error" in plan ? refusal("column") : batch(plan.mutations),
		);
	});

const moveColumn: KindGenerator = (ctx) =>
	forTargets(ctx, caseListModules(ctx.doc), (m) => {
		let prefix: Mutation[] = [];
		let target = m;
		const visible = () =>
			(target.caseListConfig?.listColumnOrder ?? []).filter(
				(uuid) =>
					target.caseListConfig?.columns.find((c) => c.uuid === uuid)
						?.visibleInList !== false,
			);
		if (visible().length < 2) {
			prefix = addColumnsMutation(m, [freshColumn(ctx, m)]).mutations;
			const after = docAfter(ctx.doc, prefix).modules[m.uuid];
			if (after === undefined) return undefined;
			target = after;
		}
		// The first column moves to the end: a column the document holds
		// wherever it has one, since a born column is appended last.
		const order = visible();
		const first = order[0];
		if (order.length < 2 || first === undefined) return undefined;
		const plan = reorderColumnsMutation(
			target,
			[...order.slice(1), first],
			"list",
		);
		return withPrefix(
			prefix,
			"error" in plan ? refusal("column") : batch(plan.mutations),
		);
	});

function freshSearchInput(ctx: GenContext, m: Module): SearchInputDef {
	const property =
		ctx.rng.shuffle(textPropertiesOf(ctx.doc, m.caseType ?? ""))[0] ??
		"case_name";
	return simpleSearchInputDef(
		ctx.mint.uuid(),
		ctx.mint.name("edit_search"),
		"Edited search",
		"text",
		property,
	);
}

/** Modules whose Search inputs an editor can add to. */
function searchableModules(doc: BlueprintDoc): Module[] {
	return caseListModules(doc).filter(
		(m) => !isOwnerOnlyCaseSearchConfig(m.caseSearchConfig),
	);
}

/**
 * A module with at least `count` Search inputs (of those `counts` accepts), or
 * the prefix adding them.
 */
function withSearchInputs(
	ctx: GenContext,
	m: Module,
	count: number,
	counts: (input: SearchInputDef) => boolean = () => true,
): { prefix: Mutation[]; module: Module } | undefined {
	const have = (m.caseListConfig?.searchInputs ?? []).filter(counts).length;
	if (have >= count) return { prefix: [], module: m };
	const inputs = Array.from({ length: count - have }, () =>
		freshSearchInput(ctx, m),
	);
	const prefix = addSearchInputsMutation(m, inputs).mutations;
	const after = docAfter(ctx.doc, prefix).modules[m.uuid];
	return after === undefined ? undefined : { prefix, module: after };
}

const addSearchInput: KindGenerator = (ctx) =>
	take(ctx, searchableModules(ctx.doc)).map((m) =>
		batch(addSearchInputsMutation(m, [freshSearchInput(ctx, m)]).mutations),
	);

const updateSearchInput: KindGenerator = (ctx) =>
	forTargets(ctx, searchableModules(ctx.doc), (m) => {
		const subject = withSearchInputs(ctx, m, 1, (i) => i.kind !== "hidden");
		if (subject === undefined) return undefined;
		const input = ctx.rng
			.shuffle(subject.module.caseListConfig?.searchInputs ?? [])
			.find((i) => i.kind !== "hidden");
		if (input === undefined) return undefined;
		const plan = updateSearchInputMutation(subject.module, input.uuid, {
			...structuredClone(input),
			label: edited(input.label),
		});
		return withPrefix(
			subject.prefix,
			"error" in plan ? refusal("search-input") : batch(plan.mutations),
		);
	});

const removeSearchInput: KindGenerator = (ctx) =>
	forTargets(ctx, searchableModules(ctx.doc), (m) => {
		const input = ctx.rng.shuffle(m.caseListConfig?.searchInputs ?? [])[0];
		if (input === undefined) return undefined;
		const plan = removeSearchInputMutation(m, input.uuid);
		return "error" in plan ? refusal("search-input") : batch(plan.mutations);
	});

const moveSearchInput: KindGenerator = (ctx) =>
	forTargets(ctx, searchableModules(ctx.doc), (m) => {
		const subject = withSearchInputs(ctx, m, 2);
		if (subject === undefined) return undefined;
		// The first input moves to the end: one the document holds wherever it
		// has one, since a born input is appended last.
		const order = (subject.module.caseListConfig?.searchInputs ?? []).map(
			(i) => i.uuid,
		);
		const first = order[0];
		if (first === undefined) return undefined;
		const plan = reorderSearchInputsMutation(subject.module, [
			...order.slice(1),
			first,
		]);
		return withPrefix(
			subject.prefix,
			"error" in plan ? refusal("search-input") : batch(plan.mutations),
		);
	});

const setCaseListMeta: KindGenerator = (ctx) =>
	forTargets(ctx, caseListModules(ctx.doc), (m) => {
		const arm = ctx.rng.int(3);
		if (arm === 0) {
			const plan = planCaseSelectionChange(
				m,
				m.caseListConfig?.selection === undefined
					? { kind: "multiple", maximum: 10 }
					: undefined,
			);
			return plan.ok ? batch(plan.mutations) : refusal(plan.reason);
		}
		if (arm === 1) {
			return batch([
				{
					kind: "setCaseListMeta",
					uuid: m.uuid,
					patch: { icon: ctx.mint.mediaId() },
				},
			]);
		}
		return batch([
			{
				kind: "setCaseListMeta",
				uuid: m.uuid,
				patch: {
					filter:
						m.caseListConfig?.filter === undefined
							? eq(sessionUser("user_type"), literal("standard"))
							: null,
				},
			},
		]);
	});

// ── Forms and after-submit links ─────────────────────────────────────

const addForm: KindGenerator = (ctx) =>
	forTargets(ctx, modulesInOrder(ctx.doc), (m) => {
		// A Search module's registration form for when nothing matched is
		// the Builder's one-step scaffold (`noMatchesRegistrationFormMutations`).
		if (
			(m.caseListConfig?.searchInputs.length ?? 0) > 0 &&
			ctx.rng.next() < 0.5
		) {
			const plan = noMatchesRegistrationFormMutations(ctx.doc, m.uuid);
			return plan === null ? refusal("no-case-type") : batch(plan.mutations);
		}
		const types =
			m.caseType === undefined
				? (["survey"] as const)
				: (["registration", "followup", "survey"] as const);
		const type = ctx.rng.shuffle(types)[0] ?? "survey";
		const plan = formScaffoldMutations(ctx.doc, m.uuid, type);
		return plan === null ? refusal("module-not-found") : batch(plan.mutations);
	});

const removeForm: KindGenerator = (ctx) =>
	forTargets(ctx, formsInOrder(ctx.doc), ({ moduleUuid, formUuid }) => {
		if (
			planFormLinkDependentsOnRemove(ctx.doc, { kind: "form", formUuid })
				.kind !== "none"
		) {
			return refusal("form-link-dependents");
		}
		const siblings = ctx.doc.formOrder[moduleUuid] ?? [];
		const form = ctx.doc.forms[formUuid];
		if (siblings.length > 1 || form === undefined) {
			return batch(removeFormMutations(ctx.doc, formUuid));
		}
		// A menu's only form gives way to a new form of the same type, so the
		// menu keeps what it needs.
		const birth = formScaffoldMutations(ctx.doc, moduleUuid, form.type);
		if (birth === null) return refusal("module-not-found");
		return batch([
			...birth.mutations,
			...removeFormMutations(docAfter(ctx.doc, birth.mutations), formUuid),
		]);
	});

const moveForm: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const out: Candidate[] = [];
	for (const m of take(
		ctx,
		modulesInOrder(doc).filter((m) => (doc.formOrder[m.uuid] ?? []).length > 1),
		1,
	)) {
		const last = (doc.formOrder[m.uuid] ?? []).at(-1);
		if (last === undefined) continue;
		out.push(
			batch([
				{ kind: "moveForm", uuid: last, toModuleUuid: m.uuid, after: null },
			]),
		);
	}
	for (const { moduleUuid, formUuid } of take(ctx, formsInOrder(doc), 2)) {
		const source = doc.modules[moduleUuid];
		const destination = ctx.rng
			.shuffle(modulesInOrder(doc))
			.find((m) => m.uuid !== moduleUuid && m.caseType === source?.caseType);
		if (destination === undefined) continue;
		out.push(
			batch([
				{
					kind: "moveForm",
					uuid: formUuid,
					toModuleUuid: destination.uuid,
					after: (doc.formOrder[destination.uuid] ?? []).at(-1) ?? null,
				},
			]),
		);
	}
	if (out.length > 0) return out.slice(0, MAX_TARGETS);
	// A module's only form has nowhere to go: scaffold a sibling first, then
	// move the form after it.
	return take(ctx, formsInOrder(doc), 1, readForm(ctx)).flatMap(
		({ moduleUuid, formUuid }) => {
			const form = doc.forms[formUuid];
			if (form === undefined) return [];
			const sibling = formScaffoldMutations(doc, moduleUuid, form.type);
			if (sibling === null) return [];
			return [
				batch([
					...sibling.mutations,
					{
						kind: "moveForm",
						uuid: formUuid,
						toModuleUuid: moduleUuid,
						after: sibling.formUuid,
					},
				]),
			];
		},
	);
};

const renameForm: KindGenerator = (ctx) =>
	take(ctx, formsInOrder(ctx.doc), MAX_TARGETS, readForm(ctx)).flatMap(
		({ formUuid }) => {
			const form = ctx.doc.forms[formUuid];
			return form === undefined
				? []
				: [
						batch(
							updateFormMutations(ctx.doc, formUuid, {
								name: edited(form.name),
							}),
						),
					];
		},
	);

/** A case-creating operation named from one of the form's text answers. */
function freshCreateOperation(
	ctx: GenContext,
	formUuid: Uuid,
	caseType: string,
): CaseOperation | undefined {
	const answer = fieldsInOrder(ctx.doc).find(
		(at) =>
			at.formUuid === formUuid &&
			at.parentUuid === formUuid &&
			at.field.kind === "text",
	);
	if (answer === undefined) return undefined;
	return {
		uuid: ctx.mint.uuid(),
		id: ctx.mint.name("edit_create"),
		action: "create",
		caseType,
		target: { kind: "new" },
		name: term(formField(answer.field.uuid)),
	};
}

const updateForm: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const arms: Candidate[] = [];
	for (const { formUuid } of take(ctx, formsInOrder(doc), 1, readForm(ctx))) {
		arms.push(
			batch(updateFormMutations(doc, formUuid, { purpose: "Edited purpose" })),
		);
		arms.push(
			batch([
				setFormDisplayConditionMutation(
					formUuid,
					eq(sessionUser("user_type"), literal("standard")),
				),
			]),
		);
	}
	for (const { formUuid } of take(ctx, formsInOrder(doc), 2)) {
		const caseType = ctx.rng.shuffle(caseTypeNames(doc))[0];
		if (caseType === undefined) continue;
		const operation = freshCreateOperation(ctx, formUuid, caseType);
		if (operation === undefined) continue;
		const mutations = addCaseOperationMutations(doc, formUuid, operation);
		arms.push(
			mutations.length > 0 ? batch(mutations) : refusal("case-operation"),
		);
	}
	for (const { formUuid } of formsInOrder(doc)) {
		const operation = ctx.rng.shuffle(
			doc.forms[formUuid]?.caseOperations ?? [],
		)[0];
		if (operation === undefined) continue;
		if (ctx.rng.next() < 0.5) {
			const plan = removeCaseOperationMutation(doc, formUuid, operation.uuid);
			arms.push(plan.ok ? batch(plan.mutations) : refusal(plan.reason));
		} else {
			const mutations = updateCaseOperationMutations(doc, formUuid, {
				...structuredClone(operation),
				id: ctx.mint.name("edit_operation"),
			});
			arms.push(
				mutations.length > 0 ? batch(mutations) : refusal("case-operation"),
			);
		}
		break;
	}
	return ctx.rng.shuffle(arms).slice(0, MAX_TARGETS);
};

/** Link destinations from a form: other menus and other forms. */
function linkTargets(doc: BlueprintDoc, formUuid: Uuid): FormLink["target"][] {
	return [
		...modulesInOrder(doc).map((m): FormLink["target"] => ({
			type: "module",
			moduleUuid: m.uuid,
		})),
		...formsInOrder(doc)
			.filter((at) => at.formUuid !== formUuid)
			.map((at): FormLink["target"] => ({
				type: "form",
				moduleUuid: at.moduleUuid,
				formUuid: at.formUuid,
			})),
	];
}

function planLinkBirth(
	ctx: GenContext,
	doc: BlueprintDoc,
	formUuid: Uuid,
	conditional: boolean,
): Candidate {
	const plan = (() => {
		for (const target of ctx.rng.shuffle(linkTargets(doc, formUuid))) {
			const attempt = planFormLinkAdd(doc, formUuid, {
				uuid: ctx.mint.uuid(),
				target,
				...(conditional && { condition: opaqueXPathExpression("1 = 1") }),
			});
			if (attempt.ok) return attempt;
		}
		return undefined;
	})();
	return plan === undefined
		? refusal("form-link-target")
		: batch(plan.mutations);
}

/** Forms with at least `count` links, or the prefix that adds them. */
function withLinks(
	ctx: GenContext,
	formUuid: Uuid,
	count: number,
): { prefix: Mutation[]; doc: BlueprintDoc } | undefined {
	let doc = ctx.doc;
	const prefix: Mutation[] = [];
	while ((doc.forms[formUuid]?.formLinks?.length ?? 0) < count) {
		const birth = planLinkBirth(ctx, doc, formUuid, true);
		if ("refused" in birth) return undefined;
		prefix.push(...birth.mutations);
		doc = docAfter(doc, birth.mutations);
	}
	return { prefix, doc };
}

const addFormLink: KindGenerator = (ctx) =>
	take(ctx, formsInOrder(ctx.doc), MAX_TARGETS, readForm(ctx)).map(
		({ formUuid }) => {
			const arm = ctx.rng.int(3);
			if (arm < 2) return planLinkBirth(ctx, ctx.doc, formUuid, arm === 0);
			// The otherwise destination, as the form settings' fallback picker
			// sets it (`planSetFallback`).
			const target = ctx.rng.shuffle(linkTargets(ctx.doc, formUuid))[0];
			if (target === undefined) return refusal("form-link-target");
			const plan = planSetFallback(ctx.doc, formUuid, {
				kind: "else-link",
				target,
				uuid: ctx.mint.uuid(),
			});
			return plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind);
		},
	);

const updateFormLink: KindGenerator = (ctx) =>
	forTargets(ctx, formsInOrder(ctx.doc), ({ formUuid }) => {
		const subject = withLinks(ctx, formUuid, 1);
		if (subject === undefined) return undefined;
		const link = ctx.rng.shuffle(
			subject.doc.forms[formUuid]?.formLinks ?? [],
		)[0];
		if (link === undefined) return undefined;
		const retarget = ctx.rng
			.shuffle(linkTargets(subject.doc, formUuid))
			.find((t) => JSON.stringify(t) !== JSON.stringify(link.target));
		const next: FormLink =
			retarget !== undefined && ctx.rng.next() < 0.5
				? { ...structuredClone(link), target: retarget }
				: {
						...structuredClone(link),
						condition: opaqueXPathExpression("2 = 2"),
					};
		const plan = planFormLinkUpdate(subject.doc, formUuid, next, link);
		return withPrefix(
			subject.prefix,
			plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind),
		);
	});

const removeFormLink: KindGenerator = (ctx) =>
	forTargets(ctx, formsInOrder(ctx.doc), ({ formUuid }) => {
		const link = ctx.rng.shuffle(ctx.doc.forms[formUuid]?.formLinks ?? [])[0];
		if (link === undefined) return undefined;
		const plan = planFormLinkRemove(ctx.doc, formUuid, link.uuid);
		return plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind);
	});

/**
 * A conditional link moves to the other end of the form's conditional
 * links: one the document holds wherever the form has one.
 */
const moveFormLink: KindGenerator = (ctx) =>
	forTargets(ctx, formsInOrder(ctx.doc), ({ formUuid }) => {
		const subject = withLinks(ctx, formUuid, 2);
		if (subject === undefined) return undefined;
		const links = subject.doc.forms[formUuid]?.formLinks ?? [];
		const conditional = links.filter((link) => link.condition !== undefined);
		const first = conditional[0];
		const last = conditional.at(-1);
		if (first === undefined || last === undefined || first === last) {
			return undefined;
		}
		const mover = conditional.find((link) => held(ctx)(link.uuid)) ?? last;
		const plan = planFormLinkMove(
			subject.doc,
			formUuid,
			mover.uuid,
			links.indexOf(mover === first ? last : first),
		);
		return withPrefix(
			subject.prefix,
			plan.ok ? batch(plan.mutations) : refusal(plan.reason.kind),
		);
	});

const setFormMedia: KindGenerator = (ctx) =>
	take(ctx, formsInOrder(ctx.doc), MAX_TARGETS, readForm(ctx)).flatMap(
		({ formUuid }) => {
			const form = ctx.doc.forms[formUuid];
			if (form === undefined) return [];
			return [
				batch(
					ctx.rng.next() < 0.5
						? setFormMediaMutations(
								formUuid,
								ctx.mint.mediaId(),
								form.audioLabel ?? null,
							)
						: setFormMediaMutations(
								formUuid,
								form.icon ?? null,
								ctx.mint.mediaId(),
							),
				),
			];
		},
	);

// ── Fields and options ───────────────────────────────────────────────

const addField: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const out: Candidate[] = take(ctx, openFieldParents(doc), 2).map(
		({ parentUuid }) =>
			batch(addFieldMutations(doc, { parentUuid, field: freshTextField(ctx) })),
	);
	for (const at of take(ctx, leafFields(doc), 1)) {
		const plan = duplicateFieldMutations(doc, at.field.uuid);
		out.push(
			plan === undefined ? refusal("field-not-found") : batch(plan.mutations),
		);
	}
	// Splitting a form into pages lands its section fields
	// (`splitIntoSections`, the Builder's and the SA's section planner).
	for (const { formUuid } of take(
		ctx,
		formsInOrder(doc).filter((at) => !formIsSectioned(doc, at.formUuid)),
		1,
	)) {
		const root = doc.fieldOrder[formUuid] ?? [];
		const cut = root[Math.floor(root.length / 2)];
		const plan = splitIntoSections(doc, formUuid, {
			...(cut !== undefined && root.length > 1 && { atFieldUuid: cut }),
			titles: [proseText("Edited first page"), proseText("Edited second page")],
		});
		out.push(plan.ok ? batch(plan.mutations) : refusal("sections"));
	}
	return ctx.rng.shuffle(out);
};

const removeField: KindGenerator = (ctx) => {
	const { doc } = ctx;
	// A field something reads cannot go until its readers change.
	const unread = leafFields(doc).filter((at) => !isRead(doc, at.field.uuid));
	const withSiblings = unread.filter(
		(at) => (doc.fieldOrder[at.parentUuid] ?? []).length > 1,
	);
	if (withSiblings.length > 0) {
		return forTargets(ctx, withSiblings, (at) =>
			batch(removeFieldMutations(doc, at.field.uuid)),
		);
	}
	// A parent keeps at least one field: an only child gives way to a new one.
	return take(ctx, unread, 1).map((at) => {
		const prefix = addFieldMutations(doc, {
			parentUuid: at.parentUuid,
			field: freshTextField(ctx),
		});
		return batch([
			...prefix,
			...removeFieldMutations(docAfter(doc, prefix), at.field.uuid),
		]);
	});
};

const moveField: KindGenerator = (ctx) => {
	const { doc } = ctx;
	const out: Candidate[] = [];
	for (const at of take(
		ctx,
		fieldsInOrder(doc).filter((at) => at.index > 0),
		1,
		readField(ctx),
	)) {
		out.push(
			batch([
				{
					kind: "moveField",
					uuid: at.field.uuid,
					toParentUuid: at.parentUuid,
					after: null,
				},
			]),
		);
	}
	for (const at of take(ctx, leafFields(doc), 3, readField(ctx))) {
		const destination = ctx.rng.shuffle(fieldParentsInOrder(doc)).find(
			(p) =>
				p.formUuid === at.formUuid &&
				p.parentUuid !== at.parentUuid &&
				p.parentUuid !== at.field.uuid &&
				fieldPlacementVerdict(doc, {
					uuid: at.field.uuid,
					kind: at.field.kind,
					toParentUuid: p.parentUuid,
				}).ok,
		);
		if (destination === undefined) continue;
		out.push(
			batch([
				{
					kind: "moveField",
					uuid: at.field.uuid,
					toParentUuid: destination.parentUuid,
					after: null,
				},
			]),
		);
		if (out.length >= MAX_TARGETS) break;
	}
	if (out.length > 0) return out;
	// A lone field has nowhere to go: land a sibling first, then move the
	// field after it.
	return take(ctx, fieldsInOrder(doc), 1, readField(ctx)).map((at) => {
		const sibling = freshTextField(ctx);
		return batch([
			...addFieldMutations(doc, { parentUuid: at.parentUuid, field: sibling }),
			{
				kind: "moveField",
				uuid: at.field.uuid,
				toParentUuid: at.parentUuid,
				after: sibling.uuid,
			},
		]);
	});
};

/**
 * A patch for one field of its own kind: a display condition reading an
 * earlier sibling (so the batch has a reader), a label, or its id.
 */
function fieldPatch(ctx: GenContext, at: FieldAt): FieldPatchFor<FieldKind> {
	const field = at.field;
	const reads = leafFields(ctx.doc).find(
		(other) =>
			other.formUuid === at.formUuid &&
			other.parentUuid === at.parentUuid &&
			other.index < at.index,
	);
	if (
		reads !== undefined &&
		fieldKindDeclaresKey(field.kind, "relevant") &&
		!("relevant" in field) &&
		ctx.rng.next() < 0.5
	) {
		const patch: Record<string, unknown> = {
			relevant: {
				parts: [
					{ kind: "field-ref", uuid: reads.field.uuid },
					{ kind: "text", text: " != ''" },
				],
			},
		};
		return patch as FieldPatchFor<FieldKind>;
	}
	if (fieldKindDeclaresKey(field.kind, "label") && "label" in field) {
		const patch: Record<string, unknown> = {
			label: proseText(edited(proseSource(field.label) || field.id)),
		};
		return patch as FieldPatchFor<FieldKind>;
	}
	return { id: `${field.id}_edited` };
}

/**
 * A select moved onto a Project lookup table, as the options-source picker
 * does (`replaceFieldOptionsSourceMutation`).
 */
function lookupSourceCandidate(ctx: GenContext): Candidate | undefined {
	const table = ctx.rng
		.shuffle(ctx.lookup?.definitions ?? [])
		.find(
			(t) =>
				t.columns.filter((column) => column.dataType === "text").length >= 2,
		);
	const select = ordered(
		ctx,
		fieldsInOrder(ctx.doc).filter(
			(at) => inlineOptionsOf(at.field) !== undefined,
		),
		readField(ctx),
	)[0];
	if (table === undefined || select === undefined) return undefined;
	const [value, label] = table.columns.filter(
		(column) => column.dataType === "text",
	);
	if (value === undefined || label === undefined) return undefined;
	if (
		select.field.kind !== "single_select" &&
		select.field.kind !== "multi_select"
	) {
		return undefined;
	}
	return batch([
		replaceFieldOptionsSourceMutation(select.field.uuid, select.field.kind, {
			kind: "lookup",
			tableId: table.id,
			valueColumnId: value.id,
			labelColumnId: label.id,
		}),
	]);
}

const updateField: KindGenerator = (ctx) => {
	const lookupSource = lookupSourceCandidate(ctx);
	if (lookupSource !== undefined && ctx.rng.next() < 0.5) return [lookupSource];
	// One target per field kind first, so every kind's arm gets drawn.
	const byKind = new Map<FieldKind, FieldAt[]>();
	for (const at of fieldsInOrder(ctx.doc)) {
		byKind.set(at.field.kind, [...(byKind.get(at.field.kind) ?? []), at]);
	}
	const kinds = take(ctx, [...byKind.keys()], MAX_TARGETS, (kind) =>
		(byKind.get(kind) ?? []).some(readField(ctx)),
	);
	return kinds.flatMap((kind) => {
		const at = ordered(ctx, byKind.get(kind) ?? [], readField(ctx))[0];
		if (at === undefined) return [];
		return [
			batch(
				updateFieldMutations(
					ctx.doc,
					at.field.uuid,
					at.field.kind,
					fieldPatch(ctx, at),
				),
			),
		];
	});
};

const convertField: KindGenerator = (ctx) =>
	forTargets(
		ctx,
		fieldsInOrder(ctx.doc).filter(
			(at) => getConvertibleTypes(at.field.kind).length > 0,
		),
		(at) => {
			const toKind = ctx.rng.shuffle(getConvertibleTypes(at.field.kind))[0];
			if (toKind === undefined) return undefined;
			const plan = planKindConversion({
				doc: ctx.doc,
				field: at.field,
				toKind,
				...(convertNeedsOptionSeed(at.field, toKind) && {
					optionsSource: {
						kind: "inline" as const,
						options: [freshOption(ctx), freshOption(ctx)],
					},
				}),
			});
			return plan.ok ? batch(plan.mutations) : refusal(plan.blocker.carrier);
		},
		readField(ctx),
	);

const setFieldMedia: KindGenerator = (ctx) =>
	forTargets(
		ctx,
		fieldsInOrder(ctx.doc).filter((at) =>
			fieldKindDeclaresKey(at.field.kind, "label_media"),
		),
		(at) => {
			const current =
				"label_media" in at.field ? at.field.label_media : undefined;
			return batch(
				current !== undefined && ctx.rng.next() < 0.3
					? setFieldMediaMutations(at.field.uuid, "label", null)
					: setFieldMediaMutations(at.field.uuid, "label", {
							image: ctx.mint.mediaId(),
						}),
			);
		},
		readField(ctx),
	);

/** Parents a new question may land under (not a sectioned form's root). */
function openFieldParents(doc: BlueprintDoc) {
	return fieldParentsInOrder(doc).filter(
		({ parentUuid, formUuid }) =>
			fieldPlacementVerdict(doc, { kind: "text", toParentUuid: parentUuid })
				.ok && !(parentUuid === formUuid && formIsSectioned(doc, formUuid)),
	);
}

/**
 * Selects with inline options, the ones something reads first; or, when the
 * document has none, the prefix that adds one with three options.
 */
function selectSubjects(
	ctx: GenContext,
): { prefix: readonly Mutation[]; field: Field }[] {
	const existing = fieldsInOrder(ctx.doc).filter(
		(at) => inlineOptionsOf(at.field) !== undefined,
	);
	if (existing.length > 0) {
		return ordered(ctx, existing, readField(ctx)).map((at) => ({
			prefix: [],
			field: at.field,
		}));
	}
	return take(ctx, openFieldParents(ctx.doc), 1).map(({ parentUuid }) => {
		const field: Field = {
			kind: "single_select",
			uuid: ctx.mint.uuid(),
			id: ctx.mint.name("edit_choice"),
			label: proseText("Edited choice"),
			optionsSource: {
				kind: "inline",
				options: [freshOption(ctx), freshOption(ctx), freshOption(ctx)],
			},
		};
		return {
			prefix: addFieldMutations(ctx.doc, { parentUuid, field }),
			field,
		};
	});
}

/**
 * Candidates for option edits, each after its select's birth if any; with
 * `heldOnly`, only on the document's own selects.
 */
function forSelects(
	ctx: GenContext,
	propose: (field: Field) => Candidate | undefined,
	heldOnly = false,
): Candidate[] {
	const out: Candidate[] = [];
	for (const { prefix, field } of selectSubjects(ctx)) {
		if (heldOnly && prefix.length > 0) continue;
		const candidate = propose(field);
		if (candidate !== undefined) out.push(withPrefix(prefix, candidate));
		if (out.length >= MAX_TARGETS) break;
	}
	return out;
}

const addOption: KindGenerator = (ctx) =>
	forSelects(ctx, (field) =>
		batch([
			{ kind: "addOption", fieldUuid: field.uuid, option: freshOption(ctx) },
		]),
	);

const updateOption: KindGenerator = (ctx) =>
	forSelects(ctx, (field) => {
		const option = ctx.rng.shuffle(inlineOptionsOf(field) ?? [])[0];
		if (option === undefined) return undefined;
		return batch([
			{
				kind: "updateOption",
				fieldUuid: field.uuid,
				uuid: option.uuid,
				option: {
					...structuredClone(option),
					label: proseText(edited(proseSource(option.label) || option.value)),
				},
			},
		]);
	});

const removeOption: KindGenerator = (ctx) =>
	forSelects(
		ctx,
		(field) => {
			const options = inlineOptionsOf(field) ?? [];
			const victim = ctx.rng.shuffle(options)[0];
			if (victim === undefined) return undefined;
			// A select keeps at least two options, so a two-option select gains
			// one before it loses one of its own.
			const grow: Mutation[] =
				options.length > 2
					? []
					: [
							{
								kind: "addOption",
								fieldUuid: field.uuid,
								option: freshOption(ctx),
							},
						];
			return batch([
				...grow,
				{ kind: "removeOption", fieldUuid: field.uuid, uuid: victim.uuid },
			]);
		},
		true,
	);

const moveOption: KindGenerator = (ctx) =>
	forSelects(ctx, (field) => {
		const last = (inlineOptionsOf(field) ?? []).at(-1);
		if (last === undefined) return undefined;
		return batch([
			{
				kind: "moveOption",
				fieldUuid: field.uuid,
				uuid: last.uuid,
				after: null,
			},
		]);
	});

// ── Worker information, roles and personas ───────────────────────────

function userPropertySubjects(ctx: GenContext): {
	prefix: Mutation[];
	doc: BlueprintDoc;
	uuids: Uuid[];
} {
	const existing = ctx.doc.userPropertyOrder ?? [];
	if (existing.length > 0) {
		return { prefix: [], doc: ctx.doc, uuids: [...existing] };
	}
	const uuid = ctx.mint.uuid();
	const prefix = addUserPropertyMutations(ctx.doc, uuid, {
		slug: ctx.mint.name("edit_info"),
		label: "Edited information",
	});
	return { prefix, doc: docAfter(ctx.doc, prefix), uuids: [uuid] };
}

function userTypeSubjects(ctx: GenContext): {
	prefix: Mutation[];
	doc: BlueprintDoc;
	uuids: Uuid[];
} {
	const existing = ctx.doc.userTypeOrder ?? [];
	if (existing.length > 0) {
		return { prefix: [], doc: ctx.doc, uuids: [...existing] };
	}
	const uuid = ctx.mint.uuid();
	const prefix = addUserTypeMutations(ctx.doc, uuid, {
		name: `Edited role ${ctx.mint.name("r")}`,
	});
	return { prefix, doc: docAfter(ctx.doc, prefix), uuids: [uuid] };
}

function personaSubjects(ctx: GenContext): {
	prefix: Mutation[];
	doc: BlueprintDoc;
	uuids: Uuid[];
} {
	const existing = ctx.doc.personaOrder ?? [];
	if (existing.length > 0) {
		return { prefix: [], doc: ctx.doc, uuids: [...existing] };
	}
	const uuid = ctx.mint.uuid();
	const prefix = addPersonaMutations(ctx.doc, uuid, {
		name: `Edited persona ${ctx.mint.name("p")}`,
	});
	return { prefix, doc: docAfter(ctx.doc, prefix), uuids: [uuid] };
}

const addUserProperty: KindGenerator = (ctx) => [
	batch(
		addUserPropertyMutations(ctx.doc, ctx.mint.uuid(), {
			slug: ctx.mint.name("edit_info"),
			label: "Edited information",
		}),
	),
];

const updateUserProperty: KindGenerator = (ctx) => {
	const { prefix, doc, uuids } = userPropertySubjects(ctx);
	return take(ctx, uuids).flatMap((uuid) => {
		const property = userPropertiesOf(doc)[uuid];
		if (property === undefined) return [];
		return [
			batch([
				...prefix,
				{
					kind: "updateUserProperty",
					uuid,
					patch: { label: edited(property.label).slice(0, 60) },
				},
			]),
		];
	});
};

const removeUserProperty: KindGenerator = (ctx) =>
	take(ctx, ctx.doc.userPropertyOrder ?? []).map((uuid) => {
		const plan = removeUserPropertyPlan(ctx.doc, uuid);
		return plan.ok
			? batch(plan.mutations)
			: refusal("user-property-referenced");
	});

const addUserType: KindGenerator = (ctx) => [
	batch(
		addUserTypeMutations(ctx.doc, ctx.mint.uuid(), {
			name: `Edited role ${ctx.mint.name("r")}`,
		}),
	),
];

const updateUserType: KindGenerator = (ctx) => {
	const { prefix, doc, uuids } = userTypeSubjects(ctx);
	return take(ctx, uuids).flatMap((uuid) => {
		const role = userTypesOf(doc)[uuid];
		if (role === undefined) return [];
		return [
			batch([
				...prefix,
				...updateUserTypeMutations(doc, uuid, {
					description: edited(role.description ?? role.name),
				}),
			]),
		];
	});
};

const removeUserType: KindGenerator = (ctx) =>
	take(ctx, ctx.doc.userTypeOrder ?? []).map((uuid) => {
		const plan = removeUserTypePlan(ctx.doc, uuid);
		return plan.ok ? batch(plan.mutations) : refusal("role-held");
	});

const addPersona: KindGenerator = (ctx) => [
	batch(
		addPersonaMutations(ctx.doc, ctx.mint.uuid(), {
			name: `Edited persona ${ctx.mint.name("p")}`,
			...(ctx.doc.userTypeOrder?.[0] !== undefined && {
				userTypeUuid: ctx.doc.userTypeOrder[0],
			}),
		}),
	),
];

const updatePersona: KindGenerator = (ctx) => {
	const { prefix, doc, uuids } = personaSubjects(ctx);
	return take(ctx, uuids).flatMap((uuid) => {
		const persona = personasOf(doc)[uuid];
		if (persona === undefined) return [];
		return [
			batch([
				...prefix,
				...updatePersonaMutations(doc, uuid, {
					description: edited(persona.description ?? persona.name),
				}),
			]),
		];
	});
};

const removePersona: KindGenerator = (ctx) =>
	take(ctx, ctx.doc.personaOrder ?? []).map((uuid) =>
		batch(removePersonaMutations(uuid)),
	);

// ── Organization ─────────────────────────────────────────────────────

function freshLevelMutations(ctx: GenContext, doc: BlueprintDoc, uuid: Uuid) {
	const parent = doc.organizationLevelOrder?.at(-1);
	return addOrganizationLevelMutations(doc, uuid, {
		code: ctx.mint.name("edit_level"),
		name: `Edited level ${ctx.mint.name("l")}`,
		...(parent !== undefined && { parentLevelUuid: parent }),
		caseFlow: { workers: "none", ownsCases: false },
		addressBook: { reach: "whole-organization" },
	});
}

function levelSubjects(ctx: GenContext): {
	prefix: Mutation[];
	doc: BlueprintDoc;
	uuids: Uuid[];
} {
	const existing = ctx.doc.organizationLevelOrder ?? [];
	if (existing.length > 0) {
		return { prefix: [], doc: ctx.doc, uuids: [...existing] };
	}
	const uuid = ctx.mint.uuid();
	const prefix = freshLevelMutations(ctx, ctx.doc, uuid);
	return { prefix, doc: docAfter(ctx.doc, prefix), uuids: [uuid] };
}

function locationPropertySubjects(ctx: GenContext): {
	prefix: Mutation[];
	doc: BlueprintDoc;
	uuids: Uuid[];
} {
	const existing = ctx.doc.locationPropertyOrder ?? [];
	if (existing.length > 0) {
		return { prefix: [], doc: ctx.doc, uuids: [...existing] };
	}
	const levels = levelSubjects(ctx);
	const uuid = ctx.mint.uuid();
	const own = addLocationPropertyMutations(levels.doc, uuid, {
		slug: ctx.mint.name("edit_place_info"),
		label: "Edited place information",
	});
	const prefix = [...levels.prefix, ...own];
	return { prefix, doc: docAfter(ctx.doc, prefix), uuids: [uuid] };
}

const addOrganizationLevel: KindGenerator = (ctx) => [
	batch(freshLevelMutations(ctx, ctx.doc, ctx.mint.uuid())),
];

const updateOrganizationLevel: KindGenerator = (ctx) => {
	const { prefix, doc, uuids } = levelSubjects(ctx);
	return take(ctx, uuids).flatMap((uuid) => {
		const level = organizationLevelsOf(doc)[uuid];
		if (level === undefined) return [];
		return [
			batch([
				...prefix,
				{
					kind: "updateOrganizationLevel",
					uuid,
					patch: { description: edited(level.description ?? level.name) },
				},
			]),
		];
	});
};

const removeOrganizationLevel: KindGenerator = (ctx) =>
	take(ctx, ctx.doc.organizationLevelOrder ?? []).map((uuid) => {
		const plan = removeOrganizationLevelPlan(ctx.doc, uuid);
		return plan.ok ? batch(plan.mutations) : refusal("level-in-use");
	});

const addLocationProperty: KindGenerator = (ctx) => {
	const levels = levelSubjects(ctx);
	return [
		batch([
			...levels.prefix,
			...addLocationPropertyMutations(levels.doc, ctx.mint.uuid(), {
				slug: ctx.mint.name("edit_place_info"),
				label: "Edited place information",
			}),
		]),
	];
};

const updateLocationProperty: KindGenerator = (ctx) => {
	const { prefix, doc, uuids } = locationPropertySubjects(ctx);
	return take(ctx, uuids).flatMap((uuid) => {
		const property = locationPropertiesOf(doc)[uuid];
		if (property === undefined) return [];
		return [
			batch([
				...prefix,
				{
					kind: "updateLocationProperty",
					uuid,
					patch: { label: edited(property.label).slice(0, 60) },
				},
			]),
		];
	});
};

const removeLocationProperty: KindGenerator = (ctx) =>
	take(ctx, ctx.doc.locationPropertyOrder ?? []).map((uuid) =>
		batch(removeLocationPropertyMutations(uuid)),
	);

// ── Automations ──────────────────────────────────────────────────────

function freshAlert(ctx: GenContext, caseType: string): Automation {
	return {
		uuid: ctx.mint.uuid(),
		kind: "conditional-alert",
		name: `Edited alert ${ctx.mint.name("a")}`,
		caseType,
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: ctx.mint.uuid(), kind: "owner" }],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: ctx.mint.uuid(),
					minutesToWait: 5,
					content: {
						kind: "sms",
						message: automationMessageText("Edited reminder"),
					},
				},
			],
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
}

function freshRule(
	ctx: GenContext,
	caseType: string,
	property: string,
): Automation {
	return {
		uuid: ctx.mint.uuid(),
		kind: "case-update",
		name: `Edited rule ${ctx.mint.name("a")}`,
		caseType,
		criteriaOperator: "all",
		criteria: [
			{
				uuid: ctx.mint.uuid(),
				kind: "match-property",
				scope: "case",
				property,
				matchType: "equal",
				value: "stale",
			},
		],
		setupOnlyCriteria: [],
		updates: [
			{
				uuid: ctx.mint.uuid(),
				target: { scope: "case", property },
				value: { kind: "literal", value: "resolved" },
			},
		],
		closeCase: false,
	};
}

function freshAutomation(ctx: GenContext, doc: BlueprintDoc): Automation[] {
	const types = ctx.rng.shuffle(
		modulesInOrder(doc).flatMap((m) =>
			m.caseType === undefined ? [] : [m.caseType],
		),
	);
	const caseType = types[0];
	if (caseType === undefined) return [];
	const property = ctx.rng.shuffle(authoredProperties(doc, caseType))[0];
	return [
		freshAlert(ctx, caseType),
		...(property === undefined
			? []
			: [freshRule(ctx, caseType, property.name)]),
	];
}

function automationSubjects(
	ctx: GenContext,
	count: number,
): { prefix: Mutation[]; doc: BlueprintDoc; uuids: Uuid[] } | undefined {
	const existing = ctx.doc.automationOrder ?? [];
	if (existing.length >= count) {
		return { prefix: [], doc: ctx.doc, uuids: [...existing] };
	}
	const prefix: Mutation[] = [];
	let doc = ctx.doc;
	while ((doc.automationOrder?.length ?? 0) < count) {
		const automation = ctx.rng.shuffle(freshAutomation(ctx, doc))[0];
		if (automation === undefined) return undefined;
		const add: Mutation = {
			kind: "addAutomation",
			automation,
			after: doc.automationOrder?.at(-1) ?? null,
		};
		prefix.push(add);
		doc = docAfter(doc, [add]);
	}
	return { prefix, doc, uuids: [...(doc.automationOrder ?? [])] };
}

const addAutomation: KindGenerator = (ctx) =>
	freshAutomation(ctx, ctx.doc).map((automation) =>
		batch([
			{
				kind: "addAutomation",
				automation,
				after: ctx.doc.automationOrder?.at(-1) ?? null,
			},
		]),
	);

/**
 * The Builder's complete-rule editor saves an automation as its desired
 * state, and `automationChangesForUpdate` derives the granular mutations.
 */
function automationEdit(
	subject: { prefix: readonly Mutation[]; doc: BlueprintDoc },
	uuid: Uuid,
	edit: (automation: Automation) => Automation | undefined,
): Candidate[] {
	const before = automationsOf(subject.doc)[uuid];
	if (before === undefined) return [];
	const after = edit(structuredClone(before));
	if (after === undefined) return [];
	const mutations = automationChangesForUpdate(before, after);
	return mutations.length === 0
		? []
		: [batch([...subject.prefix, ...mutations])];
}

const updateAutomation: KindGenerator = (ctx) => {
	const subject = automationSubjects(ctx, 1);
	if (subject === undefined) return [];
	return take(ctx, subject.uuids).flatMap((uuid) =>
		automationEdit(subject, uuid, (automation) => ({
			...automation,
			name: edited(automation.name).slice(0, 100),
		})),
	);
};

const removeAutomation: KindGenerator = (ctx) =>
	take(ctx, ctx.doc.automationOrder ?? []).flatMap((uuid) => {
		const automation = automationsOf(ctx.doc)[uuid];
		if (automation === undefined) return [];
		return [
			batch([{ kind: "removeAutomation", uuid, targetKind: automation.kind }]),
		];
	});

/**
 * The first automation moves to the end: one the document holds wherever it
 * has one, since a born automation is appended last.
 */
const moveAutomation: KindGenerator = (ctx) => {
	const subject = automationSubjects(ctx, 2);
	if (subject === undefined) return [];
	const first = subject.uuids[0];
	const last = subject.uuids.at(-1);
	const automation =
		first === undefined ? undefined : automationsOf(subject.doc)[first];
	if (first === undefined || last === undefined || automation === undefined) {
		return [];
	}
	return [
		batch([
			...subject.prefix,
			{
				kind: "moveAutomation",
				uuid: first,
				targetKind: automation.kind,
				after: last,
			},
		]),
	];
};

const editAutomationItem: KindGenerator = (ctx) => {
	// An alert can always gain a recipient, so a document holding no
	// automation gets an alert to edit.
	const subject =
		(ctx.doc.automationOrder ?? []).length > 0
			? automationSubjects(ctx, 1)
			: alertSubjects(ctx);
	if (subject === undefined) return [];
	return take(ctx, subject.uuids).flatMap((uuid) =>
		automationEdit(subject, uuid, (automation) => {
			if (automation.kind === "conditional-alert") {
				return {
					...automation,
					recipients: [
						...automation.recipients,
						{
							uuid: ctx.mint.uuid(),
							kind: "user-group",
							hqId: ctx.mint.name("edited_group"),
						},
					],
				};
			}
			const taken = new Set(automation.updates.map((u) => u.target.property));
			const property = authoredProperties(
				subject.doc,
				automation.caseType,
			).find((p) => !taken.has(p.name));
			if (property === undefined) return undefined;
			return {
				...automation,
				updates: [
					...automation.updates,
					{
						uuid: ctx.mint.uuid(),
						target: { scope: "case", property: property.name },
						value: { kind: "literal", value: "edited" },
					},
				],
			};
		}),
	);
};

function freshTimedSchedule(
	ctx: GenContext,
): Extract<Mutation, { kind: "setAutomationSchedule" }>["schedule"] {
	return {
		kind: "timed",
		repeatEvery: 7,
		totalIterations: 2,
		startOffsetDays: 0,
		startDayOfWeek: -1,
		start: { kind: "case-property", property: "date_opened" },
		events: [
			{
				uuid: ctx.mint.uuid(),
				day: 1,
				timing: { kind: "specific-time", time: "09:30" },
				content: {
					kind: "sms",
					message: automationMessageText("Edited timed reminder"),
				},
			},
		],
	};
}

/** Conditional alerts, or the prefix that adds one. */
function alertSubjects(
	ctx: GenContext,
): { prefix: Mutation[]; doc: BlueprintDoc; uuids: Uuid[] } | undefined {
	const alerts = (ctx.doc.automationOrder ?? []).filter(
		(uuid) => automationsOf(ctx.doc)[uuid]?.kind === "conditional-alert",
	);
	if (alerts.length > 0) return { prefix: [], doc: ctx.doc, uuids: alerts };
	const caseType = ctx.rng.shuffle(
		modulesInOrder(ctx.doc).flatMap((m) =>
			m.caseType === undefined ? [] : [m.caseType],
		),
	)[0];
	if (caseType === undefined) return undefined;
	const alert = freshAlert(ctx, caseType);
	const prefix: Mutation[] = [
		{
			kind: "addAutomation",
			automation: alert,
			after: ctx.doc.automationOrder?.at(-1) ?? null,
		},
	];
	return { prefix, doc: docAfter(ctx.doc, prefix), uuids: [alert.uuid] };
}

const setAutomationSchedule: KindGenerator = (ctx) => {
	const subject = alertSubjects(ctx);
	if (subject === undefined) return [];
	return take(ctx, subject.uuids).flatMap((uuid) =>
		automationEdit(subject, uuid, (automation) =>
			automation.kind !== "conditional-alert"
				? undefined
				: {
						...automation,
						schedule:
							automation.schedule.kind === "timed"
								? {
										kind: "immediate",
										events: [
											{
												uuid: ctx.mint.uuid(),
												minutesToWait: 5,
												content: {
													kind: "sms",
													message: automationMessageText("Edited reminder"),
												},
											},
										],
									}
								: freshTimedSchedule(ctx),
					},
		),
	);
};

const updateAutomationSchedule: KindGenerator = (ctx) => {
	const alerts = alertSubjects(ctx);
	if (alerts === undefined) return [];
	return take(ctx, alerts.uuids).flatMap((uuid) => {
		// An alert on an immediate schedule moves to a timed one first.
		let subject = alerts;
		const current = automationsOf(alerts.doc)[uuid];
		if (
			current?.kind === "conditional-alert" &&
			current.schedule.kind !== "timed"
		) {
			const retimed = automationChangesForUpdate(current, {
				...structuredClone(current),
				schedule: freshTimedSchedule(ctx),
			});
			const prefix = [...alerts.prefix, ...retimed];
			subject = {
				prefix,
				doc: docAfter(ctx.doc, prefix),
				uuids: alerts.uuids,
			};
		}
		return automationEdit(subject, uuid, (automation) => {
			if (
				automation.kind !== "conditional-alert" ||
				automation.schedule.kind !== "timed"
			) {
				return undefined;
			}
			const iterations = automation.schedule.totalIterations;
			return {
				...automation,
				schedule: {
					...automation.schedule,
					totalIterations: iterations > 0 ? iterations + 1 : 2,
				},
			};
		});
	});
};

/**
 * The registry: one generator per mutation kind. A kind the reducer gains
 * fails the typecheck here until it is drawn. A `hosted` kind starts with its
 * host's birth on a document that holds none; a removal is never hosted.
 */
export const EDIT_KIND_GENERATORS = {
	addEntryPoint,
	updateEntryPoint,
	removeEntryPoint,
	addModule,
	removeModule,
	moveModule,
	renameModule,
	updateModule,
	addForm,
	removeForm,
	moveForm: hosted(FORM_HOST, moveForm),
	renameForm: hosted(FORM_HOST, renameForm),
	updateForm: hosted(FORM_HOST, updateForm),
	addFormLink: hosted(FORM_HOST, addFormLink),
	updateFormLink: hosted(FORM_HOST, updateFormLink),
	removeFormLink,
	moveFormLink: hosted(FORM_HOST, moveFormLink),
	addField: hosted(FORM_HOST, addField),
	removeField,
	moveField: hosted(FORM_HOST, moveField),
	updateField: hosted(FORM_HOST, updateField),
	convertField: hosted(FORM_HOST, hosted(CONVERTIBLE_HOST, convertField)),
	setAppName,
	setConnectType: hosted(FORM_HOST, setConnectType),
	setAppLogo,
	relabelSourceLanguage,
	addLanguage,
	removeLanguage,
	setDefaultLanguage,
	setTranslation,
	reviewTranslation,
	renameCaseProperties,
	declareCaseType,
	retireCaseType,
	addCaseProperty: hosted(CASE_TYPE_HOST, addCaseProperty),
	setCaseProperty: hosted(CASE_TYPE_HOST, setCaseProperty),
	removeCaseProperty,
	setCaseTypeMeta: hosted(CASE_TYPE_HOST, setCaseTypeMeta),
	addUserProperty,
	updateUserProperty,
	removeUserProperty,
	addUserType,
	updateUserType,
	removeUserType,
	addPersona,
	updatePersona,
	removePersona,
	addOrganizationLevel,
	updateOrganizationLevel,
	removeOrganizationLevel,
	addLocationProperty,
	updateLocationProperty,
	removeLocationProperty,
	addAutomation: hosted(CASE_MODULE_HOST, addAutomation),
	updateAutomation: hosted(CASE_MODULE_HOST, updateAutomation),
	removeAutomation,
	moveAutomation: hosted(CASE_MODULE_HOST, moveAutomation),
	editAutomationItem: hosted(CASE_MODULE_HOST, editAutomationItem),
	setAutomationSchedule: hosted(CASE_MODULE_HOST, setAutomationSchedule),
	updateAutomationSchedule: hosted(CASE_MODULE_HOST, updateAutomationSchedule),
	addColumn: hosted(CASE_LIST_HOST, addColumn),
	updateColumn: hosted(CASE_LIST_HOST, updateColumn),
	removeColumn,
	moveColumn: hosted(CASE_LIST_HOST, moveColumn),
	addSearchInput: hosted(SEARCH_HOST, addSearchInput),
	updateSearchInput: hosted(SEARCH_HOST, updateSearchInput),
	removeSearchInput,
	moveSearchInput: hosted(SEARCH_HOST, moveSearchInput),
	setCaseListMeta: hosted(CASE_LIST_HOST, setCaseListMeta),
	addOption: hosted(FORM_HOST, addOption),
	updateOption: hosted(FORM_HOST, updateOption),
	removeOption,
	moveOption: hosted(FORM_HOST, moveOption),
	setFieldMedia: hosted(FORM_HOST, hosted(LABEL_MEDIA_HOST, setFieldMedia)),
	setModuleMedia,
	setFormMedia: hosted(FORM_HOST, setFormMedia),
} satisfies Record<Mutation["kind"], KindGenerator>;

/** Every mutation kind, in the registry's order. */
export const EDIT_KINDS = Object.keys(
	EDIT_KIND_GENERATORS,
) as Mutation["kind"][];
