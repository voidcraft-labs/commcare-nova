/**
 * The expression stage's two halves of the frame: the provisional document,
 * built from the drafts as they stand in every reading, whether or not a
 * finding stands, and the binding of every registered expression against it.
 * A document is replaced, never changed in place: every typing fact and plan
 * is memoized by the document object.
 */

import { freeze } from "immer";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type {
	BlueprintDoc,
	Field,
	Form,
	Module,
	PersistableDoc,
	Uuid,
} from "@/lib/domain";
import { NEW_APP_SETTINGS } from "@/lib/domain/blueprint";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { isContainerKindName } from "@/lib/domain/fields";
import { uniqueSlug } from "@/lib/domain/idSlug";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { inventoryIndex } from "../surface/inventory";
import type { ClaimSite } from "./accounting";
import { withCandidate } from "./candidate";
import { workerRecordWriteSlugs } from "./caseManagement";
import type { ReadContext } from "./context";
import { readerDefect } from "./defects";
import {
	type ExpressionClaim,
	type ExpressionReading,
	readExpressions,
} from "./expressions";
import { slotForm } from "./expressions/readExpression";
import {
	instanceIdsRead,
	unreadDeclarationUse,
} from "./expressions/surfaceUses";
import { pendingPlaceholder } from "./pendingExpressions";
import { appPlace, whereText } from "./place";
import { searchRowUserFields } from "./search";
import { worldEntitiesFromReads } from "./worldEntities";
import { type DraftField, expressionEnvOf, type ReadXForm } from "./xform";

// ── The provisional document ─────────────────────────────────────────────

const PROVISIONAL = new WeakMap<
	ReadContext,
	{ readonly revision: number; readonly doc: BlueprintDoc }
>();

/** A field as the document holds it: its kind's slots, with each required expression slot a
 *  stage has not filled holding the pending placeholder. */
function documentField(field: DraftField, uuid: Uuid): Field {
	/* A question that got a finding stands in under the source's own name: a
	 * Hidden Value for a leaf, a group for a node with children, so a path
	 * another expression reads still binds. */
	if (field.standIn)
		return {
			uuid,
			id: field.id,
			kind: isContainerKindName(field.kind) ? "group" : "hidden",
		} as Field;
	const slots: Record<string, unknown> = {
		...field.field,
		uuid,
		id: field.id,
		kind: field.kind,
	};
	/* A select whose choices got a finding (`xform/options.ts::readChoices`)
	 * holds none: its finding stands for them, and the select keeps its kind,
	 * so every read of its answer binds as it would. */
	if (
		(field.kind === "single_select" || field.kind === "multi_select") &&
		slots.optionsSource === undefined
	)
		slots.optionsSource = { kind: "inline", options: [] };
	if (field.kind === "repeat") {
		if (slots.repeat_mode === "count_bound" && slots.repeat_count === undefined)
			slots.repeat_count = pendingPlaceholder("value");
		if (slots.repeat_mode === "query_bound") {
			const source = slots.data_source as
				| { readonly ids_query?: Expression }
				| undefined;
			if (source?.ids_query === undefined)
				slots.data_source = {
					...source,
					ids_query: pendingPlaceholder("value"),
				};
		}
	}
	return slots as Field;
}

/** Each form's fields, by the order its reading holds them; a field with no UUID is left out
 *  with everything under it, its finding standing for it. */
function addFields(
	xform: ReadXForm,
	parent: DraftField | null,
	parentUuid: Uuid,
	fields: Record<Uuid, Field>,
	fieldOrder: Record<Uuid, Uuid[]>,
): void {
	const order: Uuid[] = [];
	for (const field of xform.childrenOf(parent)) {
		const uuid = field.uuid;
		if (uuid === undefined) continue;
		fields[uuid] = documentField(field, uuid);
		order.push(uuid);
		if (isContainerKindName(field.kind))
			addFields(xform, field, uuid, fields, fieldOrder);
	}
	fieldOrder[parentUuid] = order;
}

/** A slug for a menu or form a stage gave none, as the menu reader mints a menu's: the name,
 *  suffixed past every id already taken. */
function mintedId(
	given: unknown,
	name: string,
	fallback: string,
	taken: Set<string>,
): string {
	if (typeof given === "string") return given;
	const id = uniqueSlug(name, fallback, taken);
	taken.add(id);
	return id;
}

/**
 * `doc` with each menu's and form's id as a reading mints it: no export carries either, so a menu
 * takes `menu`'s slug of its name in the source language, or else in the first language that
 * holds one (`menus/modules.ts::writeMenuIds`), and a form `form`'s slug of its name in the source
 * language (`mintedId`), each suffixed past the ids of its kind before it in menu and form order.
 */
