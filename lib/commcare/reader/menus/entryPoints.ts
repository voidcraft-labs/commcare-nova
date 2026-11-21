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
	type Uuid,
} from "@/lib/domain";
import { recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { validEntryPoints } from "../../validator/rules/app";
import { type Claim, defineClaims, derived, refuse, take } from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { externalKey } from "../identity";
import { whereText } from "../place";
import { rawModules } from "./modules";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

type MenuClass = "Module" | "AdvancedModule";
type FormClass = "Form" | "AdvancedForm";

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

const MENUS: readonly MenuClass[] = ["Module", "AdvancedModule"];
const FORMS: readonly FormClass[] = ["Form", "AdvancedForm"];

const ENTRY_POINTS = {
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
		refuse,
		`${F}/function-datum-endpoints`,
		"function_datum_endpoints",
	),
	sharedFirstMenuCase: byClass(
		FORMS,
		refuse,
		`${F}/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`,
		"session_endpoint_id",
	),
	menuSharedFirstMenuCase: byClass(
		MENUS,
		refuse,
		`${F}/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`,
		"session_endpoint_id",
	),
	caseListSharedFirstMenuCase: byClass(
		MENUS,
		refuse,
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
	readonly slot: "session_endpoint_id" | "case_list_session_endpoint_id";
}

/** The deep links each reading read, for the gate's rule over the document. */
const READ = new WeakMap<ReadContext, Map<Uuid, ReadEntryPoint>>();

/**
 * Pass 1, from `readMenus`: every deep link id the app stores, each refused
 * where `slugify` would change it or another link shares it, and read into
 * its entry point otherwise. A folded hidden menu stores none.
 */
export function readEntryPoints(ctx: ReadContext, app: DraftApp): void {
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
					json.refuse("session_endpoint_id", ENTRY_POINTS.menuNotSlug[cls]),
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
	for (const module of app.modules)
		for (const form of module.forms) {
			const { json } = form;
			const cls = form.docType;
			const datums = json.peek("function_datum_endpoints");
			if (Array.isArray(datums) && datums.length > 0)
				json.refuse(
					"function_datum_endpoints",
					ENTRY_POINTS.functionDatums[cls],
				);
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
						externalKey.entryPoint("form", form.xmlns),
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
 * through a first menu that shares one case, a form's, a menu's or a case
 * list's, is that row's finding; any other
 * refusal is a deep link Nova cannot build for a reason no row names.
 */
export function settleEntryPoints(ctx: ReadContext): void {
	const doc = ctx.doc;
	const read = READ.get(ctx);
	if (doc === undefined || read === undefined || read.size === 0) return;
	for (const error of validEntryPoints(doc as BlueprintDoc)) {
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
}
