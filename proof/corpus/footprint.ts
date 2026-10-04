/**
 * An edit batch's footprint, and where each document's modules and forms sit
 * on the wire.
 *
 * Proof 5 (locality) compares, between the build of D and the build of D′,
 * every module and form outside the footprint of the batch that made D′
 * from D. The footprint is the entities the batch's mutations touch and every
 * entity the reference index (`lib/doc/referenceIndex.ts`) says reads one of
 * them, read on both D and D′ (a removed reference's old reader and a new
 * reader both change), with what step 1's decisions add (`proof/README.md`,
 * "Step 1's decisions"):
 *
 * - a case-type catalog edit reaches the readers of the case type and
 *   properties it names, and the fields and forms that write those
 *   properties (`declarersOf`);
 * - a translation edit reaches the entity that owns the translated unit
 *   (`collectTranslationUnits`); a unit owned by a case property's option
 *   reaches that property's readers;
 * - a language-catalog edit and a Connect-type edit reach every module and
 *   form, and the app's own record: the expander writes the app's `langs`
 *   and `translations` from the language catalog, and its
 *   `auto_gps_capture` from the Connect type
 *   (`lib/commcare/expander.ts::expandDoc` into
 *   `lib/commcare/hqShells.ts::applicationShell`);
 * - a form reaches the module(s) holding it on either side, since a
 *   module's wire lists its forms;
 * - a no-matches registration form reaches the synthetic module the
 *   emission plan lowers it into (`lib/commcare/emissionPlan.ts`), and so
 *   does its host module, whose case type and id that module carries.
 *
 * And what Nova derives from what a batch edits (the same decisions): a
 * change to a module setting that Nova writes into forms' wire reaches the
 * forms whose wire holds it, on either side (`MODULE_DERIVATIONS`, each
 * cited where Nova reads it):
 *
 * - what names its case selection datum, and what else that datum holds,
 *   reaches the entries that hold the datum: its own case-loading forms'
 *   and those of the modules that select their cases under it
 *   (`selectionNames`, `selectionDatum`, `inlineSearch`);
 * - what only its own case datum holds reaches its own case-loading forms
 *   (`detailConfirm`, `groupingConnection`);
 * - the instances its expressions reach, which every entry of the module
 *   declares, reach its own forms (`ownEntryInstances`);
 * - the menu it is nested under reaches its forms and those of the modules
 *   nested under it (`placeUnderMenu`);
 * - what the entries and frames of the modules nested under it read of its
 *   forms (the datums they align with, `alignedComputedDatums` and
 *   `alignedSelectionDatums`, and the datums its forms share,
 *   `commonFrameDatums`) is read through Nova's own link projection on each
 *   side, so a change to its form list, its names or its first form's case
 *   operations reaches them exactly when it changes what they read (`lib/commcare/formLinkProjection.ts::alignWithRootMenu`,
 *   `moduleFrameChildren`, `previousFrameChildren`, mirroring HQ's
 *   `suite_xml/post_process/workflow.py::WorkflowHelper.get_frame_children`,
 *   which walks every form in the module, and its root module's under
 *   `include_root_module`);
 * - a module that reads an edited entity through a setting its selection
 *   datum prints as an expression (its case list filter, owner exclusion,
 *   or a search-first module's search inputs: the reference index's slot
 *   names which) reaches the datum's entries as a change to it does, since
 *   the entity's name prints into them though the stored setting is
 *   unchanged.
 *
 * A form reached through a setting that a frame carries (an entry datum's
 * id, case type, maximum or function, or a query) brings its readers too:
 * a link that targets it carries its datums. A setting no frame carries
 * (a nodeset, a detail, an instance declaration, a query's content) leaves
 * those links alone.
 *
 * Beside the modules and forms, `app` says whether the batch reaches
 * app-level state no module or form owns: the app's name and logo, the
 * case-type catalog, an app-owned translation, the language catalog and
 * the Connect type, the app's media map, and the profile properties Nova
 * derives from the whole document. The media map
 * lists every asset the document references, so a batch that changes which
 * assets those are (`collectAssetRefs` on D and D′) reaches it wherever the
 * reference sits: a question's, form's or menu's media, or an entity removed
 * with the last reference to an asset. The derived profile properties
 * (`lib/commcare/derivedProfile.ts::derivedProfileProperties`) follow
 * whether any module searches, so a batch that turns the first search on or
 * the last one off reaches them from a module's edit.
 *
 * `wireLayout` gives, for one document, the module sequence the expander
 * emits (`hq.modules`, in order) with each module's forms in order, so a
 * check can name a footprint entity by its position in the app JSON;
 * `wireLanguages` gives its languages in the order of the app's `langs`,
 * each with its Nova tag, so a check pairs a language with itself across an
 * edit by its tag and reads its code at its position.
 */