export function menuAndFormIdsAsRead(doc: BlueprintDoc): BlueprintDoc {
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	const source = doc.localization?.sourceLanguage;
	const menuIds = new Set<string>();
	const formIds = new Set<string>();
	const menus = new Map<Uuid, string>();
	const forms = new Map<Uuid, string>();
	for (const moduleUuid of projectedModulePreorder(doc)) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		const unit = makeTranslationUnitId("module", moduleUuid, "name");
		const name =
			module.name !== ""
				? module.name
				: (languageOrder
						.filter((language) => language !== source)
						.map((language) => {
							const value =
								doc.localization?.translations[language]?.[unit]?.value;
							return typeof value === "string" ? value : "";
						})
						.find((text) => text !== "") ?? "");
		const id = uniqueSlug(name, "menu", menuIds);
		menuIds.add(id);
		if (id !== module.id) menus.set(moduleUuid, id);
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const formId = uniqueSlug(form.name, "form", formIds);
			formIds.add(formId);
			if (formId !== form.id) forms.set(formUuid, formId);
		}
	}
	if (menus.size === 0 && forms.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [uuid, id] of menus) {
			const module = draft.modules[uuid];
			if (module !== undefined) module.id = id;
		}
		for (const [uuid, id] of forms) {
			const form = draft.forms[uuid];
			if (form !== undefined) form.id = id;
		}
	});
}

/** The document the drafts give, unfrozen. */
function documentFromDrafts(ctx: ReadContext): BlueprintDoc {
	const { draft, input } = ctx;
	const modules: Record<Uuid, Module> = {};
	const forms: Record<Uuid, Form> = {};
	const fields: Record<Uuid, Field> = {};
	const formOrder: Record<Uuid, Uuid[]> = {};
	const fieldOrder: Record<Uuid, Uuid[]> = {};
	const moduleIds = new Set<string>();
	const formIds = new Set<string>();
	for (const module of draft.modules) {
		if (typeof module.module.id === "string") moduleIds.add(module.module.id);
		for (const form of module.forms)
			if (typeof form.form.id === "string") formIds.add(form.form.id);
	}
	/* A hidden registration menu the menus stage folded is no menu of the
	 * document: its one form is its host's last. */
	const folded = new Set(draft.foldedMenus.map((one) => one.menu));
	const menus = draft.modules.filter((module) => !folded.has(module));
	const present = new Map(menus.map((module) => [module.uuid, module]));
	for (const module of menus) {
		const { parentModuleUuid, ...own } = module.module;
		/* A parent the document does not hold, or one that has a parent of its
		 * own, stands under its own finding; the child is a root here. */
		const parent =
			parentModuleUuid === undefined
				? undefined
				: present.get(parentModuleUuid);
		const name = own.name ?? "";
		modules[module.uuid] = {
			...own,
			uuid: module.uuid,
			id: mintedId(own.id, name, "module", moduleIds),
			name,
			...(parent !== undefined && parent.module.parentModuleUuid === undefined
				? { parentModuleUuid: parent.uuid }
				: {}),
		} as Module;
		const order: Uuid[] = [];
		const hosted = draft.foldedMenus.flatMap((one) =>
			one.hostUuid === module.uuid ? one.menu.forms : [],
		);
		for (const form of [...module.forms, ...hosted]) {
			const formName = form.form.name ?? "";
			forms[form.uuid] = {
				...form.form,
				uuid: form.uuid,
				id: mintedId(form.form.id, formName, "form", formIds),
				name: formName,
				type: form.form.type ?? "survey",
			} as Form;
			order.push(form.uuid);
			if (form.xform === null) fieldOrder[form.uuid] = [];
			else addFields(form.xform, null, form.uuid, fields, fieldOrder);
		}
		formOrder[module.uuid] = order;
	}
	const moduleOrder = projectedModulePreorder({
		modules,
		moduleOrder: menus.map((module) => module.uuid),
	});
	const doc: PersistableDoc = {
		appId: input.appId,
		appName: draft.appName?.value ?? "",
		connectType: draft.connectType,
		caseTypes: draft.caseTypes,
		...(draft.localization === undefined
			? {}
			: { localization: draft.localization }),
		appSettings: {
			showSavedForms:
				draft.appSettings.showSavedForms ?? NEW_APP_SETTINGS.showSavedForms,
			showIncompleteForms:
				draft.appSettings.showIncompleteForms ??
				NEW_APP_SETTINGS.showIncompleteForms,
		},
		...(draft.logo === undefined ? {} : { logo: draft.logo }),
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
		...(draft.levels.length === 0
			? {}
			: {
					organizationLevels: Object.fromEntries(
						draft.levels.map((level) => [level.uuid, level]),
					),
					organizationLevelOrder: draft.levels.map((level) => level.uuid),
				}),
		...(draft.userProperties.length === 0
			? {}
			: {
					userProperties: Object.fromEntries(
						draft.userProperties.map((one) => [one.uuid, one]),
					),
					userPropertyOrder: draft.userProperties.map((one) => one.uuid),
				}),
		...(draft.locationProperties.length === 0
			? {}
			: {
					locationProperties: Object.fromEntries(
						draft.locationProperties.map((one) => [one.uuid, one]),
					),
					locationPropertyOrder: draft.locationProperties.map(
						(one) => one.uuid,
					),
				}),
	} as PersistableDoc;
	return hydratePersistedBlueprint(structuredClone(doc));
}

