/**
 * Custom TipTap node extension for CommCare hashtag references.
 *
 * Renders #form/, #case/, #user/ references as inline atom chips within
 * TipTap editors. The node stores three attributes:
 *   - refType: 'form' | 'case' | 'user' — determines color and icon
 *   - path: the property/field path (e.g. "patient_name", "group1/age")
 *   - label: human-readable display text (falls back to path)
 *
 * Round-trips through HTML via <span data-commcare-ref data-ref-type data-path data-label>.
 *
 * Markdown round-trip is bidirectional and happens inside the markdown pipeline
 * — no post-mount hydration step is needed:
 *   - Serialize: writes bare `#type/path` hashtags (canonical internal format).
 *   - Parse:     a markdown-it inline rule tokenizes `#type/path` and renders
 *                it as `<span data-commcare-ref …>`, which the `parseHTML` spec
 *                below then upgrades to a commcareRef node during PM document
 *                construction. Because the chip nodes exist in the doc before
 *                any React NodeView is mounted, TipTap's `ReactRenderer`
 *                creates their renderers via its `queueMicrotask` path
 *                (`isEditorContentInitialized` is still false during
 *                `createNodeViews`) — so we never trigger a `flushSync` from
 *                inside a React effect, and the user sees chips on first paint.
 *
 * Backspace-to-revert: when the cursor is right after a commcareRef node,
 * backspace converts it back to raw text minus the last character, causing
 * the suggestion popup to re-trigger on the partial match.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { HASHTAG_REF_PATTERN } from "@/lib/references/config";
import { ReferenceProvider } from "@/lib/references/provider";
import { CommcareRefView } from "./CommcareRefView";

/**
 * Anchored copy of the shared hashtag pattern — scans from `state.pos` forward
 * only. Keeps the canonical pattern (`HASHTAG_REF_PATTERN`) as the single source
 * of truth; this file adds the `^` anchor so we can use `RegExp.exec` against
 * `src.slice(pos)` without over-matching earlier content.
 */
const ANCHORED_HASHTAG_RE = new RegExp(`^${HASHTAG_REF_PATTERN.source}`);

/**
 * Per-instance flag marking a MarkdownIt object as already configured with our
 * inline rule + renderer. tiptap-markdown's `MarkdownParser.parse()` calls every
 * extension's `parse.setup(md)` on every parse invocation against the same `md`
 * instance — without this guard, repeated `setContent` / blur-then-edit cycles
 * would splice duplicate rules into the inline ruler forever. The marker lives
 * on `md` itself so two editors (each with their own parser) configure their
 * own `md` independently.
 */
const SETUP_MARKER = "__novaCommcareRefSetup__" as const;

/**
 * markdown-it inline rule: consume `#form/path`, `#case/path`, `#user/path` and
 * emit a single `commcare_ref` token. Registered before the `text` rule so
 * hashtags never get absorbed into a plain-text run. Returning `false` yields
 * back to the ruler so other rules at the same position can try.
 *
 * `silent` mode is used by markdown-it during link-label scanning and similar
 * lookahead — we still match (to report success), but don't emit tokens.
 */
function tokenizeCommcareRef(state: StateInline, silent: boolean): boolean {
	/* Fast-fail: inline ruler iterates every position; a charCode check rejects
	 * non-'#' positions in a single instruction before we hit the regex. */
	if (state.src.charCodeAt(state.pos) !== 0x23 /* '#' */) return false;

	const match = ANCHORED_HASHTAG_RE.exec(state.src.slice(state.pos));
	if (!match) return false;

	if (!silent) {
		const token = state.push("commcare_ref", "", 0);
		token.content = match[0];
		token.markup = match[0];
		token.meta = { raw: match[0] };
	}

	state.pos += match[0].length;
	return true;
}

/**
 * Renderer for the `commcare_ref` token type. Emits `<span data-commcare-ref>`
 * with the data attributes that `CommcareRef.parseHTML` below reads back. The
 * span is empty on purpose — the React NodeView (`CommcareRefView`) paints the
 * chip visuals; the span only needs to survive parse-to-doc conversion with its
 * attributes intact.
 *
 * Label defaults to `path` (the only thing derivable from markdown alone);
 * `CommcareRefView` resolves a richer label via `ReferenceProvider` at render
 * time so unrelated markdown loads don't have to know about the live blueprint.
 */
function renderCommcareRef(
	tokens: Token[],
	idx: number,
	/* Remaining renderer-rule args (options, env, renderer self) are unused —
	 * the token's `meta` carries everything we need. Typed as `unknown` to
	 * avoid importing markdown-it's Options namespace just to discard it. */
	_opts: unknown,
	_env: unknown,
	_self: unknown,
): string {
	const raw = (tokens[idx].meta as { raw: string } | null)?.raw ?? "";
	const parsed = ReferenceProvider.parse(raw);
	/* Defensive: our tokenizer only emits tokens that already passed the
	 * HASHTAG_REF_PATTERN, so `parse` should never fail here. Fall back to
	 * escaped text if it does, to avoid injecting malformed HTML. */
	if (!parsed) return escapeHtml(raw);
	const refType = escapeHtml(parsed.type);
	const path = escapeHtml(parsed.path);
	return `<span data-commcare-ref data-ref-type="${refType}" data-path="${path}" data-label="${path}"></span>`;
}

