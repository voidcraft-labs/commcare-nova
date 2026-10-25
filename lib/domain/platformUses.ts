// lib/domain/platformUses.ts
//
// The detectors over a document: every use of a platform feature
// (`platforms.ts::PLATFORM_FEATURES`), with the owner the use belongs to and
// the site it sits at. The platform rule refuses the structural uses a
// declared platform cannot run, the checker refuses the expression leaves,
// and `contentRunsOn` reduces the same uses to the platforms the content
// allows: what `buildDoc` derives for a fixture, what the declaration planner
// (`lib/doc/platformDeclaration.ts`) declares, and what publish names as a
// narrowing.
//
// Every detector reads a document the gate admitted. Uses come in document
// order: the app's own, then each module in `moduleOrder` (its own uses, its
// columns, its Search fields, then each form in `formOrder` with the form's
// uses and its fields depth first), then each entry point. Within one owner,
// uses follow `PLATFORM_FEATURE_IDS` order.

import type { BlueprintDoc } from "./blueprint";
import { type EntryPointTarget, entryPointInventory } from "./entryPoints";
import {
	type ExpressionContext,
	type LookupTypeIndex,
	slotContext,
} from "./expression/context";
import { serverOnlySearchSlot } from "./expression/profiles";
import { walkSearchRuntimeValues } from "./expression/searchRuntimeValues";
import { effectiveFilterForEmission } from "./expression/simplify";
import { scalarDataType, typeOf } from "./expression/typeChecker";
import type {
	CheckPath,
	Expression,
	ExpressionSlotRef,
} from "./expression/types";
import { walkExpressionNodes } from "./expression/walk";
import type { Field } from "./fields";
import { inlineOptionsOf } from "./fields/selectOptionsSource";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "./localization";
import {
	caseSelectionCardinality,
	effectiveCaseSearchConfig,
	isHiddenSearchInput,
	isVisibleSearchInput,
	type Module,
	moduleOpensOnSearch,
	type SearchInputDef,
	tileCellFor,
	visibleSearchInputs,
} from "./modules";
import {
	expressionLeafFeature,
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	PLATFORMS,
	type Platform,
	type PlatformFeatureId,
	unavailablePlatform,
} from "./platforms";
import { effectivePostSubmit } from "./postSubmit";
import { proseTemplateIsEmpty } from "./prose";
import { expressionSlotValues } from "./referenceSlots";
import { filledProse, TRANSLATION_FILL_ROLES } from "./translationFill";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
} from "./translationUnits";
import type { Uuid } from "./uuid";

export type PlatformFeatureOwner =
	| { readonly kind: "app" }
	| { readonly kind: "module"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  }
	| {
			readonly kind: "field";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
	  }
	| {
			readonly kind: "option";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly fieldUuid: Uuid;
			readonly optionUuid: Uuid;
	  }
	| {
			readonly kind: "column";
			readonly moduleUuid: Uuid;
			readonly columnUuid: Uuid;
	  }
	| {
			readonly kind: "search-input";
			readonly moduleUuid: Uuid;
			readonly inputUuid: Uuid;
	  }
	| { readonly kind: "entry-point"; readonly target: EntryPointTarget };

export type PlatformFeatureSite =
	/** A document path from the owner, as the table's detector names it. */
	| { readonly kind: "slot"; readonly slot: string }
	/** An expression node: its slot and the path to it inside the stored tree. */
	| {
			readonly kind: "expression";
			readonly ref: ExpressionSlotRef;
			readonly path: CheckPath;
	  };

export interface PlatformFeatureUse {
	readonly feature: PlatformFeatureId;
	readonly owner: PlatformFeatureOwner;
	readonly site: PlatformFeatureSite;
}

const FEATURE_ORDER: ReadonlyMap<PlatformFeatureId, number> = new Map(
	PLATFORM_FEATURE_IDS.map((id, index) => [id, index]),
);

const EXPRESSION_FEATURES: ReadonlySet<PlatformFeatureId> = new Set(
	PLATFORM_FEATURE_IDS.filter(
		(id) => PLATFORM_FEATURES[id].channel === "expression",
	),
);

/** The functions a `call` node is a feature by, alone. */
const CALL_FEATURES: ReadonlyMap<string, PlatformFeatureId> = new Map([
	["random", "random-and-unique-id"],
	["uuid", "random-and-unique-id"],
	["sleep", "pause"],
	["json-property", "json-property"],
	["lower-case", "case-conversion"],
	["upper-case", "case-conversion"],
	["replace", "text-pattern"],
]);