import { isDeepStrictEqual } from "node:util";
import { produce } from "immer";
import { derivedProfileProperties } from "@/lib/commcare/derivedProfile";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import {
	caseListSessionDatums,
	commonPrefixById,
	entryFrameDatums,
	entrySessionDatums,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { planLanguageWire } from "@/lib/commcare/languageWire";
import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import {
	collectExpressionInstances,
	collectPredicateInstances,
} from "@/lib/commcare/predicate/instances";
import type { SessionDatum } from "@/lib/commcare/session";
import { moduleIsSearchFirst } from "@/lib/commcare/suite/case-search/inlineSearch";
import { searchNeedsSupportingCases } from "@/lib/commcare/suite/case-search/relatedCaseProjection";
import { moduleTypeContext } from "@/lib/commcare/validator/rules/case-list/shared";
import { applyMutations } from "@/lib/doc/mutations";
import {
	declarersOf,
	ensureReferenceIndex,
	planReferenceIndexMaintenance,
	referencingCarrierUuids,
	referencingSlotsOf,
} from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	caseListColumnIsEmitted,
	casePropertyTargetKey,
	caseTypeTargetKey,
	collectTranslationUnits,
	type EntryPointTarget,
	effectiveAppLocalization,
	effectiveCaseSearchConfig,
	emptyCaseListConfig,
	entityTargetKey,
	entryPointByUuid,
	locationTargetKey,
	type Module,
	moduleParent,
	projectedModulePreorder,
	type SearchInputDef,
	type TranslationUnitOwner,
	type Uuid,
	userPropertyTargetKey,
} from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	substituteUnansweredSearchInputsInExpression,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";

/** One module on the wire, in the expander's order. */
export interface WireModule {
	/** The module's uuid; a synthetic module's is derived from its form's. */
	readonly uuid: string;
	/** Its forms, in the order the app JSON lists them. */
	readonly forms: readonly string[];
	/** Set for the hidden module a no-matches registration form lowers into. */
	readonly synthetic?: {
		readonly hostModuleUuid: string;
		readonly formUuid: string;
	};
}

/** Where a document's modules and forms sit in the app JSON Nova emits for it. */
export function wireLayout(doc: BlueprintDoc): WireModule[] {
	const plan = emissionPlan(doc);
	return projectedModulePreorder(plan.doc).map((uuid) => {
		const synthetic = plan.synthetic.get(uuid);
		return {
			uuid,
			forms: [...(plan.doc.formOrder[uuid] ?? [])],
			...(synthetic !== undefined && {
				synthetic: {
					hostModuleUuid: synthetic.hostModuleUuid,
					formUuid: synthetic.formUuid,
				},
			}),
		};
	});
}

/** One language on the wire: its Nova tag, and the code the app's `langs` holds for it. */
export interface WireLanguage {
	readonly tag: string;
	readonly code: string;
}

/**
 * A document's languages in the order the expander writes the app's `langs`
 * (`lib/commcare/localization.ts::commCareLocalization`: the language wire
 * plan over the effective localization, in its `languageOrder`).
 */
export function wireLanguages(doc: BlueprintDoc): WireLanguage[] {
	const localization = effectiveAppLocalization(doc.localization);
	const plan = planLanguageWire(
		localization.languageOrder,
		localization.defaultLanguage,
	);
	return localization.languageOrder.map((tag) => {
		const code = plan.wireCodeByTag.get(tag);
		if (code === undefined) {
			throw new Error(
				`The language wire plan gave the language ${tag} no code, so its place in the app's langs is unknown.`,
			);
		}
		return { tag, code };
	});
}

export interface Footprint {
	/** Whether the batch reaches every module and form (a language-catalog or Connect-type edit). */
	readonly appWide: boolean;
	/**
	 * Whether the batch reaches app-level state no module or form owns: the
	 * app's name, logo, case-type catalog, language catalog, Connect type or
	 * an app-owned translation, the assets its media map lists, or the
	 * profile properties Nova derives.
	 */
	readonly app: boolean;
	/** Every entity in the footprint: modules, forms, fields and the other carriers. */
	readonly entities: readonly string[];
	/** The footprint's modules on either side's wire (synthetic ones by their derived uuid). */
	readonly modules: readonly string[];
	/** The footprint's forms on either side. */
	readonly forms: readonly string[];
}

const APP_WIDE_KINDS: ReadonlySet<Mutation["kind"]> = new Set([
	"addLanguage",
	"removeLanguage",
	"setDefaultLanguage",
	"relabelSourceLanguage",
	"setConnectType",
]);

const APP_LEVEL_KINDS: ReadonlySet<Mutation["kind"]> = new Set([
	"setAppName",
	"setAppLogo",
	"declareCaseType",
	"retireCaseType",
	"addCaseProperty",
	"setCaseProperty",
	"removeCaseProperty",
	"setCaseTypeMeta",
	"renameCaseProperties",
]);

function indexed(doc: BlueprintDoc): BlueprintDoc {
	if (doc.refIndex !== undefined) return doc;
	return produce(doc, (draft) => {
		ensureReferenceIndex(draft as BlueprintDoc);
	});
}

/** Readers of a case type or property, and the declarers of a property, on one side. */
function catalogReaders(
	doc: BlueprintDoc,
	caseType: string,
	property?: string,
): string[] {
	if (property === undefined) {
		const properties =
			doc.caseTypes?.find((type) => type.name === caseType)?.properties ?? [];
		return [
			...referencingCarrierUuids(doc, caseTypeTargetKey(caseType)),
			...properties.flatMap((entry) =>
				catalogReaders(doc, caseType, entry.name),
			),
		];
	}
	return [
		...referencingCarrierUuids(doc, casePropertyTargetKey(caseType, property)),
		...declarersOf(doc, caseType, property),
	];
}

/** The entity a translation unit's owner names, or the readers its owner reaches. */
function translationOwnerEntities(
	doc: BlueprintDoc,
	owner: TranslationUnitOwner,
): string[] {
	switch (owner.kind) {
		case "app":
			return [];
		case "module":
			return [owner.moduleUuid];
		case "form":
			return [owner.formUuid];
		case "field":
		case "select-option":
			return [owner.fieldUuid];
		case "case-list-column":
		case "search-input":
			return [owner.moduleUuid];
		case "case-property-option":
			return catalogReaders(doc, owner.caseType, owner.property);
	}
}

