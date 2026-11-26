import {
	type BlueprintDoc,
	childModuleUuids,
	entityTargetKey,
	type Uuid,
} from "@/lib/domain";
import { referencingSlotsOf } from "./referenceIndex";

export type ModuleChildDependentsPlan =
	| { readonly kind: "clear" }
	| {
			readonly kind: "blocked";
			readonly childUuids: readonly Uuid[];
			readonly message: string;
			readonly userMessage: string;
	  };

/** Child menus that must be moved or removed before their parent can leave. */
export function planModuleChildDependentsOnRemove(
	doc: BlueprintDoc,
	parentModuleUuid: Uuid,
): ModuleChildDependentsPlan {
	const indexed = referencingSlotsOf(doc, entityTargetKey(parentModuleUuid));
	const selectors = doc.moduleOrder.filter((uuid) =>
		indexed.get(uuid)?.includes("module_case_parent"),
	);
	if (selectors.length > 0) {
		const names = selectors
			.map((uuid) => `"${doc.modules[uuid]?.name ?? uuid}"`)
			.join(", ");
		const message = `This menu supplies parent records to ${names}. Change their parent selection before removing it.`;
		return {
			kind: "blocked",
			childUuids: selectors,
			message,
			userMessage: message,
		};
	}
	const routes = doc.moduleOrder.filter((uuid) => {
		const menu = doc.modules[uuid];
		return (
			indexed.get(uuid)?.includes("listed_forms_source") &&
			!(
				menu?.parentModuleUuid &&
				doc.modules[menu.parentModuleUuid]?.formsFromMenu
			)
		);
	});
	if (routes.length) {
		const names = routes
			.map((uuid) => `“${doc.modules[uuid].name}”`)
			.join(", ");
		const message = `This menu supplies forms to ${names}. Choose another source for those menus or remove them first.`;
		return {
			kind: "blocked",
			childUuids: routes,
			message,
			userMessage: message,
		};
	}
	const children = childModuleUuids(doc, parentModuleUuid).filter(
		(uuid) =>
			indexed.get(uuid)?.includes("module_parent") &&
			!(
				doc.modules[parentModuleUuid]?.formsFromMenu &&
				doc.modules[uuid]?.formsFromMenu
			),
	);
	if (children.length === 0) return { kind: "clear" };
	const names = children.map((uuid) => `"${doc.modules[uuid]?.name ?? uuid}"`);
	const listed = names.join(", ");
	return {
		kind: "blocked",
		childUuids: children,
		message: `This module still contains ${children.length === 1 ? "the child menu" : "child menus"} ${listed}. Move or remove ${children.length === 1 ? "it" : "them"} first.`,
		userMessage: `${children.length === 1 ? "Move or remove the child menu" : "Move or remove the child menus"} ${listed} before removing this menu.`,
	};
}
