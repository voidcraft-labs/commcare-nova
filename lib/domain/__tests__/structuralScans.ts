/**
 * The structural lookups as they were written before their answers were
 * remembered by settled document parts (`lib/domain/settled.ts`): one scan of
 * `formOrder`, or one walk of the module preorder, per question. The property
 * tests hold each fast path equal to these, so the oracle is independent of
 * the paths under test.
 */
import { expect } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { menuFormUuidsOf } from "@/lib/domain/menuForms";
import {
	type MenuScreen,
	menuScreenContributors,
	menuScreenEntries,
	menuScreenKey,
	menuScreenOf,
	menuTileScreenOf,
} from "@/lib/domain/menuScreens";
import { projectedModulePreorder } from "@/lib/domain/moduleHierarchy";
import { moduleHasCaseListMenuItem } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";

/** Which menus list a form, by a scan of `formOrder` per question. */
export const scan = {
	first(formOrder: Record<string, readonly string[]>, form: string) {
		for (const [moduleUuid, forms] of Object.entries(formOrder))
			if (forms.includes(form)) return moduleUuid;
		return undefined;
	},
	all(formOrder: Record<string, readonly string[]>, form: string) {
		const modules: string[] = [];
		for (const [moduleUuid, forms] of Object.entries(formOrder))
			if (forms.includes(form)) modules.push(moduleUuid);
		return modules;
	},
	sorted(formOrder: Record<string, readonly string[]>, form: string) {
		for (const moduleUuid of Object.keys(formOrder).sort())
			if (formOrder[moduleUuid]?.includes(form)) return moduleUuid;
		return undefined;
	},
	ordered(
		doc: {
			formOrder: Record<string, readonly string[]>;
			moduleOrder: readonly string[];
		},
		form: string,
	) {
		for (const moduleUuid of doc.moduleOrder)
			if (doc.formOrder[moduleUuid]?.includes(form)) return moduleUuid;
		return undefined;
	},
};

/** What each menu screen lists, by one walk of the module preorder per question. */
export const screensScan = {
	contributors(doc: BlueprintDoc, screen: MenuScreen): Uuid[] {
		const key = menuScreenKey(screen);
		return projectedModulePreorder(doc).filter(
			(moduleUuid) => menuScreenKey(menuScreenOf(doc, moduleUuid)) === key,
		);
	},
	entries(doc: BlueprintDoc, screen: MenuScreen) {
		const key = menuScreenKey(screen);
		const entries: unknown[] = [];
		for (const moduleUuid of projectedModulePreorder(doc)) {
			const mod = doc.modules[moduleUuid];
			if (mod === undefined) continue;
			if (menuScreenKey(menuScreenOf(doc, moduleUuid)) === key) {
				for (const formUuid of menuFormUuidsOf(doc, moduleUuid))
					entries.push({ kind: "form", moduleUuid, formUuid });
				if (moduleHasCaseListMenuItem(mod))
					entries.push({ kind: "case-list", moduleUuid });
				continue;
			}
			const tile = menuTileScreenOf(doc, moduleUuid);
			if (tile !== undefined && menuScreenKey(tile) === key)
				entries.push({ kind: "menu", moduleUuid });
		}
		return entries;
	},
};

/** Every screen of `doc`: the first menu, each module's, and one absent. */
function screensOf(doc: BlueprintDoc): MenuScreen[] {
	return [
		{ kind: "first-menu" },
		...Object.keys(doc.modules).map((moduleUuid) => ({
			kind: "menu" as const,
			moduleUuid: moduleUuid as Uuid,
		})),
		{ kind: "menu", moduleUuid: testUuid("screens-absent") },
	];
}

/** Each screen of `doc` lists what the walk over `oracle` lists. */
export function expectScreensAgree(
	doc: BlueprintDoc,
	oracle: BlueprintDoc,
): void {
	for (const screen of screensOf(doc)) {
		expect(menuScreenContributors(doc, screen)).toEqual(
			screensScan.contributors(oracle, screen),
		);
		expect(menuScreenEntries(doc, screen)).toEqual(
			screensScan.entries(oracle, screen),
		);
	}
}
