/**
 * Deep links: a menu's own (`session_endpoint_id`), its case list's
 * (`case_list_session_endpoint_id`) and a form's, each read into the entry
 * point Nova holds for it with HQ's id kept, and a form's link that ignores
 * display conditions (`respect_relevancy: false`). An id HQ's `slugify`
 * would change, or one two links share, is refused before any slot is
 * written; the gate's own rule then runs over the document.
 */
import {
	type BlueprintDoc,
	entryPointIdProblem,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import { recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	availableEntryCaseCreations,
	createEntryPointProjector,
} from "../../entryPointProjection";
import { formLinkProjectionContext } from "../../formLinkProjection";
import { validEntryPoints } from "../../validator/rules/app";
import { withCandidate } from "../candidate";
import { type Claim, defineClaims, derived, refuse, take } from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { externalKey } from "../identity";
import { whereText } from "../place";
import { rawModules } from "./modules";
import type { SharedFormLink } from "./sharedForms";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

type MenuClass = DraftModule["docType"];
type FormClass = DraftForm["docType"];

function byClass<C extends string, U extends Claim["use"]>(
	classes: readonly C[],
	make: (entry: string, key: string) => Claim<U>,
	entry: string,
	field: string,
): Readonly<Record<C, Claim<U>>> {
	return recordFromEntries(
		classes.map((cls) => [cls, make(entry, `schema:${cls}.${field}`)]),
	) as Record<C, Claim<U>>;
}

const MENUS: readonly MenuClass[] = [
	"Module",
	"AdvancedModule",
	"ShadowModule",
];
const FORMS: readonly FormClass[] = ["Form", "AdvancedForm", "ShadowForm"];

const ENTRY_POINTS = {
	sharedFormId: take(
		`${M}/shadowmodule-form-session-endpoints-non-empty`,
		"schema:ShadowFormEndpoint.session_endpoint_id",
	),
	sharedFormNotSlug: refuse(
		`${M}/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed`,
		"schema:ShadowFormEndpoint.session_endpoint_id",
	),
	sharedFormWhitespace: refuse(
		`${M}/a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding`,
		"schema:ShadowFormEndpoint.session_endpoint_id",
	),
	sharedMenuWhitespace: refuse(
		`${M}/a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding`,
		"schema:ShadowModule.session_endpoint_id",
	),
	sharedFormDuplicate: refuse(
		`${M}/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`,
		"schema:ShadowFormEndpoint.session_endpoint_id",
	),
	sharedFirstMenu: refuse(
		`${F}/first-menu-selection-used-for-different-records`,
		"schema:ShadowFormEndpoint.session_endpoint_id",
	),
	menu: byClass(MENUS, take, `${M}/session-endpoint-id`, "session_endpoint_id"),
	caseList: byClass(
		MENUS,
		take,
		`${M}/case-list-session-endpoint-id`,
		"case_list_session_endpoint_id",
	),
	menuBlank: byClass(
		MENUS,
		derived,
		`${M}/session-endpoint-id`,
		"session_endpoint_id",
	),
	caseListBlank: byClass(
		MENUS,
		derived,
		`${M}/case-list-session-endpoint-id`,
		"case_list_session_endpoint_id",
	),
	formBlank: byClass(
		FORMS,
		derived,
		`${F}/session-endpoint-id`,
		"session_endpoint_id",
	),
	caseListAbove: byClass(
		MENUS,
		refuse,
		`${M}/case-list-session-endpoint-id-on-a-put-in-root-module`,
		"case_list_session_endpoint_id",
	),
	menuNotSlug: byClass(
		MENUS,
		refuse,
		`${M}/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed`,
		"session_endpoint_id",
	),
	caseListNotSlug: byClass(
		MENUS,
		refuse,
		`${M}/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed`,
		"case_list_session_endpoint_id",
	),
	menuShared: byClass(
		MENUS,
		refuse,
		`${M}/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`,
		"session_endpoint_id",
	),
	caseListShared: byClass(
		MENUS,
		refuse,
		`${M}/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`,
		"case_list_session_endpoint_id",
	),
	form: byClass(FORMS, take, `${F}/session-endpoint-id`, "session_endpoint_id"),
	formRefused: byClass(
		FORMS,
		refuse,
		`${F}/session-endpoint-id-not-a-slug-fixed-point-or-duplicated`,
		"session_endpoint_id",
	),
	/** A form's id a menu's or a case list's shares. */
	formShared: byClass(
		FORMS,
		refuse,
		`${M}/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`,
		"session_endpoint_id",
	),
	ignoreConditions: byClass(
		FORMS,
		take,
		`${F}/respect-relevancy-false`,
		"respect_relevancy",
	),
	respectWithNoLink: byClass(
		FORMS,
		derived,
		`${F}/respect-relevancy-false`,
		"respect_relevancy",
	),
	functionDatums: byClass(
		FORMS,
		take,
		`${F}/function-datum-endpoints`,
		"function_datum_endpoints",
	),
	unavailableFunctionDatums: byClass(
		FORMS,
		refuse,
		`${F}/function-datum-endpoints-with-an-unavailable-supplier`,
		"function_datum_endpoints",
	),
	sharedFirstMenuCase: byClass(
		FORMS,
		refuse,
		`${F}/first-menu-selection-used-for-different-records`,
		"session_endpoint_id",
	),
	menuSharedFirstMenuCase: byClass(
		MENUS,
		refuse,
		`${F}/first-menu-selection-used-for-different-records`,
		"session_endpoint_id",
	),
	caseListSharedFirstMenuCase: byClass(
		MENUS,
		refuse,
		`${F}/first-menu-selection-used-for-different-records`,
		"case_list_session_endpoint_id",
	),
	firstMenuCase: byClass(
		FORMS,
		derived,
		`${F}/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`,
		"session_endpoint_id",
	),
	menuFirstMenuCase: byClass(
		MENUS,
		derived,
		`${F}/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`,
		"session_endpoint_id",
	),
	caseListFirstMenuCase: byClass(
		MENUS,
		derived,
		`${F}/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`,
		"case_list_session_endpoint_id",
	),
} as const;

defineClaims(
	"menus.entryPoints",
	recordFromEntries(
		Object.entries(ENTRY_POINTS).flatMap(([name, one]) =>
			"use" in one
				? [[name, one as unknown as Claim]]
				: Object.entries(one as Record<string, Claim>).map(([cls, claim]) => [
						`${name}@${cls}`,
						claim,
					]),
		),
	) as Record<string, Claim>,
);

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** One stored deep link id and where it stands. */
interface StoredId {
	readonly id: string;
	readonly place: HqPlace;
	readonly form: boolean;
	readonly read: () => void;
	readonly notSlug: () => void;
	/** Claims the id under the one finding of the id it shares, at `place`; `formsOnly`
	 *  where every slot holding it is a form's. */
	readonly shared: (place: HqPlace, formsOnly: boolean) => void;
}

/** One deep link read: its owner, and the slot it stands in. */
interface ReadEntryPoint {
	readonly owner: DraftModule | DraftForm;
	readonly slot:
		| "session_endpoint_id"
		| "case_list_session_endpoint_id"
		| "form_session_endpoints";
}

/** The deep links each reading read, for the gate's rule over the document. */
const READ = new WeakMap<ReadContext, Map<Uuid, ReadEntryPoint>>();

/**
 * Pass 1, from `readMenus`: every deep link id the app stores, each refused
 * where `slugify` would change it or another link shares it, and read into
 * its entry point otherwise. A folded hidden menu stores none.
 */
export function readEntryPoints(
	ctx: ReadContext,
	app: DraftApp,
	sharedFormLinks: readonly SharedFormLink[],
): void {
	const folded = new Set(app.foldedMenus.map((one) => one.menu));
	const stored = rawModules(ctx);
	const read = new Map<Uuid, ReadEntryPoint>();
	READ.set(ctx, read);
	const ids: StoredId[] = [];
	const write = (target: DraftModule | DraftForm, patch: object) =>
		ctx.writeDraft(() => {
			Object.assign("module" in target ? target.module : target.form, patch);
		});
	const mint = (
		key: ReturnType<typeof externalKey.entryPoint>,
		place: DraftModule["place"],
		name: string,
	) =>
		ctx.accounting.identity(
			ctx.identities.claim(key, whereText(place)),
			place,
			name,
		);
	for (const module of app.modules) {
		const { json } = module;
		const cls = module.docType;
		if (folded.has(module)) {
			// The hidden-menu shape holds no deep link: each id is blank.
			if (json.used("session_endpoint_id"))
				json.derived("session_endpoint_id", ENTRY_POINTS.menuBlank[cls]);
			if (json.used("case_list_session_endpoint_id"))
				json.derived(
					"case_list_session_endpoint_id",
					ENTRY_POINTS.caseListBlank[cls],
				);
			continue;
		}
		const menuId = textOf(json.peek("session_endpoint_id"));
		// A blank id is no deep link, which is what Nova writes for a menu with none.
		if (menuId === "" && json.used("session_endpoint_id"))
			json.derived("session_endpoint_id", ENTRY_POINTS.menuBlank[cls]);
		if (menuId !== "")
			ids.push({
				id: menuId,
				place: module.place,
				form: false,
				read: () => {
					json.take("session_endpoint_id", ENTRY_POINTS.menu[cls], textOf)
						.value;
					const uuid = mint(
						externalKey.entryPoint("module", module.uniqueId, "menu"),
						module.place,
						`schema:${cls}.session_endpoint_id`,
					);
					if (uuid !== undefined) {
						write(module, { entryPoint: { uuid, id: menuId } });
						read.set(uuid, { owner: module, slot: "session_endpoint_id" });
					}
				},
				notSlug: () =>
					json.refuse(
						"session_endpoint_id",
						cls === "ShadowModule" && menuId.trim() !== menuId
							? ENTRY_POINTS.sharedMenuWhitespace
							: ENTRY_POINTS.menuNotSlug[cls],
					),
				shared: (place) =>
					json.refuse(
						"session_endpoint_id",
						ENTRY_POINTS.menuShared[cls],
						undefined,
						place,
					),
			});
		const listId = textOf(json.peek("case_list_session_endpoint_id"));
		if (listId === "" && json.used("case_list_session_endpoint_id"))
			json.derived(
				"case_list_session_endpoint_id",
				ENTRY_POINTS.caseListBlank[cls],
			);
		if (listId !== "") {
			if (stored[module.index]?.put_in_root === true) {
				json.refuse(
					"case_list_session_endpoint_id",
					ENTRY_POINTS.caseListAbove[cls],
				);
			} else
				ids.push({
					id: listId,
					place: module.place,
					form: false,
					read: () => {
						json.take(
							"case_list_session_endpoint_id",
							ENTRY_POINTS.caseList[cls],
							textOf,
						).value;
						const uuid = mint(
							externalKey.entryPoint("module", module.uniqueId, "case-list"),
							module.place,
							`schema:${cls}.case_list_session_endpoint_id`,
						);
						if (uuid !== undefined) {
							write(module, { caseListEntryPoint: { uuid, id: listId } });
							read.set(uuid, {
								owner: module,
								slot: "case_list_session_endpoint_id",
							});
						}
					},
					notSlug: () =>
						json.refuse(
							"case_list_session_endpoint_id",
							ENTRY_POINTS.caseListNotSlug[cls],
						),
					shared: (place) =>
						json.refuse(
							"case_list_session_endpoint_id",
							ENTRY_POINTS.caseListShared[cls],
							undefined,
							place,
						),
				});
		}
	}
	for (const { route, form, json, id } of sharedFormLinks) {
		ids.push({
			id,
			place: route.place,
			form: false,
			read: () => {
				json.take("session_endpoint_id", ENTRY_POINTS.sharedFormId, textOf)
					.value;
				const uuid = mint(
					externalKey.entryPoint("shared-form", route.uniqueId, form.xmlns),
					route.place,
					"schema:ShadowFormEndpoint.session_endpoint_id",
				);
				if (!uuid) return;
				ctx.writeDraft(() => {
					const source = route.module.formsFromMenu;
					if (!source) return;
					source.entryPoints ??= [];
					source.entryPoints.push({
						formUuid: form.uuid,
						entryPoint: { uuid, id },
					});
				});
				read.set(uuid, { owner: route, slot: "form_session_endpoints" });
			},
			notSlug: () =>
				json.refuse(
					"session_endpoint_id",
					id.trim() !== id
						? ENTRY_POINTS.sharedFormWhitespace
						: ENTRY_POINTS.sharedFormNotSlug,
				),
			shared: (place) =>
				json.refuse(
					"session_endpoint_id",
					ENTRY_POINTS.sharedFormDuplicate,
					undefined,
					place,
				),
		});
	}
	for (const module of app.modules)
		for (const form of module.forms) {
			const { json } = form;
			const cls = form.docType;
			const formId = textOf(json.peek("session_endpoint_id"));
			if (formId === "") {
				if (json.used("session_endpoint_id"))
					json.derived("session_endpoint_id", ENTRY_POINTS.formBlank[cls]);
				// Nova writes `true` for a form with no deep link; a stored `false` is read past.
				if (json.used("respect_relevancy"))
					json.derived(
						"respect_relevancy",
						ENTRY_POINTS.respectWithNoLink[cls],
					);
				continue;
			}
			const ignore = json.peek("respect_relevancy") === false;
			// A link's `respect_relevancy: false` belongs to it, refused with it.
			const coverIgnore = (place: HqPlace, claim: Claim): void => {
				if (!ignore) return;
				const where = whereText(place);
				const by = ctx.accounting
					.findings()
					.find(
						(one) => one.code === claim.entry && whereText(one.place) === where,
					);
				if (by !== undefined)
					ctx.accounting.cover({ json, key: "respect_relevancy" }, by);
			};
			ids.push({
				id: formId,
				place: form.place,
				form: true,
				read: () => {
					json.take("session_endpoint_id", ENTRY_POINTS.form[cls], textOf)
						.value;
					if (ignore)
						json.take(
							"respect_relevancy",
							ENTRY_POINTS.ignoreConditions[cls],
							(v) => v,
						).value;
					const uuid = mint(
						externalKey.entryPoint("form", form.entryKey ?? form.xmlns),
						form.place,
						`schema:${cls}.session_endpoint_id`,
					);
					if (uuid !== undefined) {
						write(form, {
							entryPoint: {
								uuid,
								id: formId,
								...(ignore ? { ignoreDisplayConditions: true } : {}),
							},
						});
						read.set(uuid, { owner: form, slot: "session_endpoint_id" });
					}
				},
				notSlug: () => {
					json.refuse("session_endpoint_id", ENTRY_POINTS.formRefused[cls]);
					coverIgnore(form.place, ENTRY_POINTS.formRefused[cls]);
				},
				shared: (place, formsOnly) => {
					const claim = formsOnly
						? ENTRY_POINTS.formRefused[cls]
						: ENTRY_POINTS.formShared[cls];
					json.refuse("session_endpoint_id", claim, undefined, place);
					coverIgnore(place, claim);
				},
			});
		}
	// One id two slots share is one finding, at the last slot holding it in
	// the app's order, and every slot holding it is claimed under it: the
	// forms' own entry where only forms share it, else the menus' entry, which
	// names every slot.
	const holders = new Map<string, StoredId[]>();
	for (const one of ids)
		if (entryPointIdProblem(one.id) === undefined)
			holders.set(one.id, [...(holders.get(one.id) ?? []), one]);
	for (const one of ids) {
		const sharing = holders.get(one.id) ?? [];
		const last = sharing[sharing.length - 1];
		if (entryPointIdProblem(one.id) !== undefined) one.notSlug();
		else if (sharing.length > 1 && last !== undefined)
			one.shared(
				last.place,
				sharing.every((holder) => holder.form),
			);
		else one.read();
	}
}

/**
 * Pass 2, from `settleMenus`: the gate's deep link rule over the document.
 * An id the gate refuses was refused from the stored ids already; a frame
 * that would let a later command read a different record under the same
 * first-menu argument is placed on the affected route. Any other
 * refusal is a deep link Nova cannot build for a reason no row names.
 */
export function settleEntryCaseCreations(
	ctx: ReadContext,
	app: DraftApp,
): void {
	const forms = app.modules
		.flatMap((module) => module.forms.map((form) => ({ module, form })))
		.filter(({ form }) => {
			const value = form.json.peek("function_datum_endpoints");
			return Array.isArray(value) && value.length > 0;
		});
	if (forms.length === 0 || ctx.doc === undefined) return;
	const doc = ctx.doc as BlueprintDoc;
	const projection = formLinkProjectionContext(doc, {
		entryMetadataOnly: true,
	});
	const held = new Map<Uuid, Uuid[]>();
	for (const { module, form } of forms) {
		if (!doc.forms[form.uuid]) continue;
		const field = "function_datum_endpoints";
		const ids = form.json.peek(field);
		if (!Array.isArray(ids)) continue;
		const available = availableEntryCaseCreations(
			doc,
			{ kind: "form", moduleUuid: module.uuid, formUuid: form.uuid },
			projection,
		);
		const byArgument = new Map(
			available.map((row) => [row.argumentId, row.operationUuid]),
		);
		const operations = ids.flatMap((id) => {
			const operation = typeof id === "string" ? byArgument.get(id) : undefined;
			return operation === undefined ? [] : [operation];
		});
		if (operations.length !== ids.length) {
			form.json.refuse(
				field,
				ENTRY_POINTS.unavailableFunctionDatums[form.docType],
			);
			continue;
		}
		const supplied = form.json.take(
			field,
			ENTRY_POINTS.functionDatums[form.docType],
			() => operations,
		).value;
		held.set(form.uuid, supplied);
	}
	if (held.size > 0)
		ctx.doc = withCandidate(doc, (draft) => {
			for (const [uuid, operations] of held)
				draft.forms[uuid].entryCaseCreations = operations;
		});
}

export function settleEntryPoints(ctx: ReadContext): void {
	const doc = ctx.doc;
	const read = READ.get(ctx);
	if (doc === undefined || read === undefined || read.size === 0) return;
	const errors = validEntryPoints(doc as BlueprintDoc);
	const invalid = new Set(errors.map((error) => error.details?.entryPointUuid));
	for (const error of errors) {
		const details = error.details as
			| { entryPointUuid?: string; reason?: string }
			| undefined;
		const entry =
			details?.entryPointUuid === undefined
				? undefined
				: read.get(details.entryPointUuid as Uuid);
		if (entry === undefined) continue;
		const { owner, slot } = entry;
		if (details?.reason === "first-menu-shared-case")
			ctx.accounting.finding(
				"form" in owner
					? ENTRY_POINTS.sharedFirstMenuCase[owner.docType]
					: slot === "form_session_endpoints"
						? ENTRY_POINTS.sharedFirstMenu
						: slot === "session_endpoint_id"
							? ENTRY_POINTS.menuSharedFirstMenuCase[owner.docType]
							: ENTRY_POINTS.caseListSharedFirstMenuCase[owner.docType],
				owner.place,
			);
		else
			ctx.accounting.circumstance("unrecognized", owner.place, {
				name: `schema:${owner.docType}.${slot}`,
			});
	}
	if (!doc.moduleOrder.some((menu) => doc.modules[menu]?.formsInMenuAbove))
		return;
	const project = createEntryPointProjector(doc);
	for (const [uuid, { owner, slot }] of read) {
		if (invalid.has(uuid) || ctx.accounting.hasFindingAt(owner.place)) continue;
		const moduleUuid =
			"form" in owner ? moduleUuidOfForm(doc, owner.uuid) : owner.uuid;
		if (!moduleUuid) continue;
		const target =
			"form" in owner
				? { kind: "form" as const, moduleUuid, formUuid: owner.uuid }
				: {
						kind:
							slot === "session_endpoint_id"
								? ("module" as const)
								: ("case-list" as const),
						moduleUuid,
					};
		if (!project(target).opensWithFirstMenuCase) continue;
		const claim =
			"form" in owner
				? ENTRY_POINTS.firstMenuCase[owner.docType]
				: slot === "session_endpoint_id"
					? ENTRY_POINTS.menuFirstMenuCase[owner.docType]
					: ENTRY_POINTS.caseListFirstMenuCase[owner.docType];
		ctx.accounting.claimEntryClass(
			{ json: owner.json, key: slot },
			claim.entry,
			`schema:${owner.docType}.${slot}`,
			owner.place,
		);
	}
}
