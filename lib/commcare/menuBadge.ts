import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { DatumRef } from "@/lib/domain/expression/types";
import {
	makeTranslationUnitId,
	type TranslationUnitId,
} from "@/lib/domain/localization";
import type { MenuBadge } from "@/lib/domain/menuBadge";
import type { Uuid } from "@/lib/domain/uuid";
import { requireExpressionContext } from "./expressionContext";
import { hqXPath } from "./hqJson/xpath";
import type { CommCareLocalization } from "./localization";
import type { LookupWireNaming } from "./lookup/naming";
import { menuBadgeExpression } from "./suite/displayConditions";
import type { WireExpr } from "./xpath/wire/tree";

export type ProjectedMenuBadge =
	| { kind: "text"; unit: TranslationUnitId; text: string }
	| { kind: "calculation"; expression: WireExpr };

export function projectMenuBadge(
	doc: BlueprintDoc,
	owner: { kind: "module" | "form"; uuid: Uuid },
	badge: MenuBadge | undefined,
	lookup?: LookupWireNaming,
	selectedCaseId?: string,
	datumId?: (ref: DatumRef) => string | undefined,
): ProjectedMenuBadge | undefined {
	if (!badge) return undefined;
	if (badge.kind === "text")
		return {
			kind: "text",
			unit: makeTranslationUnitId(owner.kind, owner.uuid, "badge"),
			text: badge.text,
		};
	const ref =
		owner.kind === "module"
			? ({ entity: "module", uuid: owner.uuid, slot: "module_badge" } as const)
			: ({ entity: "form", uuid: owner.uuid, slot: "form_badge" } as const);
	return {
		kind: "calculation",
		expression: menuBadgeExpression(
			badge.expression,
			requireExpressionContext(doc, ref, lookup),
			lookup,
			selectedCaseId,
			datumId,
		),
	};
}

/** CustomIcon.form is the schema default "badge". The editor sets
 * exactly one text dictionary or XPath on the first icon. */
export function hqMenuBadges(
	badge: ProjectedMenuBadge | undefined,
	localization: CommCareLocalization,
) {
	if (!badge) return [];
	return [
		{
			doc_type: "CustomIcon",
			form: "badge",
			text: badge.kind === "text" ? localization.textMap(badge.unit) : {},
			xpath: badge.kind === "calculation" ? hqXPath(badge.expression) : null,
		},
	];
}