/**
 * The document the drafts give as they stand: every draft menu, form and field with the slots
 * the stages set, a required expression slot no stage filled holding the pending placeholder, a
 * stand-in where a question got a finding. Deeply frozen, and the same object until a draft is
 * next written (`ReadContext.writeDraft`).
 */
export function provisionalDocument(ctx: ReadContext): BlueprintDoc {
	const known = PROVISIONAL.get(ctx);
	if (known !== undefined && known.revision === ctx.draftRevision)
		return known.doc;
	const doc = freeze(documentFromDrafts(ctx), true);
	PROVISIONAL.set(ctx, { revision: ctx.draftRevision, doc });
	return doc;
}

// ── Binding ──────────────────────────────────────────────────────────────

/** The leaves that read places: what makes a reading's `readsLocations`. */
function readsPlaces(expression: Expression): boolean {
	let found = false;
	walkExpression(expression, {
		visitExpression: (node) => {
			if (node.kind === "locations") found = true;
		},
		visitTerm: (term) => {
			if (
				term.kind === "location-field" ||
				term.kind === "location-level" ||
				term.kind === "owner-location-at-level"
			)
				found = true;
		},
	});
	return found;
}

/** The places above a place, nearest first: its form, its menu, the app. */
function placesAtOrAbove(place: HqPlace): readonly HqPlace[] {
	const app = appPlace();
	switch (place.kind) {
		case "question":
			return [
				place,
				{
					kind: "form",
					menu: place.menu,
					form: place.form,
					menuName: place.menuName,
					name: place.formName,
				},
				{ kind: "menu", menu: place.menu, name: place.menuName },
				app,
			];
		case "form":
			return [
				place,
				{ kind: "menu", menu: place.menu, name: place.menuName },
				app,
			];
		case "case-list":
		case "case-detail":
		case "search":
			return [place, { kind: "menu", menu: place.menu, name: place.name }, app];
		case "app":
			return [place];
		default:
			return [place, app];
	}
}