/** The entities one mutation reaches beyond the carriers it re-extracts. */
function decidedEntities(
	mutation: Mutation,
	before: BlueprintDoc,
	after: BlueprintDoc,
): string[] {
	const sides = [before, after];
	switch (mutation.kind) {
		case "declareCaseType":
		case "retireCaseType":
		case "setCaseTypeMeta":
			return sides.flatMap((doc) => catalogReaders(doc, mutation.caseType));
		case "addCaseProperty":
		case "setCaseProperty":
			return sides.flatMap((doc) =>
				catalogReaders(doc, mutation.caseType, mutation.property.name),
			);
		case "removeCaseProperty":
			return sides.flatMap((doc) =>
				catalogReaders(doc, mutation.caseType, mutation.property),
			);
		case "renameCaseProperties":
			return mutation.renames.flatMap((rename) =>
				sides.flatMap((doc) => [
					...catalogReaders(doc, rename.caseType, rename.from),
					...catalogReaders(doc, rename.caseType, rename.to),
				]),
			);
		case "setTranslation":
		case "reviewTranslation":
			return sides.flatMap((doc) =>
				collectTranslationUnits(doc)
					.filter((unit) => unit.id === mutation.unitId)
					.flatMap((unit) => translationOwnerEntities(doc, unit.owner)),
			);
		default:
			return [];
	}
}

/** The form a field sits in, following its parents. */
function formOfField(doc: BlueprintDoc, uuid: string): string | undefined {
	let current: string | undefined = uuid;
	for (let steps = 0; current !== undefined && steps < 10_000; steps += 1) {
		if (doc.forms[current as Uuid] !== undefined) return current;
		current = doc.fieldParent?.[current as Uuid];
	}
	return undefined;
}

/** The module and form an entity of one side sits in, where it has one. */
function placeOf(
	doc: BlueprintDoc,
	uuid: string,
): { module?: string; form?: string } {
	if (doc.modules[uuid as Uuid] !== undefined) return { module: uuid };
	const form =
		doc.forms[uuid as Uuid] !== undefined ? uuid : formOfField(doc, uuid);
	if (form === undefined) return {};
	const module = doc.moduleOrder.find((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).includes(form as Uuid),
	);
	return { form, ...(module !== undefined && { module }) };
}

/**
 * One side of a batch as the wire places it: the emission plan's document,
 * its layout, and the link projection whose entry datums and frames the
 * local suite is written from (`lib/commcare/compiler.ts::compileCcz`
 * projects the same document, with the same lookup naming, through
 * `formLinkProjectionContext`).
 */
interface WireSide {
	readonly wire: BlueprintDoc;
	readonly layout: readonly WireModule[];
	readonly links: FormLinkProjectionContext;
	readonly lookupNaming: LookupWireNaming | undefined;
}

function wireSide(
	doc: BlueprintDoc,
	lookupNaming: LookupWireNaming | undefined,
): WireSide {
	const wire = emissionPlan(doc).doc;
	return {
		wire,
		layout: wireLayout(doc),
		links: formLinkProjectionContext(
			wire,
			lookupNaming === undefined ? {} : { lookupNaming },
		),
		lookupNaming,
	};
}

/** The forms of `modules` on one side of the wire that `keep` admits. */
function formsOf(
	side: WireSide,
	modules: readonly string[],
	keep: (side: WireSide, formUuid: string) => boolean = () => true,
): string[] {
	const wanted = new Set(modules);
	return side.layout.flatMap((module) =>
		wanted.has(module.uuid)
			? module.forms.filter((form) => keep(side, form))
			: [],
	);
}

/**
 * Whether a form's entry selects a case: only a case-loading form's entry
 * holds case selection datums
 * (`lib/commcare/formLinkProjection.ts::selectableDatums` returns none for
 * any other type, as HQ's `get_case_datums_basic_module` selects only for
 * `requires_case()`).
 */
function loadsCase(side: WireSide, formUuid: string): boolean {
	const type = side.wire.forms[formUuid as Uuid]?.type;
	return type !== undefined && CASE_LOADING_FORM_TYPES.has(type);
}

/**
 * The modules that select their cases under `moduleUuid` on one side of the
 * wire, to any depth: each one's selection chain
 * (`formLinkProjection.ts::parentSelectChain`, over `parentCaseModuleUuid`)
 * passes through it.
 */
function selectingUnder(wireDoc: BlueprintDoc, moduleUuid: string): string[] {
	const reached = new Set<string>([moduleUuid]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [uuid, module] of Object.entries(wireDoc.modules)) {
			if (reached.has(uuid)) continue;
			if (
				module.parentCaseModuleUuid !== undefined &&
				reached.has(module.parentCaseModuleUuid)
			) {
				reached.add(uuid);
				grew = true;
			}
		}
	}
	reached.delete(moduleUuid);
	return [...reached];
}

/** The modules nested directly under `moduleUuid` on one side of the wire. */
function childrenOf(wireDoc: BlueprintDoc, moduleUuid: string): string[] {
	return Object.keys(wireDoc.modules).filter(
		(uuid) => moduleParent(wireDoc, uuid as Uuid) === moduleUuid,
	);
}

