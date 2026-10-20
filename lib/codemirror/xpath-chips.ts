/**
 * Identity chips for form expressions.
 *
 * The editor text is parsed with the slot's own scope, and each identity
 * leaf whose spelling is a machine name of something the person knows by
 * another name is drawn as a chip over its parse span: a question (in every
 * spelling, relative included) as its label, worker information, a Search
 * answer, a data table's instance path as the table's name and its columns,
 * a session value as what it holds, a search's results as "What the search
 * found", and a choice as its option's label. Case properties and case
 * types stay text: their names are what a person reads. Text that does not
 * parse has no chips.
 *
 * The document always holds the text; chips are decorations. A chip range
 * is atomic for the cursor, and backspace over one deletes only its last
 * character, which unparses it and shows the text again.
 */

import { startCompletion } from "@codemirror/autocomplete";
import {
	type ChangeSpec,
	EditorState,
	type Extension,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import type { IconifyIcon } from "@iconify/react/offline";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerListCheck from "@iconify-icons/tabler/list-check";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerTable from "@iconify-icons/tabler/table";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import {
	type FormSyntax,
	readFormSyntax,
} from "@/lib/commcare/xpath/formSyntax";
import {
	BUILT_IN_USER_PROPERTIES,
	fieldRegistry,
	type ProseTemplate,
	projectProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { expressionChildren } from "@/lib/domain/expression/children";
import { spanKey } from "@/lib/domain/expression/spans";
import {
	type CheckPath,
	type Expression,
	isExpression,
	type Term,
} from "@/lib/domain/expression/types";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { userPropertiesOf } from "@/lib/domain/users";
import { createLabeledChipElement } from "@/lib/references/chipDom";
import { REF_TYPE_CONFIG } from "@/lib/references/config";
import type { ReferenceType } from "@/lib/references/types";
import {
	datumLabel,
	type ExpressionEditorContext,
	fieldLabel,
} from "./expressionEditorContext";

/** One chip: the span it covers and what it reads as. */
export interface ExpressionChip {
	readonly from: number;
	readonly to: number;
	readonly label: string;
	readonly type: ReferenceType;
	readonly icon?: IconifyIcon;
}

type Span = { readonly from: number; readonly to: number };

/** The syntax nodes of a parse, by their exact bounds, outermost first. */
function syntaxByBounds(root: FormSyntax): ReadonlyMap<string, FormSyntax> {
	const byBounds = new Map<string, FormSyntax>();
	const visit = (node: FormSyntax): void => {
		const key = `${node.from}:${node.to}`;
		if (!byBounds.has(key)) byBounds.set(key, node);
		switch (node.kind) {
			case "group":
			case "negative":
			case "axis":
				visit(node.value);
				break;
			case "child":
				if (node.left !== undefined) visit(node.left);
				visit(node.step);
				break;
			case "filter":
				visit(node.base);
				visit(node.where);
				break;
			case "binary":
				visit(node.left);
				visit(node.right);
				break;
			case "call":
				node.args.forEach(visit);
				break;
			default:
				break;
		}
	};
	visit(root);
	return byBounds;
}

/** The innermost row of a filtered path: its root path, or with `keep`
 * the last filter whose base is that root (a search's related-case
 * exclusion belongs to its root). */
function rowRoot(node: FormSyntax, keepFirstFilter = false): FormSyntax {
	let current = node;
	while (current.kind === "filter") {
		if (keepFirstFilter && current.base.kind !== "filter") return current;
		current = current.base;
	}
	return current;
}

/**
 * The chips of `text` under the editor's scope. Pure, so the editor and a
 * test read one function.
 */
export function expressionChips(
	text: string,
	context: ExpressionEditorContext | undefined,
): readonly ExpressionChip[] {
	if (context === undefined || text.trim() === "") return [];
	const parsed = parseFormExpression(text, context.scope);
	if (!parsed.ok || parsed.expression === undefined) return [];
	const syntax = readFormSyntax(text);
	if (!syntax.ok || syntax.node === undefined) return [];
	const bounds = syntaxByBounds(syntax.node);
	const { doc, lookup } = context.scope;
	const chips: ExpressionChip[] = [];
	const add = (
		span: Span | undefined,
		label: string | undefined,
		type: ReferenceType,
		icon?: IconifyIcon,
	) => {
		if (span === undefined || label === undefined || label === "") return;
		if (span.from >= span.to || span.to > text.length) return;
		chips.push({ from: span.from, to: span.to, label, type, icon });
	};
	const syntaxAt = (span: Span | undefined) =>
		span === undefined ? undefined : bounds.get(`${span.from}:${span.to}`);
	const table = (id: LookupTableId) =>
		lookup === "unavailable" ? undefined : lookup.get(id);
	const ownCaseType = Object.values(doc.modules).find((module) =>
		doc.formOrder[module.uuid]?.includes(context.reference.formUuid as Uuid),
	)?.caseType;

	const termChip = (term: Term, span: Span) => {
		switch (term.kind) {
			case "field": {
				const uuid =
					term.role === undefined && term.filters === undefined
						? term.uuid
						: undefined;
				if (uuid === undefined) return;
				const declared =
					context.scope.form?.fields.get(uuid) ?? doc.fields[uuid];
				if (declared === undefined) return;
				add(
					span,
					fieldLabel(doc, uuid, declared.id),
					"form",
					fieldRegistry[declared.kind]?.icon,
				);
				return;
			}
			case "session-user-property":
				add(span, userPropertiesOf(doc)[term.userPropertyUuid]?.label, "user");
				return;
			case "session-user":
				add(
					span,
					BUILT_IN_USER_PROPERTIES.find((each) => each.slug === term.field)
						?.label,
					"user",
				);
				return;
			case "input":
				add(
					span,
					searchInputLabel(doc, term.searchInputUuid),
					"form",
					tablerSearch,
				);
				return;
			case "session-datum":
				add(
					span,
					datumLabel(doc, term.datum, ownCaseType),
					"case",
					tablerDatabase,
				);
				return;
			case "table-column":
				add(
					span,
					table(term.tableId)?.columns.find(
						(column) => column.id === term.columnId,
					)?.label,
					"case",
					tablerTable,
				);
				return;
			case "choice":
				add(
					span,
					choiceLabel(doc, term.field, term.options),
					"form",
					tablerListCheck,
				);
				return;
			default:
				return;
		}
	};

	const expressionChip = (node: Expression, span: Span) => {
		const at = syntaxAt(span);
		if (at === undefined) return;
		if (node.kind === "table-rows")
			add(rowRoot(at), table(node.tableId)?.name, "case", tablerTable);
		else if (node.kind === "table-lookup") {
			const found = table(node.tableId);
			if (at.kind !== "child" || at.left === undefined) return;
			add(rowRoot(at.left), found?.name, "case", tablerTable);
			add(
				at.step,
				found?.columns.find((column) => column.id === node.resultColumnId)
					?.label,
				"case",
				tablerTable,
			);
		} else if (node.kind === "cases" && node.source === "search-results")
			add(rowRoot(at, true), "What the search found", "case", tablerSearch);
	};

	const visit = (
		node: Expression | Term,
		path: CheckPath,
		parent: Span | undefined,
	): void => {
		const span = parsed.spans.get(spanKey(path));
		// A node the parser placed at its parent's bounds has no span of its
		// own, so it gets no chip. A term shares its wrapper's span, so it is
		// compared with the wrapper's parent.
		const own =
			span !== undefined &&
			(parent === undefined ||
				span.from !== parent.from ||
				span.to !== parent.to);
		if (own && syntaxAt(span) !== undefined) {
			if (isExpression(node)) expressionChip(node, span);
			else termChip(node, span);
		}
		const wrapper = isExpression(node) && node.kind === "term";
		for (const child of expressionChildren(node, path))
			if (child.kind !== "relation")
				visit(child.value, child.path, wrapper ? parent : span);
	};
	visit(parsed.expression, [], undefined);

	// Overlapping spans (a malformed parse) keep the first, in text order.
	const sorted = [...chips].sort((a, b) => a.from - b.from || b.to - a.to);
	const kept: ExpressionChip[] = [];
	for (const chip of sorted) {
		const last = kept[kept.length - 1];
		if (last === undefined || chip.from >= last.to) kept.push(chip);
	}
	return kept;
}

function searchInputLabel(
	doc: ExpressionEditorContext["scope"]["doc"],
	uuid: Uuid,
): string | undefined {
	for (const module of Object.values(doc.modules)) {
		const input = module.caseListConfig?.searchInputs.find(
			(each) => each.uuid === uuid,
		);
		if (input !== undefined) return input.label || input.name;
	}
	return undefined;
}

function choiceLabel(
	doc: ExpressionEditorContext["scope"]["doc"],
	field: Uuid,
	options: readonly Uuid[],
): string | undefined {
	const declared = doc.fields[field];
	const source =
		declared !== undefined && "optionsSource" in declared
			? declared.optionsSource
			: undefined;
	if (source?.kind !== "inline") return undefined;
	const labels = options.map((uuid) => {
		const option = source.options.find((each) => each.uuid === uuid);
		if (option === undefined) return undefined;
		const label = projectProseTemplate(option.label as ProseTemplate, doc).text;
		return label.trim() === "" ? option.value : label;
	});
	return labels.every((label): label is string => label !== undefined)
		? labels.join(", ")
		: undefined;
}

// ── Widget ──────────────────────────────────────────────────────────────

class ChipWidget extends WidgetType {
	constructor(
		private readonly chip: ExpressionChip,
		private readonly raw: string,
	) {
		super();
	}

	eq(other: ChipWidget): boolean {
		return (
			this.raw === other.raw &&
			this.chip.label === other.chip.label &&
			this.chip.type === other.chip.type &&
			this.chip.icon === other.chip.icon
		);
	}

	toDOM(): HTMLElement {
		return createLabeledChipElement(
			{
				type: this.chip.type,
				raw: this.raw,
				label: this.chip.label,
				icon: this.chip.icon,
			},
			REF_TYPE_CONFIG[this.chip.type],
		);
	}

	ignoreEvent(event: Event): boolean {
		/* Let drag events bubble so a drag handler can serialize the chip. */
		return event.type === "dragstart";
	}
}

/** Recomputes the chips without a text change, after the context's
 * document moved under the editor (a peer renamed what a chip names). */
export const refreshExpressionChips = StateEffect.define<null>();

/** Signals that a chip was reverted to text, triggering autocomplete. */
const chipRevertEffect = StateEffect.define<null>();

function chipField(
	getContext: () => ExpressionEditorContext | undefined,
): StateField<DecorationSet> {
	const build = (state: EditorState): DecorationSet => {
		const text = state.doc.toString();
		return Decoration.set(
			expressionChips(text, getContext()).map((chip) =>
				Decoration.replace({
					widget: new ChipWidget(chip, text.slice(chip.from, chip.to)),
				}).range(chip.from, chip.to),
			),
		);
	};
	return StateField.define<DecorationSet>({
		create: build,
		update(value, tr) {
			return tr.docChanged ||
				tr.effects.some((effect) => effect.is(refreshExpressionChips))
				? build(tr.state)
				: value;
		},
		provide: (field) => [
			EditorView.decorations.from(field),
			EditorView.atomicRanges.of((view) => view.state.field(field)),
		],
	});
}

/**
 * Backspace over a chip deletes only its last character instead of the
 * whole atomic range, so the text stops parsing as that identity and shows
 * again, and completion reopens on it.
 */
function backspaceRevert(field: StateField<DecorationSet>) {
	return EditorState.transactionFilter.of((tr) => {
		if (!tr.isUserEvent("delete.backward")) return tr;
		const chips = tr.startState.field(field, false);
		if (chips === undefined) return tr;
		let modified = false;
		const changes: ChangeSpec[] = [];
		let anchor = -1;
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			let whole = false;
			chips.between(fromA, toA, (from, to) => {
				if (from === fromA && to === toA) whole = true;
			});
			if (whole && inserted.length === 0 && toA - fromA > 1) {
				changes.push({ from: toA - 1, to: toA });
				anchor = toA - 1;
				modified = true;
			} else {
				changes.push({ from: fromA, to: toA, insert: inserted });
				anchor = fromA;
			}
		});
		if (!modified) return tr;
		return {
			changes,
			selection: anchor >= 0 ? { anchor } : undefined,
			effects: chipRevertEffect.of(null),
			userEvent: "delete.backward",
		};
	});
}

/** Re-opens autocomplete after a chip is reverted to text. */
const revertAutocomplete = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			for (const tr of update.transactions) {
				if (tr.effects.some((e) => e.is(chipRevertEffect))) {
					/* Defer to the next microtask so the editor state is fully settled. */
					queueMicrotask(() => startCompletion(update.view));
				}
			}
		}
	},
);

/** The chip extension over the slot's editor context. */
export function xpathChips(
	getContext: () => ExpressionEditorContext | undefined,
): Extension {
	const field = chipField(getContext);
	return [field, backspaceRevert(field), revertAutocomplete];
}
