/**
 * Small pieces the steps share: the typed walk with each node's lexical
 * context and the notice's entity references.
 */

import {
	type ExpressionNode,
	expressionChildren,
} from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { expressionChildContext } from "@/lib/domain/expression/typeChecker";
import type { CheckPath } from "@/lib/domain/expression/types";
import type { NoticeEntityRef } from "@/lib/notices/migrationNotice";
import type { RawDocument } from "../oldShape";
import type { SlotState } from "./working";

/** The longest name a notice entry stores (`migrationNotice.ts`). */
const NOTICE_TEXT_MAX = 200;

/** An authored name as a notice stores it, cut to the row's limit. */
export function noticeText(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	return text.length <= NOTICE_TEXT_MAX ? text : text.slice(0, NOTICE_TEXT_MAX);
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

/** The form a field belongs to, by walking `fieldOrder` up to a form. */
export function formOfField(
	raw: RawDocument,
	fieldUuid: string,
): string | undefined {
	const parents = new Map<string, string>();
	for (const [parent, children] of Object.entries(raw.fieldOrder))
		for (const child of children) parents.set(child, parent);
	let cursor: string | undefined = fieldUuid;
	const seen = new Set<string>();
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		if (Object.hasOwn(raw.forms, cursor)) return cursor;
		cursor = parents.get(cursor);
	}
	return undefined;
}

/** The form that holds a slot: its owner form, or its owner field's form. */
export function slotForm(
	raw: RawDocument,
	slot: SlotState,
): string | undefined {
	return slot.owner.entity === "form"
		? slot.owner.uuid
		: slot.owner.entity === "field"
			? formOfField(raw, slot.owner.uuid)
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