/** Every module nested under `moduleUuid` on one side of the wire, to any depth. */
function nestedUnder(wireDoc: BlueprintDoc, moduleUuid: string): string[] {
	const reached: string[] = [];
	let frontier = [moduleUuid];
	while (frontier.length > 0) {
		frontier = frontier.flatMap((uuid) => childrenOf(wireDoc, uuid));
		reached.push(...frontier);
	}
	return reached;
}

/** Which of a module's settings' holders a derivation reaches, on one side. */
type Holders = (side: WireSide, moduleUuid: string) => string[];

/** The module's own forms. */
const ownForms: Holders = (side, moduleUuid) => formsOf(side, [moduleUuid]);

/** The module's own case-loading forms. */
const ownCaseForms: Holders = (side, moduleUuid) =>
	formsOf(side, [moduleUuid], loadsCase);

/**
 * The entries that hold the module's case selection datum: its own
 * case-loading forms', and those of every module that selects its cases
 * under it, whose selection chain starts with it (`selectableDatums`). A
 * module nested under it holds its own datum instead: alignment keeps the
 * nested module's datum where one matches by case type and selection, and
 * drops the menu's where none does
 * (`formLinkProjection.ts::alignWithRootMenu`).
 */
const selectionForms: Holders = (side, moduleUuid) =>
	formsOf(
		side,
		[moduleUuid, ...selectingUnder(side.wire, moduleUuid)],
		loadsCase,
	);

/** The module's own forms and those of every module nested under it, to any depth. */
const ownAndNestedForms: Holders = (side, moduleUuid) =>
	formsOf(side, [moduleUuid, ...nestedUnder(side.wire, moduleUuid)]);

/** The forms of the modules nested directly under the module. */
const childForms: Holders = (side, moduleUuid) =>
	formsOf(side, childrenOf(side.wire, moduleUuid));

/**
 * One of the module settings Nova writes into forms' wire: what of the
 * module (on one side of the wire) the holders' wire is written from, the
 * forms whose wire holds it, and whether a frame carries it too. A frame
 * is a stack's `<create>`: an after-submit link or return to a holder
 * carries the holder's entry datums (`formLinkProjection.ts::targetFrameChildren`
 * over `entryFrameDatums`), so a framed setting also reaches every form
 * whose link targets a holder.
 */
interface ModuleDerivation {
	readonly settings: (
		side: WireSide,
		module: Module,
		moduleUuid: Uuid,
	) => unknown;
	readonly holders: Holders;
	readonly framed: boolean;
}

/**
 * What names the module's case selection datum, in every entry that holds
 * it (`selectionForms`):
 *
 * - `caseType`: the datum's case type and nodeset
 *   (`lib/commcare/session.ts::deriveCaseSelectionDatum`), and the ancestor
 *   case type in the inline search of a module that selects under it
 *   (`formLinkProjection.ts::inlineSearchFor`);
 * - `caseListConfig.selection`: the datum's id, its `max-select-value`,
 *   and the actions' case cardinality (`caseSelectionCardinality`, in
 *   `formLinkProjectionContext`), which give the case-loading XForm its
 *   `selectedCaseIdRef`, or its multi-select instance and primary update
 *   (`lib/commcare/expander.ts::expandDoc` passes them only with the form's
 *   own case datum, which only a case-loading entry holds);
 * - `parentCaseModuleUuid`: the selection chain itself, and the claim post
 *   of a module that opens on Search (`buildInlineClaimPost`).
 *
 * A frame carries each datum's id, case type and maximum.
 *
 * The case type reaches no other form of its own module: a registration
 * form's case-name writer names the module's case type, so a batch that
 * changes the one changes the other, and the form with it (the commit gate
 * refuses `CASE_CREATE_NAME_MISSING` otherwise), and a survey form's wire
 * holds no case type.
 */
const selectionNames: ModuleDerivation = {
	settings: (_side, module) => ({
		caseType: module.caseType,
		selection: module.caseListConfig?.selection,
		parentCaseModuleUuid: module.parentCaseModuleUuid,
	}),
	holders: selectionForms,
	framed: true,
};

/**
 * What the case selection datum holds beside its names, in every entry that
 * holds it (`selectionForms`), and no frame does (`toFrameDatum` keeps no
 * nodeset or detail):
 *
 * - `caseListConfig.filter` and `caseSearchConfig.excludedOwnerIds`: the
 *   datum's nodeset (`caseLoadingNodeset`, `inlineSearchNodeset`), and the
 *   inline search's query of a module that opens on Search
 *   (`searchSession.ts::buildSearchQuery`). The nodeset prints no search
 *   input: each is read as the list reads it before any search, with every
 *   input dependency substituted away first
 *   (`lib/commcare/suite/case-list/nodesetFilter.ts::emitNodesetFilter` and
 *   `emitExcludedOwnerFilterExpression`);
 * - `caseListConfig.tile.persistOnForms`: the datum's `detail-persistent`.
 *
 * The instances the filter and owner exclusion reach are declared by every
 * entry of the module (`ownEntryInstances`).
 */
const selectionDatum: ModuleDerivation = {
	settings: (_side, module) => ({
		filter: module.caseListConfig?.filter,
		excludedOwnerIds: module.caseSearchConfig?.excludedOwnerIds,
		persistOnForms: module.caseListConfig?.tile?.persistOnForms,
	}),
	holders: selectionForms,
	framed: false,
};

/**
 * A search input as its `<prompt>` writes it
 * (`lib/commcare/suite/case-search/searchPrompts.ts::buildSearchPrompts`):
 * every slot but its words. The label, the hint, and the required and
 * validation messages land in the app's strings under locale ids that the
 * input's name alone gives, so only whether a hint is shown reaches the
 * prompt.
 */