/** The first finding standing at a place or the nearest place above it. */
function findingAtOrAbove(
	findings: readonly Finding[],
	place: HqPlace,
): Finding | undefined {
	for (const level of placesAtOrAbove(place)) {
		const where = whereText(level);
		const found = findings.find(
			(finding) => whereText(finding.place) === where,
		);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The three nodes of an `<instance>` declaration a claim of it covers: the element, its `id`
 *  and its `src`. */
function declarationSites(
	element: ReadXForm["parsed"]["instances"][number]["element"],
): ClaimSite[] {
	return [
		{ element },
		{ element, attribute: "id" },
		{ element, attribute: "src" },
	];
}

/**
 * Claims each form's `<instance>` declarations, which a form's expressions decide: one no held
 * expression of the form reads under the expression reader's claim of it (`source` -1, matched
 * by the key its `src` names), and one a held expression reads under the entry of that read,
 * the claim of the read whose entry names the declaration's source key. Where that read's entry
 * makes a finding, the declaration stands under that finding.
 */
function claimDeclarations(ctx: ReadContext, reading: ExpressionReading): void {
	const pending = ctx.pending.list();
	const index = inventoryIndex();
	const unread = reading.claims.filter((claim) => claim.source < 0);
	const used = new Set<ExpressionClaim>();
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			if (xform === null) continue;
			const ids = new Set<string>();
			const readClaims: ExpressionClaim[] = [];
			const held = new Set<number>();
			pending.forEach((registration, at) => {
				if (reading.bound[at] === undefined) return;
				if (slotForm(reading.doc, registration.ref) !== form.uuid) return;
				held.add(at);
				for (const id of instanceIdsRead(registration.text)) ids.add(id);
			});
			for (const claim of reading.claims)
				if (held.has(claim.source)) readClaims.push(claim);
			const where = whereText(form.place);
			for (const [id, src] of xform.instanceSources) {
				const declaration = xform.parsed.instances.find(
					(instance) => instance.id === id,
				);
				if (declaration === undefined) continue;
				const key = unreadDeclarationUse(src).key;
				if (!ids.has(id)) {
					const claim = unread.find(
						(one) =>
							!used.has(one) &&
							one.key === key &&
							whereText(one.place) === where,
					);
					if (claim === undefined) continue;
					used.add(claim);
					for (const site of declarationSites(declaration.element))
						ctx.accounting.claimEntry(
							site,
							claim.entryId,
							key,
							form.place,
							claim.detail,
						);
					continue;
				}
				const read = readClaims.find(
					(claim) =>
						index.entry(claim.entryId)?.surfaceKeys.includes(key) === true,
				);
				if (read === undefined) continue;
				const standing = index.entry(read.entryId)?.standing;
				if (
					standing === "held" ||
					standing === "inert" ||
					standing === "kept"
				) {
					for (const site of declarationSites(declaration.element))
						ctx.accounting.claimEntry(site, read.entryId, key, form.place);
					continue;
				}
				const finding = ctx.accounting
					.findings()
					.find(
						(one) =>
							one.code === read.entryId &&
							whereText(one.place) === whereText(read.place),
					);
				if (finding === undefined) continue;
				for (const site of declarationSites(declaration.element))
					ctx.accounting.cover(site, finding);
			}
		}
}

/** The slot a registration names and its owner's identity, for the invariant C10. */
function slotWords(ref: {
	readonly slot: string;
	readonly entity: string;
}): string {
	const uuid = (ref as { readonly uuid?: string }).uuid ?? ref.entity;
	return `${ref.slot} of ${uuid}`;
}

/** By reading, each refused registration whose refusal waits for its registrar
 *  (`PendingExpression.deferRefusal`), with the steps that apply the refusal. */
const DEFERRED = new WeakMap<ReadContext, Map<number, (() => void)[]>>();

/** Whether the expression stage refused the registration at `index` and its refusal waits for
 *  the stage that registered it. */
export function refusalDeferred(ctx: ReadContext, index: number): boolean {
	return DEFERRED.get(ctx)?.has(index) === true;
}

/** Whether a refusal that waits for its registrar stands at `place`: a check that is skipped
 *  where a finding stands there skips where one will. */
export function refusalDeferredAt(ctx: ReadContext, place: HqPlace): boolean {
	const where = whereText(place);
	const pending = ctx.pending.list();
	return [...(DEFERRED.get(ctx)?.keys() ?? [])].some(
		(index) =>
			pending[index] !== undefined && whereText(pending[index].place) === where,
	);
}

/**
 * Settles the refusal of the registration at `index` that waited for its registrar: with no
 * `instead`, the expression stage's claims and rows are applied as they were; with `instead`, a
 * finding the registrar raised for what keeps the slot out, the registration's node stands under
 * it and the expression stage's refusal is dropped.
 */
export function settleDeferredRefusal(
	ctx: ReadContext,
	index: number,
	instead?: Finding,
): void {
	const steps = DEFERRED.get(ctx)?.get(index);
	if (steps === undefined) return;
	DEFERRED.get(ctx)?.delete(index);
	if (instead === undefined) for (const step of steps) step();
	else ctx.accounting.cover(ctx.pending.site(index).at, instead);
}

/** Applies every refusal still waiting for its registrar, as the expression stage made it. */
export function settleDeferredRefusals(ctx: ReadContext): void {
	for (const index of [...(DEFERRED.get(ctx)?.keys() ?? [])])
		settleDeferredRefusal(ctx, index);
}

/** One claim of an expression reading, applied to the node `at` its registration was read from. */
export function applyExpressionClaim(
	ctx: ReadContext,
	claim: ExpressionReading["claims"][number],
	at: ClaimSite,
): void {
	ctx.accounting.claimEntry(
		at,
		claim.entryId,
		claim.key,
		claim.place,
		claim.detail,
	);
}

/** One `unrecognized` row of an expression reading: the finding, the defect that says the reader
 *  could not write the slot back, and, where the row's registration was read from a node `at`,
 *  that node covered by the finding. */
export function applyExpressionCircumstance(
	ctx: ReadContext,
	row: ExpressionReading["circumstances"][number],
	at: ClaimSite | undefined,
): void {
	const detail = { name: row.detail.name };
	ctx.accounting.circumstance("unrecognized", row.place, detail);
	ctx.accounting.defect(
		row.place,
		row.detail.name,
		readerDefect.expressionNotWrittenBack(row.place, row.detail.reason),
	);
	if (row.detail.reason === "no-case-datum")
		ctx.accounting.defect(
			row.place,
			row.detail.name,
			readerDefect.noCaseDatum(row.place),
		);
	if (at !== undefined)
		ctx.accounting.cover(
			at,
			circumstanceFinding("unrecognized", row.place, detail),
		);
}

/**
 * Applies the expression stage's answer: the bound document becomes `ctx.doc`, each held tree and
 * the level it was held at become its registration's outcome, each claim is applied to the node its
 * registration was read from, each `unrecognized` row is raised and
 * covers its node, each registration with no owner stands under the finding at or above its
 * place, and the run's tables, rewrites and rounds join the reading's facts. A refusal whose
 * registration defers it (`PendingExpression.deferRefusal`) waits for its registrar's settle
 * (`settleDeferredRefusal`).
 */
export function applyExpressionReading(
	ctx: ReadContext,
	reading: ExpressionReading,
): void {
	ctx.doc = freeze(reading.doc, true);
	ctx.pending.answer(reading.bound, reading.claims, reading.levels);
	const pending = ctx.pending.list();
	// A refusal its registrar settles waits for it (`PendingExpression.deferRefusal`).
	const deferred = new Map<number, (() => void)[]>();
	const apply = (source: number, step: () => void) => {
		if (
			source < 0 ||
			pending[source]?.deferRefusal !== true ||
			reading.bound[source] !== undefined
		) {
			step();
			return;
		}
		deferred.set(source, [...(deferred.get(source) ?? []), step]);
	};
	for (const claim of reading.claims) {
		if (claim.source < 0) continue;
		apply(claim.source, () =>
			applyExpressionClaim(ctx, claim, ctx.pending.site(claim.source).at),
		);
	}
	claimDeclarations(ctx, reading);
	for (const row of reading.circumstances)
		apply(row.source, () =>
			applyExpressionCircumstance(
				ctx,
				row,
				row.source >= 0 ? ctx.pending.site(row.source).at : undefined,
			),
		);
	DEFERRED.set(ctx, deferred);
	for (const at of reading.ownerless) {
		const registration = pending[at];
		if (registration === undefined) continue;
		const finding = findingAtOrAbove(
			ctx.accounting.findings(),
			registration.place,
		);
		if (finding === undefined)
			throw new Error(
				`Nova was asked to read an expression for a slot the document doesn't hold (${slotWords(registration.ref)}), and no finding explains why. The structure readers create every owner before expressions are read; check the reader that registered this one.`,
			);
		ctx.accounting.cover(ctx.pending.site(at).at, finding);
	}
	for (const tag of reading.unreadTables)
		if (!ctx.facts.unreadTables.some((table) => table.tag === tag))
			ctx.facts.unreadTables.push({
				tag,
				place: { kind: "lookup-table", tag },
			});
	ctx.facts.rewrites.push(...reading.rewrites);
	ctx.facts.expressionRounds = reading.rounds;
	ctx.readsLocations =
		reading.worldReads.locationDataSlugs.length > 0 ||
		reading.bound.some((tree) => tree !== undefined && readsPlaces(tree));
}

/**
 * Stage 7: every pending expression bound against the provisional document. The first run of
 * the expression reader is kept only for what it learns the app reads of the worker and of
 * places, which the drafts then hold, together with the worker properties the searches' filter
 * rows read, which the search stage names (`searchRowUserFields`), and the worker properties
 * the writes of the worker's record save to (`caseManagement/index.ts::workerRecordWriteSlugs`),
 * which the gate holds to a declared one; the second, over the
 * document that holds them, is the reading, and the one applied.
 */
export function bindExpressions(ctx: ReadContext): void {
	const env = expressionEnvOf(ctx);
	const pending = ctx.pending.list();
	const first = readExpressions(provisionalDocument(ctx), pending, env);
	const rows = searchRowUserFields(ctx);
	const world = worldEntitiesFromReads(
		{
			...first.worldReads,
			userFields: [...first.worldReads.userFields, ...rows.userFields],
			sessionUserFields: [
				...first.worldReads.sessionUserFields,
				...rows.sessionUserFields,
			],
			writtenUserFields: workerRecordWriteSlugs(ctx),
		},
		ctx.resolver,
	);
	if (world.userProperties.length > 0 || world.locationProperties.length > 0)
		ctx.writeDraft(() => {
			ctx.draft.userProperties = world.userProperties;
			ctx.draft.locationProperties = world.locationProperties;
		});
	applyExpressionReading(
		ctx,
		readExpressions(provisionalDocument(ctx), pending, env),
	);
}
