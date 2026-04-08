"use client";
import { Popover } from "@base-ui/react/popover";
import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import {
	bracketMatching,
	indentOnInput,
	indentUnit,
} from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, tooltips } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { xpathAutocomplete } from "@/lib/codemirror/xpath-autocomplete";
import { xpathChips } from "@/lib/codemirror/xpath-chips";
import { formatXPath, prettyPrintXPath } from "@/lib/codemirror/xpath-format";
import { xpath } from "@/lib/codemirror/xpath-language";
import {
	type XPathLintContext,
	xpathLinter,
} from "@/lib/codemirror/xpath-lint";
import {
	novaAutocompleteTheme,
	novaChipTheme,
	novaXPathTheme,
} from "@/lib/codemirror/xpath-theme";
import { ReferenceProvider } from "@/lib/references/provider";
import { useReferenceProvider } from "@/lib/references/ReferenceContext";
import {
	collectCaseProperties,
	collectValidPaths,
} from "@/lib/services/commcare/validate/index";
import { validateXPath } from "@/lib/services/commcare/validate/xpathValidator";
import { POPOVER_POPUP_CLS } from "@/lib/styles";

// ── Read-only theme ────────────────────────────────────────────────────

/** Minimal CodeMirror chrome for the static display state. */
const readOnlyTheme = EditorView.theme({
	"&": {
		fontSize: "12px",
		fontFamily: "var(--font-nova-mono)",
		background: "var(--nova-surface)",
		borderRadius: "6px",
		border: "1px solid rgba(139, 92, 246, 0.1)",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { overflow: "visible", padding: "6px 8px" },
	".cm-content": {
		padding: 0,
		caretColor: "transparent",
		fontFamily: "var(--font-nova-mono)",
	},
	".cm-line": { padding: 0 },
	".cm-activeLine": { backgroundColor: "transparent" },
	".cm-selectionBackground": { backgroundColor: "transparent !important" },
	".cm-cursor": { display: "none" },
});

const baseReadOnlyExtensions = [
	xpath(),
	EditorView.editable.of(false),
	EditorState.readOnly.of(true),
	EditorState.tabSize.of(4),
	EditorView.lineWrapping,
	readOnlyTheme,
];

// ── Editing theme ──────────────────────────────────────────────────────

/** Compact CodeMirror chrome for the inline editing state. */
const editingTheme = EditorView.theme({
	"&": {
		fontSize: "12px",
		fontFamily: "var(--font-nova-mono)",
		background: "var(--nova-surface)",
		borderRadius: "6px",
		maxHeight: "200px",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { overflow: "auto", padding: "6px 8px" },
	".cm-content": { padding: 0, fontFamily: "var(--font-nova-mono)" },
	".cm-line": { padding: "1px 0" },
	".cm-activeLine": { backgroundColor: "rgba(139, 92, 246, 0.06)" },
});

/** Base extensions shared across all inline editing instances. */
const baseEditingExtensions = [
	indentUnit.of("    "),
	xpath(),
	indentOnInput(),
	bracketMatching(),
	EditorView.lineWrapping,
	editingTheme,
];

// ── Props ──────────────────────────────────────────────────────────────

interface XPathFieldProps {
	/** The XPath expression value. */
	value: string;
	/** Callback to save the edited value. Presence enables click-to-edit. */
	onSave?: (value: string) => void;
	/** Context getter for linting and autocomplete. Required when onSave is present. */
	getLintContext?: () => XPathLintContext | undefined;
	/** Start in editing mode immediately (for newly added fields). */
	autoEdit?: boolean;
	/** Called when editing state changes (used by parent to guard dismiss handlers). */
	onEditingChange?: (editing: boolean) => void;
}

// ── Component ──────────────────────────────────────────────────────────

/**
 * Inline XPath expression field with dual-mode rendering.
 *
 * **Read-only** (no `onSave`): Static CodeMirror display with syntax
 * highlighting and reference chips. Zero interactivity.
 *
 * **Editable** (`onSave` provided): Click to activate a full CodeMirror
 * editor with autocomplete, linting, bracket matching, and reference chips.
 * Cmd/Ctrl+Enter validates and saves. Escape cancels (reverts). Blur with
 * errors shakes and refocuses (holds the editor open). Invalid expressions
 * cannot be saved — a rose tooltip shows the validation error message on
 * rejected save attempts.
 *
 * Hashtag references render as styled chips automatically when a
 * ReferenceProvider is available via context.
 */
export function XPathField({
	value,
	onSave,
	getLintContext,
	autoEdit,
	onEditingChange,
}: XPathFieldProps) {
	const [editing, setEditing] = useState(autoEdit ?? false);
	const provider = useReferenceProvider();
	/** Viewport coordinates of the activation click for cursor placement. */
	const clickPosRef = useRef<{ x: number; y: number } | null>(null);

	/* Notify parent when editing state changes. */
	useEffect(() => {
		onEditingChange?.(editing);
	}, [editing, onEditingChange]);

	// ── Read-only extensions (memoized on provider) ────────────────────

	const readOnlyExtensions = useMemo(() => {
		if (!provider) return baseReadOnlyExtensions;
		return [...baseReadOnlyExtensions, xpathChips(provider), novaChipTheme];
	}, [provider]);

	// ── Read-only / idle states ────────────────────────────────────────

	if (!editing) {
		const formatted = prettyPrintXPath(value);
		const display = (
			<CodeMirror
				value={formatted}
				theme={novaXPathTheme}
				extensions={readOnlyExtensions}
				basicSetup={false}
				editable={false}
			/>
		);

		/* No onSave = pure read-only display. */
		if (!onSave) return display;

		/* Editable idle — show static display with hover chrome. */
		return (
			<button
				type="button"
				onClick={(e) => {
					clickPosRef.current = { x: e.clientX, y: e.clientY };
					setEditing(true);
				}}
				className="w-full text-left cursor-pointer rounded-md border border-transparent hover:border-nova-violet/30 transition-colors p-0"
			>
				{display}
			</button>
		);
	}

	// ── Editing state ──────────────────────────────────────────────────

	return (
		<InlineXPathEditor
			value={value}
			onSave={(v) => {
				clickPosRef.current = null;
				const normalized = formatXPath(v);
				/* Always propagate empty commits — the parent needs the callback
				 * to clean up addable-field state (e.g. xpathField.clear(),
				 * setAddingCondition(false)). Skip only non-empty no-ops. */
				if (!normalized.trim() || normalized !== formatXPath(value)) {
					onSave?.(normalized);
				}
				/* setEditing after the save callback so the external store
				 * update (from onSave → notifyBlueprintChanged) and the local
				 * state update batch in the same React render cycle. Calling
				 * setEditing first could trigger a synchronous re-render via
				 * useSyncExternalStore before the save fires. */
				setEditing(false);
			}}
			onCancel={() => {
				clickPosRef.current = null;
				setEditing(false);
			}}
			getLintContext={getLintContext}
			provider={provider}
			clickPosition={clickPosRef.current}
		/>
	);
}

// ── Inline editor sub-component ────────────────────────────────────────

interface InlineXPathEditorProps {
	value: string;
	onSave: (draft: string) => void;
	/** Cancel editing and revert to the original value (no save). */
	onCancel: () => void;
	getLintContext?: () => XPathLintContext | undefined;
	provider: ReferenceProvider | null;
	clickPosition: { x: number; y: number } | null;
}

/**
 * Full CodeMirror editor rendered inline, replacing the static XPathField
 * display. Supports autocomplete, linting, reference chips, and bracket
 * matching.
 *
 * **Save gate:** Cmd/Ctrl+Enter and blur both validate the expression
 * before committing. If valid, the value is saved. If the expression has
 * errors, a FloatingUI tooltip shows the first error message and the editor
 * shakes. Cmd/Ctrl+Enter stays open after shaking; blur shakes then
 * refocuses (holds the editor open). Invalid XPath can never be persisted.
 *
 * **Edit guard:** Registers a builder-level guard that blocks `select()`
 * while the editor has unsaved invalid content. First navigation attempt
 * warns (shake + tooltip); second attempt allows through.
 *
 * **Cancel:** Escape always cancels (reverts to the original value).
 * Uses stopPropagation to prevent parent popover dismiss from closing
 * the containing popover.
 */
function InlineXPathEditor({
	value,
	onSave,
	onCancel,
	getLintContext,
	provider: _provider,
	clickPosition,
}: InlineXPathEditorProps) {
	const builder = useBuilderEngine();
	const editorRef = useRef<ReactCodeMirrorRef>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	/** Guards against double-fire: once save or cancel runs, block the other. */
	const doneRef = useRef(false);
	const [shaking, setShaking] = useState(false);

	// ── Error tooltip ───────────────────────────────────────────────────

	const [tooltipMessage, setTooltipMessage] = useState<string | null>(null);

	/* Auto-dismiss tooltip after 4 seconds. */
	useEffect(() => {
		if (!tooltipMessage) return;
		const timer = setTimeout(() => setTooltipMessage(null), 4000);
		return () => clearTimeout(timer);
	}, [tooltipMessage]);

	// ── Lint context & chip provider ────────────────────────────────────

	/* Stable ref so closures always read the latest getLintContext getter. */
	const getLintContextRef = useRef(getLintContext);
	getLintContextRef.current = getLintContext;

	/* ReferenceProvider for chip resolution — shares the same getter. */
	const chipProvider = useMemo(
		() => new ReferenceProvider(() => getLintContextRef.current?.()),
		[],
	);

	// ── Validation & save gate ──────────────────────────────────────────

	/**
	 * Return validation error messages for the current editor content.
	 * Uses the same `validateXPath` + context as the CodeMirror linter so
	 * the result is always consistent with the inline diagnostics.
	 */
	const getErrors = useCallback((): string[] => {
		const draft = editorRef.current?.view?.state.doc.toString() ?? "";
		if (!draft.trim()) return [];
		const ctx = getLintContextRef.current?.();
		const validPaths = ctx?.form.questions
			? collectValidPaths(ctx.form.questions)
			: undefined;
		const caseProperties = ctx
			? collectCaseProperties(ctx.blueprint, ctx.moduleCaseType)
			: undefined;
		return validateXPath(draft, validPaths, caseProperties).map(
			(e) => e.message,
		);
	}, []);

	/** Trigger the reject shake animation on the editor wrapper. */
	const shake = useCallback(() => {
		setShaking(true);
		setTimeout(() => setShaking(false), 400);
	}, []);

	/**
	 * Attempt to save. If the expression has validation errors, reject with
	 * a shake animation, error tooltip, and refocus instead of committing.
	 */
	const save = useCallback(() => {
		if (doneRef.current) return;
		const errors = getErrors();
		if (errors.length > 0) {
			shake();
			setTooltipMessage(errors[0]);
			editorRef.current?.view?.focus();
			return;
		}
		doneRef.current = true;
		builder.clearEditGuard();
		const draft = editorRef.current?.view?.state.doc.toString() ?? "";
		onSave(draft);
	}, [onSave, getErrors, shake, builder]);

	/** Cancel editing — revert to the original value without saving. */
	const cancel = useCallback(() => {
		if (doneRef.current) return;
		doneRef.current = true;
		builder.clearEditGuard();
		onCancel();
	}, [onCancel, builder]);

	const saveRef = useRef(save);
	saveRef.current = save;
	const cancelRef = useRef(cancel);
	cancelRef.current = cancel;
	const getErrorsRef = useRef(getErrors);
	getErrorsRef.current = getErrors;
	const shakeRef = useRef(shake);
	shakeRef.current = shake;

	// ── Builder edit guard (two-strike pattern) ─────────────────────────

	/** Tracks whether the user has been warned about errors blocking navigation. */
	const warnedRef = useRef(false);

	useEffect(() => {
		builder.setEditGuard(() => {
			const errors = getErrorsRef.current();
			if (errors.length === 0) return true;
			/* First strike: warn, block navigation. */
			if (!warnedRef.current) {
				warnedRef.current = true;
				shakeRef.current();
				setTooltipMessage(errors[0]);
				return false;
			}
			/* Second strike: allow navigation through. */
			builder.clearEditGuard();
			return true;
		});
		return () => builder.clearEditGuard();
	}, [builder]);

	/* Cmd/Ctrl+Enter saves (with validation gate). Highest precedence so
	 * basicSetup keymaps can't intercept it. */
	const saveKeymap = useMemo(
		() =>
			Prec.highest(
				keymap.of([
					{
						key: "Mod-Enter",
						run: () => {
							saveRef.current();
							return true;
						},
					},
				]),
			),
		[],
	);

	/**
	 * DOM-level Escape handler with stopPropagation. Runs before CodeMirror's
	 * internal keymap handlers, so we must check for active autocomplete first:
	 * if the completion dropdown is showing, close it (first Escape). Second
	 * Escape cancels editing and reverts to the original value. stopPropagation
	 * on all Escape presses prevents parent popover dismiss from closing the panel.
	 */
	const escapeDom = useMemo(
		() =>
			EditorView.domEventHandlers({
				keydown: (e, view) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						/* If autocomplete is active, dismiss it instead of canceling. */
						if (completionStatus(view.state) !== null) {
							closeCompletion(view);
							return true;
						}
						cancelRef.current();
						return true;
					}
					return false;
				},
			}),
		[],
	);

	/* Dismiss tooltip and reset two-strike guard when the user types. */
	const tooltipDismissExt = useMemo(
		() =>
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					setTooltipMessage(null);
					warnedRef.current = false;
				}
			}),
		[],
	);

	const extensions = useMemo(
		() => [
			...baseEditingExtensions,
			/* Portal tooltips to body so they aren't clipped by overflow on
			 * ancestor panels (ContextualEditor, FormSettingsPanel). */
			tooltips({ parent: document.body }),
			xpathLinter(() => getLintContextRef.current?.()),
			xpathAutocomplete(() => getLintContextRef.current?.()),
			xpathChips(chipProvider),
			novaAutocompleteTheme,
			novaChipTheme,
			saveKeymap,
			escapeDom,
			tooltipDismissExt,
		],
		[chipProvider, saveKeymap, escapeDom, tooltipDismissExt],
	);

	return (
		<div
			ref={wrapperRef}
			className={`rounded-md border border-nova-violet/50 ${shaking ? "xpath-shake" : ""}`}
		>
			<CodeMirror
				ref={editorRef}
				value={prettyPrintXPath(value)}
				theme={novaXPathTheme}
				extensions={extensions}
				autoFocus
				onCreateEditor={(view) => {
					/* Place cursor at click position when available, otherwise at end. */
					if (clickPosition) {
						const pos = view.posAtCoords(clickPosition);
						if (pos != null) {
							view.dispatch({ selection: { anchor: pos } });
							return;
						}
					}
					const end = view.state.doc.length;
					view.dispatch({ selection: { anchor: end } });
				}}
				onBlur={() => {
					/* Delay to detect transient blur from autocomplete tooltip
					 * interactions (portal-mounted to body). Save if valid; shake
					 * and refocus if errors — invalid XPath never persists, but the
					 * editor holds focus so the user can fix errors or press Esc. */
					requestAnimationFrame(() => {
						if (editorRef.current?.view?.hasFocus) return;
						if (document.activeElement?.closest(".cm-tooltip")) return;
						const errors = getErrorsRef.current();
						if (errors.length > 0) {
							/* If the edit guard already warned on this interaction (user
							 * clicked a navigation target), skip the duplicate shake/tooltip
							 * — the guard already provided the visual feedback. */
							if (!warnedRef.current) {
								shakeRef.current();
								setTooltipMessage(errors[0]);
							}
							/* Refocus immediately so Escape works without waiting for the
							 * shake animation to finish. The shake is CSS-only on the wrapper
							 * div — unaffected by focus state. */
							editorRef.current?.view?.focus();
						} else {
							saveRef.current();
						}
					});
				}}
				basicSetup={{
					lineNumbers: false,
					highlightActiveLine: true,
					highlightActiveLineGutter: false,
					foldGutter: false,
					autocompletion: false,
					searchKeymap: false,
				}}
			/>
			<Popover.Root open={!!tooltipMessage}>
				<Popover.Portal>
					<Popover.Positioner
						side="top"
						align="start"
						sideOffset={6}
						collisionPadding={8}
						anchor={wrapperRef}
						className="z-popover-top"
					>
						<Popover.Popup className={POPOVER_POPUP_CLS}>
							<div
								role="alert"
								className="px-2.5 py-1.5 rounded-md bg-[rgba(16,16,36,0.95)] border border-nova-rose/20 shadow-lg max-w-xs"
							>
								<p className="text-xs text-nova-rose font-mono leading-snug">
									{tooltipMessage}
								</p>
								<p className="text-[10px] text-nova-text-muted mt-0.5">
									Press Esc to discard changes
								</p>
							</div>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}