function promptSettings(input: SearchInputDef): unknown {
	if (input.kind === "hidden") {
		const { label: _label, ...slots } = input;
		return slots;
	}
	const { label: _label, hint, required, validation, ...slots } = input;
	return {
		...slots,
		hint: hint !== undefined,
		required: required === undefined ? undefined : { when: required.when },
		validation: validation?.rule,
	};
}

/**
 * Whether the module opens on Search (`moduleIsSearchFirst`), and the inline
 * search it then runs in every entry that holds its case selection datum.
 * Opening on Search makes that datum read the inline results
 * (`caseSource`), puts the `<query>` before it
 * (`formLinkProjection.ts::withInlineSearchQueries` over `inlineSearchFor`
 * and `lib/commcare/suite/case-search/inlineSearch.ts::buildInlineSearch`),
 * makes each of the module's own entries claim the picked case
 * (`buildInlineClaimPost`), and sends a case-loading form back to the
 * module after submit by default (`lib/domain/postSubmit.ts::defaultPostSubmitOf`;
 * `defaultPostSubmit` gives any other type the app's home either way). The
 * settings are absent on a module that opens on its list, so turning
 * Search first on or off reaches the holders. The query's element and
 * declared instances read of the module:
 *
 * - its search inputs, as their prompts and query clauses write them
 *   (`promptSettings`; `compileForPlatform` also counts the visible ones
 *   for `default_search`, and `buildSearchQuery` reads them for its
 *   `_xpath_query` clauses, prompt defaults and instances);
 * - whether a calculated column it emits reads a related case, which adds
 *   the supporting-case request (`relatedCaseProjection.ts::searchNeedsSupportingCases`);
 * - whether the search screen has a subtitle, which adds a `<description>`
 *   (its words, and the title's, land in the app's strings).
 *
 * The filter and owner exclusion it also sends are `selectionDatum`'s; the
 * calculated columns' instances it declares are `ownEntryInstances`'s, as
 * every entry of the module declares them too; the case type and the
 * ancestor's are `selectionNames`'s; the search button it drops is
 * `ownEntryInstances`'s.
 *
 * A frame carries the query, but never decides a reach here: a module that
 * opens on Search has neither submenus nor modules selecting under it, and
 * every form it holds loads a case
 * (`lib/commcare/validator/rules/case-search/searchFirst.ts`,
 * `SEARCH_FIRST_UNIQUE_INSTANCE` and `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`),
 * and what opens it on Search is an edit of that module, whose readers
 * (every link to one of its forms) the footprint holds already.
 */
const inlineSearch: ModuleDerivation = {
	settings: (side, module) => {
		if (!moduleIsSearchFirst(module)) return undefined;
		const caseList = module.caseListConfig ?? emptyCaseListConfig();
		return {
			prompts: caseList.searchInputs.map(promptSettings),
			supportingCases: searchNeedsSupportingCases(
				caseList,
				moduleTypeContext(module, side.wire),
			),
			description:
				effectiveCaseSearchConfig(module)?.searchScreenSubtitle !== undefined,
		};
	},
	holders: selectionForms,
	framed: false,
};

/**
 * Whether any case list column shows in the detail: the module's own case
 * datum's `detail-confirm`, which `selectableDatums` sets on the datum of
 * the entry's own module alone, and only a case-loading entry holds.
 */
const detailConfirm: ModuleDerivation = {
	settings: (_side, module) =>
		(module.caseListConfig?.columns ?? []).some(
			(column) => column.visibleInDetail !== false,
		),
	holders: ownCaseForms,
	framed: false,
};

/**
 * The tile's grouping connection: the companion `<id>_parent_ids` datum
 * after the case datum of each case-loading entry of the module, which
 * names only its `identifier` (`lib/commcare/session.ts::deriveSessionDatums`
 * reads the entry's own module's grouping, and appends the datum only
 * after a case selection datum); the grouping's header rows reach the
 * module's detail alone. A frame carries the datum's function.
 */
const groupingConnection: ModuleDerivation = {
	settings: (_side, module) =>
		module.caseListConfig?.tile?.grouping?.identifier,
	holders: ownCaseForms,
	framed: true,
};

/**
 * The instances every entry of the module declares from the module's
 * expressions (`lib/commcare/session.ts::deriveEntryDefinition` runs
 * `accumulateCaseLoadingInstances` for each form's entry, whatever its
 * type), in the order it declares them; the expressions themselves print
 * into the case datum's nodeset (`selectionDatum`) or into the module's
 * details:
 *
 * - the filter's and the owner exclusion's, each with its search inputs
 *   substituted away as the nodeset reads it;
 * - the search button's display condition's, on a module that does not
 *   open on Search (`compileCcz` drops it on one that does);
 * - each emitted calculated column's, under the module's search input
 *   instance (`moduleTypeContext`).
 *
 * Each is collected with the document's lookup naming, as `compileCcz`
 * passes it. A module's search input instance changes only with its
 * opening on Search, whose forms all load a case.
 */