/** The session context fields a term is a feature by. */
const SESSION_CONTEXT_FEATURES: ReadonlyMap<string, PlatformFeatureId> =
	new Map([
		["deviceid", "device-id"],
		["appversion", "app-version"],
		["drift", "clock-drift"],
		["applanguage", "app-language"],
	]);

/** The features one expression node is on its own, without typing. */
function contextFreeFeatures(node: Expression): PlatformFeatureId[] {
	const found: PlatformFeatureId[] = [];
	const leaf = expressionLeafFeature(node);
	if (leaf !== undefined) found.push(leaf);
	switch (node.kind) {
		case "now":
			found.push("now");
			break;
		case "today":
			found.push("today");
			break;
		case "matches-pattern":
			found.push("text-pattern");
			break;
		case "term": {
			if (node.term.kind === "session-context") {
				const feature = SESSION_CONTEXT_FEATURES.get(node.term.field);
				if (feature !== undefined) found.push(feature);
			}
			break;
		}
		case "call": {
			const feature = CALL_FEATURES.get(node.fn);
			if (feature !== undefined) found.push(feature);
			break;
		}
		default:
			break;
	}
	return found;
}

/** The argument a `date-as-number` use would read as a number, if the node
 * is such a read: a `call` of `int` or `number`, or a `double` arm. */
function numberReadArgument(node: Expression): Expression | undefined {
	if (node.kind === "call" && (node.fn === "int" || node.fn === "number"))
		return node.args[0];
	if (node.kind === "double") return node.value;
	return undefined;
}

/** Whether a node may be a wanted feature, decided without its context, so
 * a slot builds a typing context only where one of its nodes may be. */
function mayBeWanted(
	node: Expression,
	wanted: (feature: PlatformFeatureId) => boolean,
): boolean {
	return (
		contextFreeFeatures(node).some(wanted) ||
		(wanted("date-as-number") && numberReadArgument(node) !== undefined)
	);
}

/** The features one expression node is, read in its slot's context. */
function nodeFeatures(
	node: Expression,
	ctx: ExpressionContext,
	wanted: (feature: PlatformFeatureId) => boolean,
): PlatformFeatureId[] {
	const found = contextFreeFeatures(node).filter(wanted);
	const argument = numberReadArgument(node);
	if (
		argument !== undefined &&
		wanted("date-as-number") &&
		readsADate(argument, ctx)
	)
		found.push("date-as-number");
	return found;
}

function readsADate(argument: Expression, ctx: ExpressionContext): boolean {
	const data = scalarDataType(typeOf(argument, ctx)?.data);
	return data === "date" || data === "datetime";
}

/** Whether a group's label shows in some language: the containers the XForm
 * builder writes with `appearance="field-list"` read the label as CommCare's
 * localization does, the form builder's fill included, so a translation
 * alone shows a label whose source is blank. */
function groupLabelShows(doc: BlueprintDoc, fieldUuid: Uuid): boolean {
	const unit = snapshotTranslationUnits(doc).get(
		makeTranslationUnitId("field", fieldUuid, "label"),
	);
	if (unit === undefined) return false;
	return effectiveAppLocalization(doc.localization).languageOrder.some(
		(language) => {
			const value = TRANSLATION_FILL_ROLES.has(unit.role)
				? filledProse(doc, unit, language)
				: localizeTranslationUnit(doc, language, unit).effective;
			return typeof value === "string"
				? value.length > 0
				: !proseTemplateIsEmpty(value);
		},
	);
}

function slotUse(
	feature: PlatformFeatureId,
	owner: PlatformFeatureOwner,
	slot: string,
): PlatformFeatureUse {
	return { feature, owner, site: { kind: "slot", slot } };
}

/** Each owner's uses, sorted by feature (stable, so uses of one feature keep
 * the order their slots were walked in). */
function inFeatureOrder(uses: PlatformFeatureUse[]): PlatformFeatureUse[] {
	return uses
		.map((use, index) => ({ use, index }))
		.sort(
			(a, b) =>
				(FEATURE_ORDER.get(a.use.feature) ?? 0) -
					(FEATURE_ORDER.get(b.use.feature) ?? 0) || a.index - b.index,
		)
		.map(({ use }) => use);
}

