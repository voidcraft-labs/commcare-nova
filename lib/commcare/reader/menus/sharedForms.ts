import type { Uuid } from "@/lib/domain";
import { defineClaims, drop, refuse, take } from "../claims";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { isJsonObject, type JsonCursor } from "../jsonCursor";

const M = "menus-and-case-lists/";
const shared = `${M}shadowmodule-shadow-module-version-2`;
const endpoint = `${M}shadowmodule-form-session-endpoints-non-empty`;
const bad = `${M}shared-form-menu-with-an-unavailable-source-form`;
const C = defineClaims("menus.sharedForms", {
	source: take(shared, "schema:ShadowModule.source_module_id"),
	version: take(shared, "schema:ShadowModule.shadow_module_version"),
	storedType: drop(
		`${M}shadowmodule-case-type-stored-key`,
		"schema:ShadowModule.case_type",
	),
	excluded: take(
		`${M}shadowmodule-excluded-form-ids-non-empty`,
		"schema:ShadowModule.excluded_form_ids",
	),
	allForms: take(
		`${M}shadowmodule-excluded-form-ids-empty`,
		"schema:ShadowModule.excluded_form_ids",
	),
	endpoints: take(endpoint, "schema:ShadowModule.form_session_endpoints"),
	noEndpoints: drop(
		`${M}shadowmodule-form-session-endpoints-empty`,
		"schema:ShadowModule.form_session_endpoints",
	),
	endpointForm: take(endpoint, "schema:ShadowFormEndpoint.form_id"),
	uneditableSource: refuse(bad, "schema:ShadowModule.source_module_id"),
	incompleteChildren: refuse(
		`${M}shared-form-menus-with-incomplete-submenus`,
		"schema:ShadowModule.source_module_id",
	),
	missingExclusion: refuse(bad, "schema:ShadowModule.excluded_form_ids"),
	missingTarget: refuse(bad, "schema:ShadowModule.form_session_endpoints"),
	surveyEndpoints: refuse(
		`${M}mirror-form-deep-links-on-a-menu-listing-survey-forms`,
		"schema:ShadowModule.form_session_endpoints",
	),
});

/** The application resource returns the actual IDs saved on an owning menu. The source
 * download can independently mint IDs for the same forms, so only the resource namespace
 * resolves these two stored relations. An ambiguous ID supplies no source form. */
function realForms(
	ctx: ReadContext,
	owner: DraftModule,
): Map<string, DraftForm | null> {
	const found = new Map<string, DraftForm | null>();
	const aligned = ctx.input.modules[owner.index];
	if (aligned?.kind !== "aligned") return found;
	for (const form of owner.forms) {
		const source = aligned.forms[form.index];
		if (source?.xmlns !== form.xmlns) continue;
		const id = ctx.input.listedFormsUseReadIds
			? source.source.readUniqueId
			: source.uniqueId;
		found.set(id, found.has(id) ? null : form);
	}
	return found;
}

export interface SharedFormLink {
	readonly route: DraftModule;
	readonly form: DraftForm;
	readonly json: JsonCursor;
	readonly id: string;
}