const ownEntryInstances: ModuleDerivation = {
	settings: (side, module) => {
		const naming = side.lookupNaming;
		const filter = module.caseListConfig?.filter;
		const owners = module.caseSearchConfig?.excludedOwnerIds;
		const searchInputInstanceId = moduleTypeContext(
			module,
			side.wire,
		).searchInputInstanceId;
		const searchButton = moduleIsSearchFirst(module)
			? undefined
			: effectiveCaseSearchConfig(module)?.searchButtonDisplayCondition;
		const calculated = new Set<string>();
		for (const column of module.caseListConfig?.columns ?? []) {
			if (column.kind !== "calculated" || !caseListColumnIsEmitted(column)) {
				continue;
			}
			for (const id of collectExpressionInstances(
				column.expression,
				naming,
				"suite",
				searchInputInstanceId,
			)) {
				calculated.add(id);
			}
		}
		return {
			filter:
				filter === undefined
					? []
					: [
							...collectPredicateInstances(
								substituteUnansweredSearchInputsInPredicate(filter),
								naming,
							),
						],
			excludedOwnerIds:
				owners === undefined
					? []
					: [
							...collectExpressionInstances(
								substituteUnansweredSearchInputsInExpression(owners),
								naming,
							),
						],
			searchButton:
				searchButton === undefined
					? []
					: [
							...collectPredicateInstances(
								searchButton,
								naming,
								"suite",
								searchInputInstanceId,
							),
						],
			calculatedColumns: [...calculated],
		};
	},
	holders: ownForms,
	framed: false,
};

/**
 * The menu the module is nested under (`parentModuleUuid`): its own
 * entries align with that menu's first form's (`alignWithRootMenu`), and a
 * frame of any form of the module or of a module nested under it begins
 * with the commands and common datums of the menus above it
 * (`formLinkProjection.ts::moduleFrameChildren`, `previousFrameChildren`).
 */
const placeUnderMenu: ModuleDerivation = {
	settings: (_side, module) => module.parentModuleUuid,
	holders: ownAndNestedForms,
	framed: true,
};

/**
 * The datums the entries of the modules nested directly under the module
 * align with (`alignWithRootMenu`): its first form's entry datums, or its
 * case list's when it holds no form (`caseListSessionDatums`), skipping a
 * query. Read through Nova's own projection, so a change to the module's
 * names, its form list, or its first form's case operations reaches the
 * nested forms exactly when it changes what they align with.
 */
function alignedDatums(
	side: WireSide,
	moduleUuid: Uuid,
): readonly SessionDatum[] {
	const first = side.links.formOrder[moduleUuid]?.[0];
	const datums =
		first === undefined
			? caseListSessionDatums(side.wire, side.links, moduleUuid)
			: entrySessionDatums(side.wire, side.links, moduleUuid, first);
	return datums.filter((datum) => datum.query === undefined);
}

/** The forms of the modules nested directly under the module that load a case. */
const childCaseForms: Holders = (side, moduleUuid) =>
	formsOf(side, childrenOf(side.wire, moduleUuid), loadsCase);

/**
 * The computed datums of what the nested modules align with (a new
 * case's, a child case's, the worker record's, a tile grouping's): every
 * entry of a module nested under it carries each one whole, in the place
 * the module's own entry gives it among the selection datums, which changes
 * only with those datums or with these.
 */
const alignedComputedDatums: ModuleDerivation = {
	settings: (side, _module, moduleUuid) =>
		alignedDatums(side, moduleUuid)
			.filter((datum) => datum.nodeset === undefined)
			.map((datum) => ({
				id: datum.id,
				function: datum.function,
				caseType: datum.caseType,
				instanceIds: datum.instanceIds,
			})),
	holders: childForms,
	framed: true,
};

/**
 * The selection datums of what the nested modules align with: a nested
 * entry's own case datum takes one's id where it matches it by case type
 * and selection (`caseSelectionCanFlowBetweenModules`, against the module
 * that supplies it), and is renamed where it shares its id unmatched. Only
 * a case-loading entry holds a case datum to match; any other entry skips
 * them and carries the computed datums alone.
 */
const alignedSelectionDatums: ModuleDerivation = {
	settings: (side, _module, moduleUuid) =>
		alignedDatums(side, moduleUuid)
			.filter((datum) => datum.nodeset !== undefined)
			.map((datum) => ({
				id: datum.id,
				caseType: datum.caseType,
				maxSelectValue: datum.maxSelectValue,
				source: side.links.selectionSourceModules.get(datum),
			})),
	holders: childCaseForms,
	framed: true,
};

/**
 * The datums every form of the module begins its entry with, as a frame
 * reads them (`entryFrameDatums`, whose common prefix by id
 * `commonPrefixById` takes): the frame of a form of the module returning
 * to the previous screen holds them (`baseFormFrameChildren`), and so does
 * every frame of a form of a module nested under it, which starts with
 * the common datums of each menu above it (`moduleFrameChildren`) or,
 * returning to the previous screen, with those its forms share with the
 * menu's (`previousFrameChildren`). This mirrors HQ's
 * `suite_xml/post_process/workflow.py::WorkflowHelper.get_frame_children`,
 * which walks every form of the module, and of its root module under
 * `include_root_module`. Read through Nova's own projection, so a change to
 * the module's form list reaches those forms exactly when the datums its
 * forms share change.
 */
const commonFrameDatums: ModuleDerivation = {
	settings: (side, _module, moduleUuid) =>
		commonPrefixById(
			(side.links.formOrder[moduleUuid] ?? []).map((form) =>
				entryFrameDatums(side.wire, side.links, moduleUuid, form),
			),
		).map(({ renderFunction: _render, ...datum }) => datum),
	holders: ownAndNestedForms,
	framed: true,
};

