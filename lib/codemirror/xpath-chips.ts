/**
 * CodeMirror 6 extension for rendering hashtag references as inline chips.
 *
 * Packages five facets into a single Extension array:
 *   1. ViewPlugin + MatchDecorator — scan viewport for #type/path patterns,
 *      replace with chip widgets via Decoration.replace
 *   2. atomicRanges — make chip decoration ranges atomic for cursor navigation
 *   3. transactionFilter — intercept backspace on atomic ranges to delete only
 *      the last character (backspace-to-revert behavior)
 *   4. domEventHandlers — drop (insert #type/path at drop position) and
 *      dragstart (serialize chip to DataTransfer)
 *
 * The document always stores the canonical "#type/path" text — chips are
 * purely visual decorations. This preserves XPath evaluation fidelity.
 */

import { startCompletion } from "@codemirror/autocomplete";
import {
	type ChangeSpec,
	EditorState,
	type Extension,
	StateEffect,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	MatchDecorator,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { createChipElement } from "@/lib/references/chipDom";
import { HASHTAG_REF_PATTERN, REF_TYPE_CONFIG } from "@/lib/references/config";
import type { ReferenceProvider } from "@/lib/references/provider";
import type { Reference, ReferenceTypeConfig } from "@/lib/references/types";

// ── Widget ──────────────────────────────────────────────────────────────

class ChipWidget extends WidgetType {
	constructor(
		private ref: Reference,
		private config: ReferenceTypeConfig,
	) {
		super();
	}

	eq(other: ChipWidget): boolean {
		return this.ref.raw === other.ref.raw && this.ref.label === other.ref.label;
	}

	toDOM(): HTMLElement {
		return createChipElement(this.ref, this.config);
	}

	ignoreEvent(event: Event): boolean {
		/* Let drag events bubble so the dragstart handler can serialize the chip. */
		return event.type === "dragstart";
	}
}

// ── MatchDecorator + ViewPlugin ─────────────────────────────────────────

/**
 * Build a ViewPlugin that scans the viewport for hashtag references and
 * decorates them with chip widgets. The provider resolves labels from
 * the live blueprint.
 */
function buildChipPlugin(provider: ReferenceProvider) {
	/** MatchDecorator requires a global regex for viewport scanning. */
	const globalPattern = new RegExp(HASHTAG_REF_PATTERN, "g");
	const matcher = new MatchDecorator({
		regexp: globalPattern,
		decoration: (match, _view, _pos) => {
			const raw = match[0];
			const ref = provider.resolve(raw);
			/* Only decorate references that actually exist in the blueprint.
         Unknown refs (e.g. after backspace-to-revert removes the last char)
         stay as raw text so the user can see and edit them. */
			if (!ref) return null;
			const config = REF_TYPE_CONFIG[ref.type];
			return Decoration.replace({ widget: new ChipWidget(ref, config) });
		},
	});

	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = matcher.createDeco(view);
			}
			update(update: ViewUpdate) {
				this.decorations = matcher.updateDeco(update, this.decorations);
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

// ── Atomic ranges ───────────────────────────────────────────────────────

/**
 * Makes chip decoration ranges atomic so arrow keys skip over them as a
 * single unit. Reads from the chip ViewPlugin's decoration set.
 */
function buildAtomicRanges(plugin: ReturnType<typeof buildChipPlugin>) {
	return EditorView.atomicRanges.of((view) => {
		return view.plugin(plugin)?.decorations ?? Decoration.none;
	});
}

// ── Backspace-to-revert filter ──────────────────────────────────────────

/** Signals that a chip was reverted to raw text, triggering autocomplete. */
const chipRevertEffect = StateEffect.define<null>();

/**
 * Transaction filter that intercepts atomic-delete on backspace. Instead of
 * deleting the entire chip range (which atomicRanges normally produces), it
 * deletes only the last character of the matched text. This causes the
 * provider to stop resolving the reference, exposing the raw text.
 * Attaches a chipRevertEffect so the autocomplete listener can re-open.
 */
const backspaceRevert = EditorState.transactionFilter.of((tr) => {
	if (!tr.isUserEvent("delete.backward")) return tr;

	/* Track whether we need to modify the transaction. */
	let modified = false;
	const newChanges: ChangeSpec[] = [];
	let newAnchor = -1;

	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		const deletedText = tr.startState.doc.sliceString(fromA, toA);
		const isChipRange = HASHTAG_REF_PATTERN.test(deletedText);

		if (isChipRange && inserted.length === 0 && deletedText.length > 1) {
			/* Delete only the last character instead of the whole chip. */
			newChanges.push({ from: toA - 1, to: toA });
			newAnchor = toA - 1;
			modified = true;
		} else {
			/* Pass through unmodified. */
			newChanges.push({ from: fromA, to: toA, insert: inserted });
			newAnchor = fromA;
		}
	});

	if (!modified) return tr;

	return {
		changes: newChanges,
		selection: newAnchor >= 0 ? { anchor: newAnchor } : undefined,
		effects: chipRevertEffect.of(null),
		userEvent: "delete.backward",
	};
});

/** Re-opens autocomplete after a chip is reverted to raw text. */
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

// ── Public factory ──────────────────────────────────────────────────────

/**
 * Create a CodeMirror extension that renders hashtag references as inline
 * chips with atomic cursor behavior, backspace-to-revert, and drag/drop.
 */
export function xpathChips(provider: ReferenceProvider): Extension {
	const plugin = buildChipPlugin(provider);
	return [
		plugin,
		buildAtomicRanges(plugin),
		backspaceRevert,
		revertAutocomplete,
	];
}