export function readSharedFormMenus(
	ctx: ReadContext,
	app: DraftApp,
): SharedFormLink[] {
	const links: SharedFormLink[] = [];
	const byId = new Map(app.modules.map((menu) => [menu.uniqueId, menu]));
	const children = new Map<string, DraftModule[]>();
	for (const menu of app.modules) {
		const parent = menu.json.peek("root_module_id");
		if (typeof parent !== "string" || !parent) continue;
		const siblings = children.get(parent);
		if (siblings) siblings.push(menu);
		else children.set(parent, [menu]);
	}
	for (const route of app.modules) {
		if (route.docType !== "ShadowModule") continue;
		const json = route.json;
		const sourceId = json.peek("source_module_id");
		const owner = typeof sourceId === "string" ? byId.get(sourceId) : undefined;
		if (!owner || owner.docType === "ShadowModule") {
			json.refuse("source_module_id", C.uneditableSource);
			continue;
		}
		// HQ creates exactly one linked submenu for every owning child. A
		// reread must keep the IDs of the existing menus, so filling a gap
		// locally would change the next publish without the author's consent.
		const expected = (children.get(owner.uniqueId) ?? []).filter(
			(child) => child.docType !== "ShadowModule",
		);
		const listed = (children.get(route.uniqueId) ?? []).filter(
			(child) => child.docType === "ShadowModule",
		);
		const ownParent = json.peek("root_module_id") || null;
		const parent =
			typeof ownParent === "string" ? byId.get(ownParent) : undefined;
		const ownerParent = owner.json.peek("root_module_id") || null;
		if (
			(parent?.docType !== "ShadowModule" &&
				(ownParent === null || parent) &&
				ownParent !== ownerParent) ||
			expected.some(
				(child) =>
					listed.filter(
						(menu) => menu.json.peek("source_module_id") === child.uniqueId,
					).length !== 1,
			)
		) {
			ctx.accounting.findingAt(
				C.incompleteChildren,
				route.place,
				`${json.pointer}/source_module_id`,
			);
		}
		const menuUuid = json.take(
			"source_module_id",
			C.source,
			() => owner.uuid,
		).value;
		json.take("shadow_module_version", C.version, (value) => value).value;
		json.drop("case_type", C.storedType);
		const actual = realForms(ctx, owner);
		const excluded = json.peek("excluded_form_ids") ?? [];
		const excludedUuids: Uuid[] = [];
		if (
			!Array.isArray(excluded) ||
			excluded.some((id) => typeof id !== "string" || !actual.get(id))
		) {
			json.refuse("excluded_form_ids", C.missingExclusion);
		} else {
			const skips = new Set(excluded);
			excludedUuids.push(
				...json.take(
					"excluded_form_ids",
					skips.size > 0 ? C.excluded : C.allForms,
					() =>
						[...actual.entries()].flatMap(([id, form]) =>
							skips.has(id) && form ? [form.uuid] : [],
						),
				).value,
			);
		}

		const stored = json.peek("form_session_endpoints") ?? [];
		const named = new Set<string>();
		if (
			!Array.isArray(stored) ||
			stored.some((row) => {
				if (
					!isJsonObject(row) ||
					typeof row.form_id !== "string" ||
					typeof row.session_endpoint_id !== "string"
				)
					return true;
				const form = actual.get(row.form_id);
				if (!form || named.has(row.form_id)) return true;
				named.add(row.form_id);
				return false;
			})
		) {
			json.refuse("form_session_endpoints", C.missingTarget);
		} else if (stored.length === 0) {
			json.drop("form_session_endpoints", C.noEndpoints);
		} else if (!owner.json.peek("case_type")) {
			// HQ's menu settings page cannot save these links on a menu listing
			// one with no case type (`basicCaseSlots.ts::listedFormLinksSavable`).
			json.refuse("form_session_endpoints", C.surveyEndpoints);
		} else {
			const children = json.list(
				"form_session_endpoints",
				"ShadowFormEndpoint",
				C.endpoints,
			);
			for (const [index, child] of children.entries()) {
				const form = actual.get(stored[index].form_id);
				if (!form) continue;
				child.take("form_id", C.endpointForm, () => form.uuid).value;
				links.push({
					route,
					form,
					json: child,
					id: stored[index].session_endpoint_id,
				});
			}
		}
		ctx.writeDraft(() => {
			// The remaining reader stages inspect the inherited type while they read details.
			// The assembled document derives it from the source as every editor does.
			const type = owner.json.peek("case_type");
			if (typeof type === "string" && type) route.module.caseType = type;
			route.module.formsFromMenu = {
				menuUuid,
				...(excludedUuids.length && { excludedFormUuids: excludedUuids }),
			};
		});
	}
	return links;
}