/** Every use in the document of the named features (all when omitted), in document order. */
export function platformFeatureUses(
	doc: BlueprintDoc,
	options: {
		readonly features?: ReadonlySet<PlatformFeatureId>;
		readonly lookupTables?: LookupTypeIndex;
	} = {},
): PlatformFeatureUse[] {
	const features = options.features;
	const wanted = (feature: PlatformFeatureId) =>
		features === undefined || features.has(feature);
	const lookupTables: LookupTypeIndex = options.lookupTables ?? new Map();
	const walksExpressions = [...EXPRESSION_FEATURES].some(wanted);

	/** The expression uses one owner's stored slots hold, each with the owner
	 * its slot belongs to. */
	const expressionUses = (
		carrier: {
			readonly entity: "field" | "form" | "module";
			readonly uuid: Uuid;
		},
		ownerOf: (ref: ExpressionSlotRef) => PlatformFeatureOwner,
	): PlatformFeatureUse[] => {
		if (!walksExpressions) return [];
		const uses: PlatformFeatureUse[] = [];
		for (const value of expressionSlotValues(doc, carrier)) {
			let candidate = false;
			walkExpressionNodes(value.expression, (node) => {
				if (!candidate && mayBeWanted(node, wanted)) candidate = true;
			});
			if (!candidate) continue;
			const owner = ownerOf(value.ref);
			const visit = (
				node: Expression,
				path: CheckPath,
				nodeCtx: ExpressionContext,
			) => {
				for (const feature of nodeFeatures(node, nodeCtx, wanted))
					uses.push({
						feature,
						owner,
						site: { kind: "expression", ref: value.ref, path },
					});
			};
			const context = slotContext(doc, value.ref, lookupTables);
			if (context === undefined) continue;
			if (serverOnlySearchSlot(context.profile)) {
				// HQ's server evaluates the rest of this slot, which no
				// platform reading describes; a device works out these values
				// before the search runs.
				walkSearchRuntimeValues(
					value.expression,
					context,
					(runtime, valueContext, valuePath) => {
						const deviceContext: ExpressionContext = {
							...valueContext,
							runsOnDevice: true,
						};
						walkExpressionNodes(runtime, (node, path) =>
							visit(node, [...valuePath, ...path], deviceContext),
						);
					},
				);
				continue;
			}
			walkExpressionNodes(value.expression, (node, path) =>
				visit(node, path, context),
			);
		}
		return uses;
	};

	const out: PlatformFeatureUse[] = [];
	const app: PlatformFeatureOwner = { kind: "app" };
	const appUses: PlatformFeatureUse[] = [];
	if (doc.connectType !== null) {
		if (wanted("connect-app"))
			appUses.push(slotUse("connect-app", app, "connectType"));
		if (wanted("connect-location-capture"))
			appUses.push(slotUse("connect-location-capture", app, "connectType"));
	}
	if (doc.logo !== undefined && wanted("app-logo"))
		appUses.push(slotUse("app-logo", app, "logo"));
	if (doc.appSettings.showSavedForms && wanted("saved-forms"))
		appUses.push(slotUse("saved-forms", app, "appSettings.showSavedForms"));
	if (doc.appSettings.showIncompleteForms && wanted("incomplete-forms"))
		appUses.push(
			slotUse("incomplete-forms", app, "appSettings.showIncompleteForms"),
		);
	out.push(...inFeatureOrder(appUses));

	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		out.push(...moduleUses(moduleUuid, module, wanted, expressionUses));
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const formOwner: PlatformFeatureOwner = {
				kind: "form",
				moduleUuid,
				formUuid,
			};
			const formUses: PlatformFeatureUse[] = [];
			if (
				wanted("after-submit-home") &&
				effectivePostSubmit(doc, formUuid) === "app_home"
			)
				formUses.push(slotUse("after-submit-home", formOwner, "postSubmit"));
			formUses.push(
				...expressionUses({ entity: "form", uuid: formUuid }, () => formOwner),
			);
			out.push(...inFeatureOrder(formUses));
			const walkFields = (parentUuid: Uuid) => {
				for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
					const field = doc.fields[fieldUuid];
					if (field === undefined) continue;
					out.push(
						...fieldUses(
							doc,
							{ kind: "field", moduleUuid, formUuid, fieldUuid },
							field,
							wanted,
							expressionUses,
						),
					);
					walkFields(fieldUuid);
				}
			};
			walkFields(formUuid);
		}
	}

	if (wanted("entry-points"))
		for (const item of entryPointInventory(doc))
			out.push(
				slotUse(
					"entry-points",
					{ kind: "entry-point", target: item.target },
					"entryPoint",
				),
			);
	return out;
}

type ExpressionUses = (
	carrier: {
		readonly entity: "field" | "form" | "module";
		readonly uuid: Uuid;
	},
	ownerOf: (ref: ExpressionSlotRef) => PlatformFeatureOwner,
) => PlatformFeatureUse[];

