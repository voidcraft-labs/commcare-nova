import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import { type BlueprintDoc, moduleUuidOfForm, type Uuid } from "@/lib/domain";
import { resolveAppLanguage } from "@/lib/domain/localization";
import {
	projectLocalizedForm,
	projectLocalizedModule,
} from "@/lib/domain/localizedBlueprintProjection";
import { previewScreenEntries } from "../menuProjection";
import { AppTestActionError } from "./errors";
import {
	type AppTestAuthoredAction,
	type AppTestExpectation,
	type AppTestSessionState,
	appTestActionSchema,
} from "./types";

function one(
	value: string,
	candidates: readonly { uuid: Uuid; names: readonly string[] }[],
	label: string,
): Uuid {
	const exact = candidates.find((item) => item.uuid === value);
	if (exact) return exact.uuid;
	const found = candidates.filter((item) => item.names.includes(value));
	if (found.length !== 1)
		throw new AppTestActionError(
			`${label} ${value} is ${found.length ? "ambiguous" : "not available in this scope"}.`,
		);
	return found[0].uuid;
}
function menu(doc: BlueprintDoc, value: string, language?: string) {
	return one(
		value,
		Object.values(doc.modules).map((item) => ({
			uuid: item.uuid,
			names: [
				item.name,
				projectLocalizedModule(
					doc,
					resolveAppLanguage(doc.localization, language),
					item.uuid,
				)?.name ?? item.name,
			],
		})),
		"Menu",
	);
}
/** The menus whose forms a form name may address on the current screen: a
 *  home or menu screen's own forms and those of every menu that shows its
 *  forms there (`previewScreenEntries`); a record list's or a form's own
 *  menu; any menu on Android's home screen. */
function formAddressModules(
	doc: BlueprintDoc,
	state: AppTestSessionState,
): ReadonlySet<Uuid> | undefined {
	const screen = state.screen;
	if (screen.kind === "device-home") return undefined;
	if (screen.kind === "home" || screen.kind === "menu")
		return new Set(
			previewScreenEntries(
				doc,
				screen.kind === "home"
					? { kind: "first-menu" }
					: { kind: "menu", moduleUuid: screen.moduleUuid },
			).flatMap((entry) => (entry.kind === "form" ? [entry.moduleUuid] : [])),
		);
	return new Set([screen.moduleUuid]);
}

function form(
	doc: BlueprintDoc,
	value: string,
	moduleUuids?: ReadonlySet<Uuid>,
	language?: string,
) {
	return one(
		value,
		Object.values(doc.forms)
			.filter((item) => {
				const owner = moduleUuidOfForm(doc, item.uuid);
				return (
					moduleUuids === undefined ||
					(owner !== undefined && moduleUuids.has(owner))
				);
			})
			.map((item) => ({
				uuid: item.uuid,
				names: [
					item.name,
					projectLocalizedForm(
						doc,
						resolveAppLanguage(doc.localization, language),
						item.uuid,
					)?.name ?? item.name,
				],
			})),
		"Form",
	);
}

/** Bind against the authorized pinned state at EACH action, after receipt lookup.
 * Earlier actions in the same request may have changed the current form. */
export function bindAppTestAction(
	doc: BlueprintDoc,
	state: AppTestSessionState,
	action: AppTestAuthoredAction,
) {
	let bound = action;
	switch (action.kind) {
		case "section": {
			if (state.screen.kind !== "form")
				throw new AppTestActionError("Open a form before choosing a section.");
			const formUuid = state.screen.formUuid;
			const candidates = Object.values(doc.fields).flatMap((field) => {
				if (
					field.kind !== "section" ||
					findContainingForm(doc, field.uuid) !== formUuid
				)
					return [];
				const path = computeFieldPath(doc, field.uuid);
				return path === undefined ? [] : [{ uuid: field.uuid, path }];
			});
			const path = action.sectionUuid
				.replace(/^#form\//, "")
				.replace(/^\/data\//, "");
			const exact = candidates.filter(
				(item) => item.uuid === action.sectionUuid || item.path === path,
			);
			const scoped = exact.length
				? exact
				: candidates.filter(
						(item) => item.path.split("/").at(-1) === action.sectionUuid,
					);
			bound = {
				...action,
				sectionUuid: one(
					action.sectionUuid,
					scoped.map((item) => ({
						uuid: item.uuid,
						names: [action.sectionUuid],
					})),
					"Section",
				),
			};
			break;
		}
		case "menu":
			bound = {
				...action,
				moduleUuid: menu(doc, action.moduleUuid, state.language),
			};
			break;
		case "records":
			if (action.moduleUuid !== undefined)
				bound = {
					...action,
					moduleUuid: menu(doc, action.moduleUuid, state.language),
				};
			break;
		case "form":
			bound = {
				...action,
				formUuid: form(
					doc,
					action.formUuid,
					formAddressModules(doc, state),
					state.language,
				),
			};
			break;
		case "identity":
			bound = {
				...action,
				personaUuid:
					action.personaUuid === null
						? null
						: one(
								action.personaUuid,
								Object.values(doc.personas ?? {}).map((item) => ({
									uuid: item.uuid,
									names: [item.name],
								})),
								"Preview identity",
							),
			};
			break;
	}
	return appTestActionSchema.parse(bound);
}

export function appTestExpectationMismatch(
	doc: BlueprintDoc,
	state: AppTestSessionState,
	observation: Record<string, unknown>,
	expect?: AppTestExpectation,
): string | undefined {
	if (!expect) return;
	const screen = state.screen;
	/* `home` is met on the module list and on Android's home screen alike;
	 * the observation names which one the session is on. */
	if (
		expect.screen !== undefined &&
		observation.screen !== expect.screen &&
		!(expect.screen === "home" && observation.screen === "device-home")
	)
		return `Expected ${expect.screen}; observed ${String(observation.screen)}.`;
	if (
		expect.submitted !== undefined &&
		(observation.savedInTest === true) !== expect.submitted
	)
		return expect.submitted
			? "The expected submission did not commit."
			: "A submission committed unexpectedly.";
	if (
		expect.moduleUuid !== undefined &&
		(screen.kind === "home" ||
			screen.kind === "device-home" ||
			screen.moduleUuid !== menu(doc, expect.moduleUuid, state.language))
	)
		return "The observed menu differs from the expected destination.";
	if (
		expect.formUuid !== undefined &&
		(screen.kind !== "form" ||
			screen.formUuid !==
				form(
					doc,
					expect.formUuid,
					new Set([screen.moduleUuid]),
					state.language,
				))
	)
		return "The observed form differs from the expected destination.";
}