/** Every module setting Nova writes into forms' wire, with the forms whose wire holds it. */
const MODULE_DERIVATIONS: readonly ModuleDerivation[] = [
	selectionNames,
	selectionDatum,
	inlineSearch,
	detailConfirm,
	groupingConnection,
	ownEntryInstances,
	placeUnderMenu,
	alignedComputedDatums,
	alignedSelectionDatums,
	commonFrameDatums,
];

/**
 * The reference slots (`lib/domain/referenceSlots.ts::MODULE_REFERENCE_SLOTS`)
 * through which a module's case selection datum prints an expression into
 * the entries that hold it: the filter and owner exclusion
 * (`selectionDatum`), and, for a module that opens on Search, every search
 * input's (its inline search runs inside each such entry). The search
 * button's condition and the calculated columns print into the module's
 * details; only the instances they reach enter its entries
 * (`ownEntryInstances`), and what an expression reads never changes those
 * without the expression changing too.
 */
const SELECTION_EXPRESSION_SLOTS: ReadonlySet<string> = new Set([
	"case_list_filter",
	"excluded_owner_ids",
]);

function readsIntoSelection(module: Module, slots: readonly string[]): boolean {
	return slots.some(
		(slot) =>
			SELECTION_EXPRESSION_SLOTS.has(slot) ||
			(slot.startsWith("search_input_") && moduleIsSearchFirst(module)),
	);
}

/**
 * The modules that read one of `keys` (reference-index target keys of what
 * the batch edited) through a slot their case selection prints, on either
 * side: the entity's name prints into the datum's holders though the
 * stored setting is unchanged.
 */
function expressionReaders(
	docs: readonly BlueprintDoc[],
	keys: ReadonlySet<string>,
): Set<string> {
	const found = new Set<string>();
	for (const doc of docs) {
		for (const key of keys) {
			for (const [carrier, slots] of referencingSlotsOf(doc, key)) {
				const module = doc.modules[carrier as Uuid];
				if (module !== undefined && readsIntoSelection(module, slots)) {
					found.add(carrier);
				}
			}
		}
	}
	return found;
}

/** The reference-index target keys of what a batch edits: the touched entities, and the catalog entries its catalog edits name. */
function editedTargetKeys(
	mutations: readonly Mutation[],
	touched: Iterable<string>,
): Set<string> {
	const keys = new Set<string>();
	for (const uuid of touched) {
		keys.add(entityTargetKey(uuid));
		keys.add(userPropertyTargetKey(uuid));
		keys.add(locationTargetKey(uuid));
	}
	for (const mutation of mutations) {
		switch (mutation.kind) {
			case "declareCaseType":
			case "retireCaseType":
			case "setCaseTypeMeta":
				keys.add(caseTypeTargetKey(mutation.caseType));
				break;
			case "addCaseProperty":
			case "setCaseProperty":
				keys.add(
					casePropertyTargetKey(mutation.caseType, mutation.property.name),
				);
				break;
			case "removeCaseProperty":
				keys.add(casePropertyTargetKey(mutation.caseType, mutation.property));
				break;
			case "renameCaseProperties":
				for (const rename of mutation.renames) {
					keys.add(casePropertyTargetKey(rename.caseType, rename.from));
					keys.add(casePropertyTargetKey(rename.caseType, rename.to));
				}
				break;
			default:
				break;
		}
	}
	return keys;
}

/** The forms Nova rewrites from what a batch changed in its modules, and those of them a frame reads. */
interface DerivedForms {
	readonly forms: ReadonlySet<string>;
	readonly framed: ReadonlySet<string>;
}

/**
 * The forms whose wire Nova derives from what the batch changed in its
 * modules (`MODULE_DERIVATIONS`, each reaching the holders of the setting
 * that changed, on either side), with the holders of the expressions the
 * case selection datums of `readers` print (from `expressionReaders`).
 * A holder of a framed setting is also among `framed`.
 */
function moduleDerivedForms(
	before: BlueprintDoc,
	after: BlueprintDoc,
	readers: ReadonlySet<string>,
	lookupNaming: LookupWireNaming | undefined,
): DerivedForms {
	const sides = [wireSide(before, lookupNaming), wireSide(after, lookupNaming)];
	const forms = new Set<string>();
	const framed = new Set<string>();
	const reach = (moduleUuid: string, holders: Holders, isFramed: boolean) => {
		for (const side of sides) {
			if (side.wire.modules[moduleUuid as Uuid] === undefined) continue;
			for (const form of holders(side, moduleUuid)) {
				forms.add(form);
				if (isFramed) framed.add(form);
			}
		}
	};
	const moduleUuids = new Set(
		sides.flatMap((side) => Object.keys(side.wire.modules)),
	);
	for (const moduleUuid of moduleUuids) {
		if (readers.has(moduleUuid)) reach(moduleUuid, selectionForms, false);
		for (const derivation of MODULE_DERIVATIONS) {
			const held = sides.some(
				(side) =>
					side.wire.modules[moduleUuid as Uuid] !== undefined &&
					derivation.holders(side, moduleUuid).length > 0,
			);
			if (!held) continue;
			const [was, now] = sides.map((side) => {
				const module = side.wire.modules[moduleUuid as Uuid];
				return module === undefined
					? undefined
					: derivation.settings(side, module, moduleUuid as Uuid);
			});
			if (!isDeepStrictEqual(was, now)) {
				reach(moduleUuid, derivation.holders, derivation.framed);
			}
		}
	}
	return { forms, framed };
}

/**
 * The footprint of the batch that made `after` from `before`, under the
 * Project lookup data the document is published with (`lookup`, whose
 * naming the instances its modules' expressions reach are read with).
 * Each mutation's carriers are read on the state just before it (a
 * carrier born earlier in the batch does not exist in `before`), and every
 * reader is taken on both D and D′.
 */
