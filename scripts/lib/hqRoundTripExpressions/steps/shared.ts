/**
 * Small pieces the steps share: the typed walk with each node's lexical
 * context and the notice's entity references.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type ExpressionNode,
	expressionChildren,
} from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { expressionChildContext } from "@/lib/domain/expression/typeChecker";
import type { CheckPath } from "@/lib/domain/expression/types";
import { formOfField as formHoldingField } from "@/lib/domain/fieldForm";
import type { Uuid } from "@/lib/domain/uuid";
import {
	NOTICE_TEXT_MAX,
	type NoticeEntityRef,
} from "@/lib/notices/migrationNotice";
import type { RawDocument } from "../oldShape";
import type { SlotState } from "./working";

/**
 * An authored name or detail value as a notice entry stores it: at most
 * `NOTICE_TEXT_MAX` UTF-16 units, the length the entry's schema counts, cut
 * between code points, so a character outside the Basic Multilingual Plane
 * is kept whole or left out and never leaves half of its surrogate pair,
 * which no `jsonb` value holds. A lone surrogate already in the text
 * becomes U+FFFD for the same reason.
 */
export function noticeText(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	let cut = "";
	for (const point of text) {
		const code = point.codePointAt(0) ?? 0;
		const whole = code >= 0xd800 && code <= 0xdfff ? "\ufffd" : point;
		if (cut.length + whole.length > NOTICE_TEXT_MAX) break;
		cut += whole;
	}
	return cut;
}

/** The app, as an `app` entry names it. */
export function appEntity(raw: RawDocument): NoticeEntityRef {
	return { type: "app", nameAtMigration: noticeText(raw.appName) };
}

/** The display name of an entity: a field by its id, a form or module by its name. */
export function entityName(
	raw: RawDocument,
	kind: "field" | "form" | "module",
	uuid: string,
): string {
	const records =
		kind === "field" ? raw.fields : kind === "form" ? raw.forms : raw.modules;
	const entity = Object.hasOwn(records, uuid) ? records[uuid] : undefined;
	return noticeText(kind === "field" ? entity?.id : entity?.name);
}

/** Each raw document's `fieldParent`, from its `fieldOrder`, built once. */
const fieldParents = new WeakMap<
	RawDocument["fieldOrder"],
	Record<Uuid, Uuid>
>();

function fieldParentOf(raw: RawDocument): Record<Uuid, Uuid> {
	let parents = fieldParents.get(raw.fieldOrder);
	if (parents === undefined) {
		parents = {};
		for (const [parent, children] of Object.entries(raw.fieldOrder))
			for (const child of children) parents[child as Uuid] = parent as Uuid;
		fieldParents.set(raw.fieldOrder, parents);
	}
	return parents;
}

/** The form that holds a slot: its owner form, or its owner field's form. */
export function slotForm(
	raw: RawDocument,
	slot: SlotState,
): string | undefined {
	return slot.owner.entity === "form"
		? slot.owner.uuid
		: slot.owner.entity === "field"
			? formHoldingField(
					{
						forms: raw.forms as unknown as BlueprintDoc["forms"],
						fieldParent: fieldParentOf(raw),
					},
					slot.owner.uuid,
				)
			: undefined;
}

/**
 * Pre-order over every expression and term with the context the checker
 * gives it: a row query's predicates see its row, a form step's filter sees
 * its step, and so on (`expressionChildContext`).
 */
export function walkWithContext(
	node: ExpressionNode,
	ctx: ExpressionContext,
	visit: (
		node: ExpressionNode,
		ctx: ExpressionContext,
		path: CheckPath,
		parent: ExpressionNode | undefined,
	) => void,
	path: CheckPath = [],
	parent?: ExpressionNode,
): void {
	visit(node, ctx, path, parent);
	for (const child of expressionChildren(node, path)) {
		if (child.kind === "relation") continue;
		walkWithContext(
			child.value,
			expressionChildContext(node, child, ctx),
			visit,
			child.path,
			node,
		);
	}
}
