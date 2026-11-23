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
import { SlugsTaken } from "@/lib/domain/idSlug";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "@/lib/domain/localization";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import { recordFromEntries } from "@/lib/domain/records";
import {
	circumstanceFinding,
	type Finding,
	type FindingDetail,
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
	readExpressionsSteps,
} from "./expressions";
import {
	classifiedInstanceId,
	EXPRESSION_CLAIMS,
} from "./expressions/findings";
import { slotForm } from "./expressions/readExpression";
import {
	instanceIdsRead,
	unreadDeclarationUse,
} from "./expressions/surfaceUses";
import { pointerToken } from "./jsonCursor";
import { manifestFindingOf } from "./languages";
import {
	type PendingExpression,
	pendingPlaceholder,
} from "./pendingExpressions";
import { appPlace, whereText } from "./place";
import { searchRowUserFields } from "./search";
import { refusedInstanceNameOf } from "./search/settings";
import { sourceFormExpression } from "./syntaxCompare";
import { worldEntitiesFromReads } from "./worldEntities";
import { type DraftField, expressionEnvOf, type ReadXForm } from "./xform";
import { registerAttributeUses } from "./xform/attributeUses";

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
	const slots = {
		...field.field,
		uuid,
		id: field.id,
		kind: field.kind,
	} as Record<string, unknown>;
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
	taken: SlugsTaken,
): string {
	if (typeof given === "string") return given;
	return taken.take(name, fallback);
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
	const menuIds = new SlugsTaken();
	const formIds = new SlugsTaken();
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
		const id = menuIds.take(name, "menu");
		if (id !== module.id) menus.set(moduleUuid, id);
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const formId = formIds.take(form.name, "form");
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
	const moduleIds = new SlugsTaken();
	const formIds = new SlugsTaken();
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
					organizationLevels: recordFromEntries(
						draft.levels.map((level) => [level.uuid, level]),
					),
					organizationLevelOrder: draft.levels.map((level) => level.uuid),
				}),
		...(draft.userProperties.length === 0
			? {}
			: {
					userProperties: recordFromEntries(
						draft.userProperties.map((one) => [one.uuid, one]),
					),
					userPropertyOrder: draft.userProperties.map((one) => one.uuid),
				}),
		...(draft.locationProperties.length === 0
			? {}
			: {
					locationProperties: recordFromEntries(
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

/** The fixtures CommCare HQ's build gives the places of a project space: the flat list, and the
 *  hierarchical one under `HIERARCHICAL_LOCATION_FIXTURE` (`suite_xml/post_process/instances.py::
 *  location_fixture_instances`). */
const PLACE_FIXTURES: ReadonlySet<string> = new Set([
	"jr://fixture/locations",
	"jr://fixture/commtrack:locations",
]);

/**
 * Whether a registration's own text reads places, whatever the expression stage made of it: it
 * calls `instance('<id>')` for an id that names a list of places where the text is evaluated. A
 * form's attribute is evaluated over the instances the form declares, so the id is one the form
 * declares over a place fixture (`sources`); every other slot (a menu's or form's display
 * condition, a case list's, a Search's) is evaluated in the suite, where HQ's build declares the
 * id `locations` over the places (`location_fixture_instances`). A refused read of a place is
 * still a read the app makes, which a reading that never read the project space's places cannot
 * tell from the app's own error.
 */
function textReadsPlaces(
	registration: PendingExpression,
	sources: ReadonlyMap<string, string> | undefined,
): boolean {
	return instanceIdsRead(registration.text).some((id) =>
		registration.mode.target === "xform"
			? PLACE_FIXTURES.has(sources?.get(id) ?? "")
			: id === "locations",
	);
}

/** The leaves that read places: with the texts that read them, what makes a reading's
 *  `readsLocations`. */
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

/** The entry a table's declaration is claimed under where a choice list's
 *  itemset alone reads it. */
const TYPED_CARRIER =
	"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers";

/** The surface key of a declaration's `id`. */
const DECLARATION_ID_KEY = "xform:model/instance@id";

/** The nodes of an `<instance>` declaration a claim of it covers, each with the surface key whose
 *  value sits there: its `id`, and its `src`, under the source's key (`key`). The element is the
 *  frame's (`xform/model.ts::readInstances`). */
function declarationSites(
	element: ReadXForm["parsed"]["instances"][number]["element"],
	key: string,
): { readonly site: ClaimSite; readonly key: string }[] {
	return [
		{ site: { element, attribute: "id" }, key: DECLARATION_ID_KEY },
		{ site: { element, attribute: "src" }, key },
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
	/* Each unread declaration's claims by key, place and entry, in reading order: a declaration
	 * takes the first one not yet taken of the entry its source gives it, so a declaration this
	 * pass claims otherwise (a table a choice list's itemset reads) leaves no claim of another
	 * class to the next declaration of its key. */
	const unreadAt = new Map<string, ExpressionClaim[]>();
	for (const claim of reading.claims) {
		if (claim.source >= 0) continue;
		const at = JSON.stringify([
			claim.key,
			whereText(claim.place),
			claim.entryId,
		]);
		const claims = unreadAt.get(at);
		if (claims === undefined) unreadAt.set(at, [claim]);
		else claims.push(claim);
	}
	/* Each form's held registrations and the positions of their claims,
	 * grouped once for every form rather than found again per form. */
	const heldByForm = new Map<string, number[]>();
	const refusedByForm = new Map<string, number[]>();
	pending.forEach((registration, at) => {
		if (registration.mode.target !== "xform") return;
		const owner = slotForm(reading.doc, registration.ref);
		if (owner === undefined) return;
		const byForm = reading.bound[at] === undefined ? refusedByForm : heldByForm;
		const known = byForm.get(owner);
		if (known === undefined) byForm.set(owner, [at]);
		else known.push(at);
	});
	const claimsBySource = new Map<number, number[]>();
	reading.claims.forEach((claim, position) => {
		const positions = claimsBySource.get(claim.source);
		if (positions === undefined) claimsBySource.set(claim.source, [position]);
		else positions.push(position);
	});
	/** The finding of a refused registration of the form that reads instance `id`: the first such
	 *  registration whose claims a finding stands for. */
	const refusedReadOf = (id: string, formUuid: string): Finding | undefined => {
		for (const at of refusedByForm.get(formUuid) ?? []) {
			if (!instanceIdsRead(pending[at]?.text ?? "").includes(id)) continue;
			for (const position of claimsBySource.get(at) ?? []) {
				const claim = reading.claims[position] as ExpressionClaim;
				const finding = ctx.accounting
					.findings()
					.find(
						(one) =>
							one.code === claim.entryId &&
							whereText(one.place) === whereText(claim.place),
					);
				if (finding !== undefined) return finding;
			}
		}
		return undefined;
	};
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			const xform = form.xform;
			if (xform === null) continue;
			const readsById = new Map<string, number[]>();
			for (const at of heldByForm.get(form.uuid) ?? []) {
				for (const id of new Set(instanceIdsRead(pending[at]?.text ?? ""))) {
					const registrations = readsById.get(id) ?? [];
					registrations.push(at);
					readsById.set(id, registrations);
				}
			}
			const where = whereText(form.place);
			const droppedFixtures: [string, string][] = [];
			for (const [id, src] of xform.instanceSources) {
				const declaration = xform.parsed.instances.find(
					(instance) => instance.id === id,
				);
				if (declaration === undefined) continue;
				const unread = unreadDeclarationUse(src);
				const key = unread.key;
				// A table only a choice list's itemset reads is that carrier's read.
				if (!readsById.has(id) && xform.carrierInstances.has(id)) {
					for (const one of declarationSites(declaration.element, key))
						claimExpressionEntry(
							ctx,
							one.site,
							TYPED_CARRIER,
							one.key,
							form.place,
						);
					continue;
				}
				if (!readsById.has(id)) {
					const claim = unreadAt
						.get(JSON.stringify([key, where, unread.entryId]))
						?.shift();
					// A declaration only a refused expression of the form reads belongs to that
					// expression's refusal, and stands under its finding.
					const refusal = refusedReadOf(id, form.uuid);
					if (refusal !== undefined) {
						for (const one of declarationSites(declaration.element, key))
							ctx.accounting.cover(one.site, refusal);
						continue;
					}
					if (claim === undefined) continue;
					for (const one of declarationSites(declaration.element, key))
						claimExpressionEntry(
							ctx,
							one.site,
							claim.entryId,
							one.key,
							form.place,
							claim.detail,
						);
					if (claim.entryId === UNSERVED_MAYBE) droppedFixtures.push([id, src]);
					continue;
				}
				const scheme = classifiedInstanceId(id, src)?.split(":")[0];
				// Several fixtures can appear in one expression. Each declaration takes
				// the claim of its own read, including which kind of fixture supplied it.
				const relevant = (readsById.get(id) ?? [])
					.flatMap((at) => claimsBySource.get(at) ?? [])
					.map((at) => reading.claims[at] as ExpressionClaim)
					.filter((claim) =>
						index.entry(claim.entryId)?.surfaceKeys.includes(key),
					);
				const read =
					relevant.find((claim) => claim.key === `instance-scheme:${scheme}`) ??
					relevant[0];
				if (read === undefined) continue;
				const standing = index.entry(read.entryId)?.standing;
				if (
					standing === "held" ||
					standing === "inert" ||
					standing === "kept"
				) {
					for (const one of declarationSites(declaration.element, key))
						claimExpressionEntry(
							ctx,
							one.site,
							read.entryId,
							one.key,
							form.place,
						);
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
				for (const one of declarationSites(declaration.element, key))
					ctx.accounting.cover(one.site, finding);
			}
			if (droppedFixtures.length)
				recordDroppedFixtures(ctx, form, droppedFixtures);
		}
}

/** The entry of a declared fixture no expression reads that the project space may not serve. */
const UNSERVED_MAYBE =
	EXPRESSION_CLAIMS[
		"declared-unreferenced-fixture-instance-the-project-space-may-not"
	].entry;

/**
 * Records, once for a form, that its source declares a fixture no expression reads that the
 * project space may not serve: Core loads every declared instance when the form opens and stops
 * the form where the fixture is not there (`CommCareInstanceInitializer.loadFixtureRoot`), and
 * Nova writes no declaration nothing reads, so the first publish changes the form's source and,
 * on a device the fixture never reaches, lets the form open (`unread-fixture-declarations-dropped`).
 */
function recordDroppedFixtures(
	ctx: ReadContext,
	form: ReadContext["draft"]["modules"][number]["forms"][number],
	removedInputs: readonly (readonly [string, string])[],
): void {
	const readId =
		ctx.input.source.modules[form.menu]?.forms[form.index]?.readUniqueId;
	ctx.facts.sameStateRewrites.push({
		entry: UNSERVED_MAYBE,
		path: `/_attachments/${pointerToken(`${readId ?? form.xmlns}.xml`)}`,
		register: "unread-fixture-declarations-dropped",
		removedInputs,
	});
}

/** The slot a registration names and its owner's identity, for the throw over a registration whose slot the document lacks. */
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

/** One claim of an expression reading, applied to the node `at` its registration was read from:
 *  handed to project data where its rules settle it (`ExpressionClaim.handOff`), and with the
 *  refusal it carries claimed beside it under its own key (`ExpressionClaim.refusal`). */
export function applyExpressionClaim(
	ctx: ReadContext,
	claim: ExpressionReading["claims"][number],
	at: ClaimSite,
): void {
	if (claim.refusal !== undefined) {
		const { refusal, ...own } = claim;
		applyExpressionClaim(ctx, own, at);
		const { handOff, ...beside } = refusal;
		applyExpressionClaim(
			ctx,
			{
				source: claim.source,
				place: claim.place,
				...beside,
				...(handOff !== undefined && { handOff }),
			},
			at,
		);
		return;
	}
	if (claim.handOff !== undefined) {
		ctx.accounting.handOffAt(
			at,
			claim.handOff.to,
			claim.handOff.subject,
			claim.key,
		);
		return;
	}
	const instanceName = refusedInstanceRead(ctx, claim);
	if (instanceName !== undefined) {
		ctx.accounting.cover(
			at,
			manifestFindingOf(instanceName.claim, instanceName.place, {}),
		);
		return;
	}
	const textRefusal = formTextRefusal(ctx, claim);
	if (textRefusal !== undefined) {
		claimExpressionEntry(ctx, at, claim.entryId, claim.key, textRefusal, {});
		return;
	}
	// A text registered for its uses alone claims each use no other claim at its node names
	// (`xform/attributeUses.ts`: a whole value beside the slot that reads a part of it).
	claimExpressionEntry(
		ctx,
		at,
		claim.entryId,
		claim.key,
		claim.place,
		claim.detail,
		ctx.pending.list()[claim.source]?.usesOnly === true
			? { unlessClaimed: true }
			: undefined,
	);
}

/**
 * `Accounting.claimEntry` of a claim the expression stage decided: under `key` where the entry
 * names it, and otherwise with no key. A refusal whose entry names neither the slot's own key nor
 * the key of a use the text makes (a read of an instance by an unknown scheme refused in a
 * calculate, a search filter's class refused at its default value), with no allowing entry of the
 * slot to stand beside (`expressions/index.ts::allowingEntryBeside`), and a declaration whose `id`
 * the entry of the read that holds it does not name, stand at the node with no record of a key, as
 * an entry that names no key does: the lane's parity reads no class of that key there.
 */
function claimExpressionEntry(
	ctx: ReadContext,
	at: ClaimSite,
	entryId: string,
	key: string,
	place: HqPlace,
	detail?: FindingDetail,
	options?: { readonly unlessClaimed?: true },
): void {
	const named = inventoryIndex().entry(entryId)?.surfaceKeys.includes(key);
	ctx.accounting.claimEntry(at, entryId, key, place, detail, {
		...options,
		...(named === false && { keyless: true }),
	});
}

/** The entry a read of an instance the form declares from a source Nova does not read takes. */
const UNRECOGNIZED_INSTANCE_SOURCE =
	"expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src";

/**
 * The refusal of a results instance name the reading refused, where the claim is the slot's read
 * of an instance under that name (`search/settings.ts::refusedInstanceNameOf`): Nova holds no such
 * name, so the read is that one refusal, claimed under it with no second finding. Undefined for
 * any other claim.
 */
function refusedInstanceRead(
	ctx: ReadContext,
	claim: ExpressionReading["claims"][number],
): ReturnType<typeof refusedInstanceNameOf> {
	if (claim.entryId !== UNRECOGNIZED_INSTANCE_SOURCE || claim.source < 0)
		return undefined;
	const registration = ctx.pending.list()[claim.source];
	if (registration === undefined) return undefined;
	for (const id of instanceIdsRead(registration.text)) {
		const refused = refusedInstanceNameOf(ctx, id);
		if (refused !== undefined) return refused;
	}
	return undefined;
}

/** The entry a form's text is refused under where only an expression names its itext id. */
const EXPRESSION_ONLY_TEXT =
	"questions/itext-entry-referenced-only-from-jr-itext-in-an-expression";

/**
 * The form's place, where the form reader refused a text only an expression names
 * (`xform/itext.ts`, under the entry the expression's read of it takes): the read is that one
 * refusal and is claimed under it at the form, so one text is one finding however many slots
 * read it. Undefined for any other claim, and where the form holds no such text (the id names
 * nothing), which is the read's own finding.
 */
function formTextRefusal(
	ctx: ReadContext,
	claim: ExpressionReading["claims"][number],
): HqPlace | undefined {
	const place = claim.place;
	if (claim.entryId !== EXPRESSION_ONLY_TEXT || !("form" in place))
		return undefined;
	return ctx.accounting
		.findings()
		.find(
			(finding) =>
				finding.code === EXPRESSION_ONLY_TEXT &&
				finding.place.kind === "form" &&
				finding.place.menu === place.menu &&
				finding.place.form === place.form,
		)?.place;
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

/** The entry a form's secondary instance with inline content and no `src` is refused under, by
 *  the form reader. */
const INLINE_INSTANCE_ENTRY =
	"expressions-and-data/inline-instance-content-inside-instance-no-src";

/**
 * By registration, the finding a form raised for an instance with inline content that the
 * registration's refused expression reads: the read stands under that refusal, one cause, and
 * raises nothing of its own (the expression stage, which sees only declared sources, takes the
 * id for an undeclared one).
 */
function readsOfRefusedInlineInstances(
	ctx: ReadContext,
	reading: ExpressionReading,
): ReadonlyMap<number, Finding> {
	const refusedByForm = new Map<string, Map<string, Finding>>();
	const findings = ctx.accounting.findings();
	for (const module of ctx.draft.modules)
		for (const form of module.forms) {
			if (form.xform === null) continue;
			const where = whereText(form.place);
			const refused = new Map<string, Finding>();
			for (const instance of form.xform.parsed.instances) {
				if (instance.src !== undefined) continue;
				const finding = findings.find(
					(one) =>
						one.code === INLINE_INSTANCE_ENTRY &&
						one.detail.name === instance.id &&
						whereText(one.place) === where,
				);
				if (finding !== undefined) refused.set(instance.id, finding);
			}
			if (refused.size > 0) refusedByForm.set(form.uuid, refused);
		}
	const under = new Map<number, Finding>();
	if (refusedByForm.size === 0) return under;
	ctx.pending.list().forEach((registration, index) => {
		if (
			registration.mode.target !== "xform" ||
			reading.bound[index] !== undefined
		)
			return;
		const owner = slotForm(reading.doc, registration.ref);
		const refused = owner === undefined ? undefined : refusedByForm.get(owner);
		if (refused === undefined) return;
		for (const id of instanceIdsRead(registration.text)) {
			const finding = refused.get(id);
			if (finding === undefined) continue;
			under.set(index, finding);
			return;
		}
	});
	return under;
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
	const underInline = readsOfRefusedInlineInstances(ctx, reading);
	// A refusal its registrar settles waits for it (`PendingExpression.deferRefusal`).
	const deferred = new Map<number, (() => void)[]>();
	const apply = (source: number, step: () => void) => {
		if (underInline.has(source)) return;
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
	for (const [source, finding] of underInline)
		ctx.accounting.cover(ctx.pending.site(source).at, finding);
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
		if (
			!ctx.facts.unreadTables.some(
				(table) => table.tag === tag && table.declaredOnly !== true,
			)
		)
			ctx.facts.unreadTables.push({
				tag,
				place: { kind: "lookup-table", tag },
			});
	for (const tag of reading.declaredTables)
		if (!ctx.facts.unreadTables.some((table) => table.tag === tag))
			ctx.facts.unreadTables.push({
				tag,
				place: { kind: "lookup-table", tag },
				declaredOnly: true,
			});
	for (const { source, ...rewrite } of reading.rewrites) {
		const at = ctx.pending.site(source).at;
		const registration = ctx.pending.list()[source];
		ctx.facts.rewrites.push(
			"json" in at
				? { ...rewrite, pointer: `${at.json.pointer}/${pointerToken(at.key)}` }
				: registration.mode.target === "xform"
					? {
							...rewrite,
							formExpression: sourceFormExpression(registration.text),
						}
					: rewrite,
		);
	}
	ctx.facts.expressionRounds = reading.rounds;
	const sources = new Map<Uuid, ReadonlyMap<string, string>>();
	for (const module of ctx.draft.modules)
		for (const form of module.forms)
			if (form.xform !== null)
				sources.set(form.uuid, form.xform.instanceSources);
	ctx.readsLocations =
		reading.worldReads.locationDataSlugs.length > 0 ||
		reading.bound.some((tree) => tree !== undefined && readsPlaces(tree)) ||
		pending.some((registration) => {
			const form = slotForm(reading.doc, registration.ref);
			return textReadsPlaces(
				registration,
				form === undefined ? undefined : sources.get(form),
			);
		});
}

/**
 * Stage 7: every pending expression bound against the provisional document, each attribute a
 * form reader claimed that Core parses as XPath and no slot holds whole registered first for its
 * uses (`xform/attributeUses.ts::registerAttributeUses`). The first run of
 * the expression reader is kept only for what it learns the app reads of the worker and of
 * places, which the drafts then hold, together with the worker properties the searches' filter
 * rows read, which the search stage names (`searchRowUserFields`), and the worker properties
 * the writes of the worker's record save to (`caseManagement/index.ts::workerRecordWriteSlugs`),
 * which the gate holds to a declared one; the second, over the
 * document that holds them, is the reading, and the one applied.
 */
export function bindExpressions(ctx: ReadContext): void {
	const steps = bindExpressionsSteps(ctx);
	while (!steps.next().done);
}

/** `bindExpressions`, stopping after each reading of the expressions until it
 *  is resumed. */
export function* bindExpressionsSteps(
	ctx: ReadContext,
): Generator<void, void, void> {
	registerAttributeUses(ctx);
	const env = expressionEnvOf(ctx);
	const pending = ctx.pending.list();
	const firstDoc = provisionalDocument(ctx);
	yield;
	const first = yield* readExpressionsSteps(firstDoc, pending, env);
	yield;
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
		ctx.identities,
	);
	if (world.userProperties.length > 0 || world.locationProperties.length > 0)
		ctx.writeDraft(() => {
			ctx.draft.userProperties = world.userProperties;
			ctx.draft.locationProperties = world.locationProperties;
		});
	/* `readExpressions` is a function of its arguments: where the world's
	 * entities wrote nothing, the drafts give the same document, and its
	 * reading is the first. */
	const doc = provisionalDocument(ctx);
	const reading =
		doc === firstDoc ? first : yield* readExpressionsSteps(doc, pending, env);
	yield;
	applyExpressionReading(ctx, reading);
}