function moduleUses(
	moduleUuid: Uuid,
	module: Module,
	wanted: (feature: PlatformFeatureId) => boolean,
	expressionUses: ExpressionUses,
): PlatformFeatureUse[] {
	const owner: PlatformFeatureOwner = { kind: "module", moduleUuid };
	const list = module.caseListConfig;
	const search = effectiveCaseSearchConfig(module);
	const opensOnSearch = moduleOpensOnSearch(module);
	const own: PlatformFeatureUse[] = [];
	if (opensOnSearch && wanted("search-first"))
		own.push(slotUse("search-first", owner, "caseSearchConfig.searchFirst"));
	if (
		caseSelectionCardinality(module) === "multiple" &&
		wanted("several-cases")
	)
		own.push(slotUse("several-cases", owner, "caseListConfig.selection"));
	if (module.caseListOnly === true && wanted("case-list-menu-item"))
		own.push(slotUse("case-list-menu-item", owner, "caseListOnly"));
	if (list?.tile?.grouping !== undefined && wanted("tile-grouping"))
		own.push(slotUse("tile-grouping", owner, "caseListConfig.tile.grouping"));
	if (
		search !== undefined &&
		(search.searchScreenTitle !== undefined ||
			search.searchScreenSubtitle !== undefined) &&
		wanted("search-screen-text")
	)
		own.push(
			slotUse(
				"search-screen-text",
				owner,
				search.searchScreenTitle !== undefined
					? "caseSearchConfig.searchScreenTitle"
					: "caseSearchConfig.searchScreenSubtitle",
			),
		);
	if (search !== undefined && !opensOnSearch && wanted("search"))
		own.push(slotUse("search", owner, "caseSearchConfig"));
	if (
		search !== undefined &&
		!opensOnSearch &&
		effectiveFilterForEmission(list?.filter) !== undefined &&
		visibleSearchInputs(list?.searchInputs ?? []).length === 0 &&
		wanted("skip-to-results")
	)
		own.push(slotUse("skip-to-results", owner, "caseListConfig.filter"));

	const columnOwner = (columnUuid: Uuid): PlatformFeatureOwner => ({
		kind: "column",
		moduleUuid,
		columnUuid,
	});
	const inputOwner = (inputUuid: Uuid): PlatformFeatureOwner => ({
		kind: "search-input",
		moduleUuid,
		inputUuid,
	});
	const slotOwner = (ref: ExpressionSlotRef): PlatformFeatureOwner => {
		if ("member" in ref && "columnUuid" in ref.member)
			return columnOwner(ref.member.columnUuid);
		if ("member" in ref && "searchInputUuid" in ref.member)
			return inputOwner(ref.member.searchInputUuid);
		return owner;
	};
	const expression = expressionUses(
		{ entity: "module", uuid: moduleUuid },
		slotOwner,
	);
	// Every owner here is the module, one of its columns or one of its search
	// inputs, so the member's uuid (or none) names it.
	const memberUuid = (target: PlatformFeatureOwner): Uuid | undefined =>
		target.kind === "column"
			? target.columnUuid
			: target.kind === "search-input"
				? target.inputUuid
				: undefined;
	const usesByMember = new Map<Uuid | undefined, PlatformFeatureUse[]>();
	for (const use of expression) {
		const key = memberUuid(use.owner);
		const bucket = usesByMember.get(key);
		if (bucket === undefined) usesByMember.set(key, [use]);
		else bucket.push(use);
	}
	const byOwner = (target: PlatformFeatureOwner) =>
		usesByMember.get(memberUuid(target)) ?? [];
	own.push(...byOwner(owner));
	const out = inFeatureOrder(own);

	for (const [index, column] of (list?.columns ?? []).entries()) {
		const target = columnOwner(column.uuid);
		const uses: PlatformFeatureUse[] = [...byOwner(target)];
		const slot = (path: string) => `caseListConfig.columns[${index}].${path}`;
		const cell = tileCellFor(column, list?.tile);
		if (
			cell !== undefined &&
			cell.verticalAlign !== "middle" &&
			wanted("tile-alignment")
		)
			uses.push(slotUse("tile-alignment", target, slot("tile.verticalAlign")));
		if (
			cell !== undefined &&
			(cell.showBorder === true || cell.showShading === true) &&
			wanted("tile-border-and-shading")
		)
			uses.push(
				slotUse(
					"tile-border-and-shading",
					target,
					slot(
						cell.showBorder === true ? "tile.showBorder" : "tile.showShading",
					),
				),
			);
		if (
			column.visibleInList === false &&
			list?.tile === undefined &&
			wanted("column-hidden-from-results")
		)
			uses.push(
				slotUse("column-hidden-from-results", target, slot("visibleInList")),
			);
		if (column.kind === "link" && wanted("link-column"))
			uses.push(slotUse("link-column", target, slot("kind")));
		out.push(...inFeatureOrder(uses));
	}

	for (const [index, input] of (list?.searchInputs ?? []).entries()) {
		const target = inputOwner(input.uuid);
		const uses: PlatformFeatureUse[] = [
			...byOwner(target),
			...searchInputUses(
				input,
				target,
				`caseListConfig.searchInputs[${index}]`,
				wanted,
			),
		];
		out.push(...inFeatureOrder(uses));
	}
	return out;
}