export function batchFootprint(
	before: BlueprintDoc,
	after: BlueprintDoc,
	mutations: readonly Mutation[],
	lookup?: LookupFixtureDataSnapshot,
): Footprint {
	const d = indexed(before);
	const dPrime = indexed(after);
	const touched = new Set<string>();
	const decided = new Set<string>();
	let appWide = false;
	let app = false;
	let state = d;
	for (const mutation of mutations) {
		if (APP_WIDE_KINDS.has(mutation.kind)) {
			appWide = true;
			app = true;
		}
		if (APP_LEVEL_KINDS.has(mutation.kind)) app = true;
		for (const carrier of planReferenceIndexMaintenance(state, mutation)
			.carriers) {
			touched.add(carrier);
		}
		const next = produce(state, (draft) => {
			applyMutations(draft, [mutation]);
		});
		for (const uuid of subjectsOf(mutation, state, next)) touched.add(uuid);
		for (const uuid of decidedEntities(mutation, d, dPrime)) {
			decided.add(uuid);
		}
		state = next;
	}
	if (
		mutations.some(
			(m) =>
				(m.kind === "setTranslation" || m.kind === "reviewTranslation") &&
				[d, dPrime].some((doc) =>
					collectTranslationUnits(doc).some(
						(unit) => unit.id === m.unitId && unit.owner.kind === "app",
					),
				),
		)
	) {
		app = true;
	}
	// The app's media map lists every referenced asset, so a batch that
	// attaches, replaces or drops the last reference to one changes it; the
	// derived profile properties follow the whole document.
	if (
		!sameMembers(collectAssetRefs(d), collectAssetRefs(dPrime)) ||
		!isDeepStrictEqual(
			derivedProfileProperties(d),
			derivedProfileProperties(dPrime),
		)
	) {
		app = true;
	}

	// Every entity that reads a touched one, on either side.
	const entities = new Set<string>([...touched, ...decided]);
	const readersOf = (uuids: Iterable<string>): Set<string> => {
		const found = new Set<string>();
		for (const uuid of uuids) {
			for (const doc of [d, dPrime]) {
				for (const key of [
					entityTargetKey(uuid),
					userPropertyTargetKey(uuid),
					locationTargetKey(uuid),
				]) {
					for (const reader of referencingCarrierUuids(doc, key)) {
						found.add(reader);
					}
				}
			}
		}
		return found;
	};
	for (const reader of readersOf(touched)) entities.add(reader);
	// What Nova derives from the batch's modules, and the links that carry
	// a derived form's entry datums in their frames.
	const derived = moduleDerivedForms(
		d,
		dPrime,
		expressionReaders([d, dPrime], editedTargetKeys(mutations, touched)),
		lookup === undefined ? undefined : lookupWireNaming(lookup.definitions),
	);
	for (const form of derived.forms) entities.add(form);
	for (const reader of readersOf(derived.framed)) entities.add(reader);

	const modules = new Set<string>();
	const forms = new Set<string>();
	const layouts = [wireLayout(d), wireLayout(dPrime)];
	if (appWide) {
		for (const layout of layouts) {
			for (const module of layout) {
				modules.add(module.uuid);
				for (const form of module.forms) forms.add(form);
			}
		}
	} else {
		for (const uuid of entities) {
			for (const doc of [d, dPrime]) {
				const place = placeOf(doc, uuid);
				if (place.module !== undefined) modules.add(place.module);
				if (place.form !== undefined) forms.add(place.form);
			}
		}
		for (const layout of layouts) {
			for (const module of layout) {
				if (module.forms.some((form) => forms.has(form))) {
					modules.add(module.uuid);
				}
				if (
					module.synthetic !== undefined &&
					(forms.has(module.synthetic.formUuid) ||
						modules.has(module.synthetic.hostModuleUuid))
				) {
					modules.add(module.uuid);
					forms.add(module.synthetic.formUuid);
				}
			}
		}
	}
	return {
		appWide,
		app,
		entities: [...entities].sort(),
		modules: [...modules].sort(),
		forms: [...forms].sort(),
	};
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((member) => b.has(member));
}

/**
 * Entities a mutation names that the reference index keeps no carrier for,
 * on the states before and after it: an entry point and the module or form
 * hosting it, and a worker-information property or role.
 */
function subjectsOf(
	mutation: Mutation,
	before: BlueprintDoc,
	after: BlueprintDoc,
): string[] {
	const host = (target: EntryPointTarget): string =>
		target.kind === "form" ? target.formUuid : target.moduleUuid;
	const hostOf = (doc: BlueprintDoc, uuid: string): string[] => {
		const item = entryPointByUuid(doc, uuid as Uuid);
		return item === undefined ? [] : [host(item.target)];
	};
	switch (mutation.kind) {
		case "addEntryPoint":
			return [mutation.entryPoint.uuid, host(mutation.target)];
		case "updateEntryPoint":
		case "removeEntryPoint":
			return [
				mutation.entryPointUuid,
				...hostOf(before, mutation.entryPointUuid),
				...hostOf(after, mutation.entryPointUuid),
			];
		case "addUserProperty":
			return [mutation.property.uuid];
		case "addUserType":
			return [mutation.userType.uuid];
		case "updateUserProperty":
		case "removeUserProperty":
		case "updateUserType":
		case "removeUserType":
			return [mutation.uuid];
		default:
			return [];
	}
}