/**
 * Minimal HTML attribute escaper — markdown-it's `utils.escapeHtml` exists but
 * isn't on the static types in `@types/markdown-it`, and we'd rather not reach
 * into `md.utils` from a pure rendering function. The character set below is
 * the standard OWASP attribute-value escape list.
 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export const CommcareRef = Node.create({
	name: "commcareRef",
	group: "inline",
	inline: true,
	atom: true,

	/**
	 * Markdown round-trip spec consumed by tiptap-markdown via `getMarkdownSpec`.
	 *
	 * - `serialize`: PM doc → markdown string. Write the canonical `#type/path`
	 *   form so content stays stable across save/load.
	 * - `parse.setup`: called by `MarkdownParser.parse()` on every parse against
	 *   the editor's shared `md` instance. We register a `commcare_ref` inline
	 *   rule + HTML renderer so markdown-it produces `<span data-commcare-ref>`
	 *   directly; the PM DOM parser then upgrades those spans to commcareRef
	 *   nodes via `parseHTML` during `EditorState.create` — before any React
	 *   NodeView exists, which sidesteps TipTap's `flushSync` renderer path.
	 */
	addStorage() {
		return {
			markdown: {
				serialize(
					state: { write: (s: string) => void },
					node: { attrs: { refType: string; path: string } },
				) {
					state.write(`#${node.attrs.refType}/${node.attrs.path}`);
				},
				parse: {
					setup(md: MarkdownIt) {
						/* Idempotent: avoid splicing duplicate rules each time the
						 * parser is invoked on this same `md` instance. */
						const markedMd = md as MarkdownIt & Record<string, boolean>;
						if (markedMd[SETUP_MARKER]) return;
						markedMd[SETUP_MARKER] = true;

						md.inline.ruler.before("text", "commcare_ref", tokenizeCommcareRef);
						md.renderer.rules.commcare_ref = renderCommcareRef;
					},
				},
			},
		};
	},

	/** Node attributes mapping to the Reference type's fields. */
	addAttributes() {
		return {
			/** Reference namespace: 'form' | 'case' | 'user'. */
			refType: { default: "form" },
			/** Property/field path within the namespace. */
			path: { default: "" },
			/** Human-readable label (used for accessibility, falls back to path). */
			label: { default: "" },
		};
	},

	/**
	 * Parse from HTML: reads data attributes from <span data-commcare-ref>.
	 * The `el` param is always an HTMLElement here because the tag selector
	 * already matched — the cast is safe.
	 */
	parseHTML() {
		return [
			{
				tag: "span[data-commcare-ref]",
				getAttrs: (el) => {
					const dom = el as HTMLElement;
					return {
						refType: dom.getAttribute("data-ref-type") ?? "form",
						path: dom.getAttribute("data-path") ?? "",
						label: dom.getAttribute("data-label") ?? dom.textContent ?? "",
					};
				},
			},
		];
	},

	/** Serialize to HTML: produces <span data-commcare-ref ...>label</span>. */
	renderHTML({ node, HTMLAttributes }) {
		return [
			"span",
			mergeAttributes(HTMLAttributes, {
				"data-commcare-ref": "",
				"data-ref-type": node.attrs.refType,
				"data-path": node.attrs.path,
				"data-label": node.attrs.label,
			}),
			node.attrs.label || node.attrs.path,
		];
	},

	/** Render via React NodeView for rich chip display with icon and styling. */
	addNodeView() {
		return ReactNodeViewRenderer(CommcareRefView, { as: "span" });
	},

	addKeyboardShortcuts() {
		return {
			/**
			 * Backspace-to-revert: when the cursor is immediately after a
			 * commcareRef node, delete the node and insert its raw text minus
			 * the last character. This exposes the partial text (e.g.
			 * "#form/patient_nam") and re-triggers the suggestion popup.
			 */
			Backspace: ({ editor }) => {
				const { state } = editor;
				const { $anchor } = state.selection;

				if (!state.selection.empty) return false;

				const posBefore = $anchor.pos;
				if (posBefore <= 0) return false;

				const nodeBefore = state.doc.resolve(posBefore).nodeBefore;
				if (!nodeBefore || nodeBefore.type.name !== "commcareRef") return false;

				/* Build the canonical form and trim the last character for re-suggestion. */
				const raw = `#${nodeBefore.attrs.refType}/${nodeBefore.attrs.path}`;
				const reverted = raw.slice(0, -1);
				const nodeStart = posBefore - nodeBefore.nodeSize;

				editor
					.chain()
					.focus()
					.command(({ tr }) => {
						tr.delete(nodeStart, posBefore);
						tr.insertText(reverted, nodeStart);
						return true;
					})
					.run();

				return true;
			},
		};
	},
});