function searchInputUses(
	input: SearchInputDef,
	owner: PlatformFeatureOwner,
	path: string,
	wanted: (feature: PlatformFeatureId) => boolean,
): PlatformFeatureUse[] {
	const uses: PlatformFeatureUse[] = [];
	if (isHiddenSearchInput(input)) {
		if (wanted("hidden-search-field"))
			uses.push(slotUse("hidden-search-field", owner, `${path}.kind`));
		return uses;
	}
	if (!isVisibleSearchInput(input)) return uses;
	const type = "type" in input ? input.type : undefined;
	if (type === "date" && wanted("search-field-single-date"))
		uses.push(slotUse("search-field-single-date", owner, `${path}.type`));
	if (type === "multi-select" && wanted("search-field-multiple-choice"))
		uses.push(slotUse("search-field-multiple-choice", owner, `${path}.type`));
	if (input.hint !== undefined && wanted("search-screen-text"))
		uses.push(slotUse("search-screen-text", owner, `${path}.hint`));
	if (
		(input.required !== undefined || input.validation !== undefined) &&
		wanted("search-field-checks")
	)
		uses.push(
			slotUse(
				"search-field-checks",
				owner,
				input.required !== undefined
					? `${path}.required`
					: `${path}.validation`,
			),
		);
	if (type === "barcode" && wanted("barcode-search-field"))
		uses.push(slotUse("barcode-search-field", owner, `${path}.type`));
	return uses;
}

function fieldUses(
	doc: BlueprintDoc,
	owner: Extract<PlatformFeatureOwner, { kind: "field" }>,
	field: Field,
	wanted: (feature: PlatformFeatureId) => boolean,
	expressionUses: ExpressionUses,
): PlatformFeatureUse[] {
	const uses: PlatformFeatureUse[] = [];
	for (const id of PLATFORM_FEATURE_IDS) {
		if (PLATFORM_FEATURES[id].fieldKind === field.kind && wanted(id))
			uses.push(slotUse(id, owner, "kind"));
	}
	if (
		wanted("question-pages") &&
		(field.kind === "section" ||
			(field.kind === "group" && groupLabelShows(doc, owner.fieldUuid)))
	)
		uses.push(slotUse("question-pages", owner, "kind"));
	if (
		"help_media" in field &&
		field.help_media !== undefined &&
		wanted("help-media")
	)
		uses.push(slotUse("help-media", owner, "help_media"));
	uses.push(
		...expressionUses({ entity: "field", uuid: owner.fieldUuid }, () => owner),
	);
	const sorted = inFeatureOrder(uses);
	if (wanted("choice-media") && "optionsSource" in field) {
		for (const option of inlineOptionsOf(field.optionsSource) ?? []) {
			const media = option.media;
			if (
				media === undefined ||
				(media.image === undefined &&
					media.audio === undefined &&
					media.video === undefined)
			)
				continue;
			sorted.push(
				slotUse(
					"choice-media",
					{ ...owner, kind: "option", optionUuid: option.uuid },
					"media",
				),
			);
		}
	}
	return sorted;
}

/** The uses of features unavailable on any of `platforms`. */
export function unavailableUses(
	doc: BlueprintDoc,
	platforms: readonly Platform[],
): PlatformFeatureUse[] {
	const features = new Set(
		PLATFORM_FEATURE_IDS.filter(
			(id) => unavailablePlatform(id, platforms) !== undefined,
		),
	);
	return features.size === 0 ? [] : platformFeatureUses(doc, { features });
}

/** The platforms on which no use of the content reads `unavailable`; empty
 * when it runs on neither. */
export function contentRunsOn(doc: BlueprintDoc): readonly Platform[] {
	const blocked = new Set(
		unavailableUses(doc, PLATFORMS).flatMap((use) => {
			const platform = unavailablePlatform(use.feature, PLATFORMS);
			return platform === undefined ? [] : [platform];
		}),
	);
	return PLATFORMS.filter((platform) => !blocked.has(platform));
}
