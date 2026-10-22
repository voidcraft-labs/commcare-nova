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
import { useRegisterEditGuard } from "@/components/builder/contexts/EditGuardContext";
import {
	REJECTION_SURFACE_CLS,
	RejectionBody,
} from "@/components/builder/RejectionNotice";
import {
	reconcileXPathDraft,
	type XPathDraftReading,
} from "@/components/builder/xpathDraftReconciliation";
import type { ExpressionEditorContext } from "@/lib/codemirror/expressionEditorContext";
import { xpathAutocomplete } from "@/lib/codemirror/xpath-autocomplete";
import {
	refreshExpressionChips,
	xpathChips,
} from "@/lib/codemirror/xpath-chips";
import { xpath } from "@/lib/codemirror/xpath-language";
import { xpathDiagnostics, xpathLinter } from "@/lib/codemirror/xpath-lint";
import {
	novaAutocompleteTheme,
	novaChipTheme,
	novaXPathTheme,
} from "@/lib/codemirror/xpath-theme";
import { useExpressionScopeRevision } from "@/lib/doc/hooks/useXPathSlots";
import type { CommitOutcome } from "@/lib/domain";
import { FLOATING_LAYER_CLS, POPOVER_POPUP_CLS } from "@/lib/styles";

// ── Read-only theme ────────────────────────────────────────────────────

/** Read-only content chrome: font, padding, no caret/selection. The box
 *  (border + fill) lives on the WRAPPER, not here: the editable-idle state
 *  gets its well from the wrapping button (so the field reads as one
 *  element), and the standalone read-only display layers
 *  `readOnlyStandaloneBox` on top. */
const readOnlyBaseTheme = EditorView.theme({
	"&": {
		fontSize: "12px",
		fontFamily: "var(--font-nova-mono)",
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

/** Box chrome for the standalone read-only display (no editable button to
 *  supply the border + fill). */
const readOnlyStandaloneBox = EditorView.theme({
	"&": {
		background: "var(--nova-surface)",
		borderRadius: "6px",
		border: "1px solid var(--nova-border)",
	},
});

const baseReadOnlyExtensions = [
	xpath(),
	EditorView.editable.of(false),
	EditorState.readOnly.of(true),
	EditorState.tabSize.of(4),
	EditorView.lineWrapping,
	readOnlyBaseTheme,
];

// ── Editing theme ──────────────────────────────────────────────────────

/** Compact CodeMirror chrome for the inline editing state. Chromeless like
 *  the read-only base: the wrapper div owns the well (border + fill). */
const editingTheme = EditorView.theme({
	"&": {
		fontSize: "12px",
		fontFamily: "var(--font-nova-mono)",
		maxHeight: "200px",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { overflow: "auto", padding: "6px 8px" },
	".cm-content": { padding: 0, fontFamily: "var(--font-nova-mono)" },
	".cm-line": { padding: "1px 0" },
	".cm-activeLine": { backgroundColor: "var(--nova-violet-wash)" },
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

const XPATH_PROJECTION_CONFLICT_MESSAGE =
	"This condition changed elsewhere in the same text you were editing. Press Esc to load the shared version, then reapply your edit.";

// ── Props ──────────────────────────────────────────────────────────────

interface XPathFieldProps {
	/** The stored expression's canonical text, as its slot's projection
	 *  prints it (laid out over lines past the printer's width). */
	value: string;
	/** Callback to save the edited value. Presence enables click-to-edit.
	 *  May return the gated dispatch's `CommitOutcome`: an `ok: false`
	 *  with messages keeps the editor OPEN with the draft intact and
	 *  surfaces the first finding in the error tooltip: the doc-level
	 *  gate sees findings the inline lint can't (cycles, type errors), and
	 *  the user's typed expression must survive the bounce. `void` reads
	 *  as committed. */
	onSave?: (value: string) => CommitOutcome | undefined;
	/** The slot's editor context: lint, autocomplete and chips read it.
	 *  Required when onSave is present; a read-only display without one
	 *  shows plain text. */
	getEditorContext?: () => ExpressionEditorContext | undefined;
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
 * cannot be saved: a rose tooltip shows the validation error message on
 * rejected save attempts.
 *
 * Identity reads render as chips over their parse spans, from the slot's
 * editor context. Saving stores the parse, and the editor closes onto the
 * canonical print of what was stored.
 */
export function XPathField({
	value,
	onSave,
	getEditorContext,
	autoEdit,
	onEditingChange,
}: XPathFieldProps) {
	const [editing, setEditing] = useState(autoEdit ?? false);
	/** Viewport coordinates of the activation click for cursor placement. */
	const clickPosRef = useRef<{ x: number; y: number } | null>(null);

	/* Notify parent when editing state changes. */
	useEffect(() => {
		onEditingChange?.(editing);
	}, [editing, onEditingChange]);

	// ── Read-only extensions (memoized on the context getter) ──────────

	/* Mounts rebuild their getter each render; the extensions read the
	 * latest one through a ref so the display is not reconfigured. */
	const readOnlyContextRef = useRef(getEditorContext);
	readOnlyContextRef.current = getEditorContext;
	const hasEditorContext = getEditorContext !== undefined;
	const readOnlyExtensions = useMemo(() => {
		if (!hasEditorContext) return baseReadOnlyExtensions;
		return [
			...baseReadOnlyExtensions,
			xpathChips(() => readOnlyContextRef.current?.()),
			novaChipTheme,
		];
	}, [hasEditorContext]);

	/* A rename can change what a chip names without changing the printed
	 * text (a question's label, a table's name), so the idle display
	 * recomputes its chips whenever what their labels resolve against
	 * moves. The chip widgets compare by label, so an unrelated edit
	 * leaves the display's DOM untouched. */
	const scopeRevision = useExpressionScopeRevision();
	const readOnlyEditorRef = useRef<ReactCodeMirrorRef>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the scope revision is what a rename changes; the chips read it through the context getter.
	useEffect(() => {
		if (!hasEditorContext) return;
		readOnlyEditorRef.current?.view?.dispatch({
			effects: refreshExpressionChips.of(null),
		});
	}, [scopeRevision, hasEditorContext]);

	/* Standalone read-only display layers its own box on top; the
	 * editable-idle state instead gets its well from the wrapping button. */
	const standaloneReadOnlyExtensions = useMemo(
		() => [...readOnlyExtensions, readOnlyStandaloneBox],
		[readOnlyExtensions],
	);

	// ── Read-only / idle states ────────────────────────────────────────

	if (!editing) {
		/* No onSave = pure read-only display, which owns its own box. */
		if (!onSave) {
			return (
				<CodeMirror
					ref={readOnlyEditorRef}
					value={value}
					theme={novaXPathTheme}
					extensions={standaloneReadOnlyExtensions}
					basicSetup={false}
					editable={false}
				/>
			);
		}

		/* Editable idle: the button IS the single well (border + fill); the
		 * CodeMirror inside is chromeless, so the field reads as one element
		 * and matches the editing box 1:1 (only the border color and
		 * interactivity change on click: no inner box, no size shift). */
		return (
			<button
				type="button"
				onClick={(e) => {
					clickPosRef.current = { x: e.clientX, y: e.clientY };
					setEditing(true);
				}}
				className="w-full text-left cursor-pointer rounded-lg border border-white/[0.06] bg-nova-deep/50 hover:border-nova-violet/30 transition-colors min-h-11 flex flex-col justify-center"
			>
				<CodeMirror
					ref={readOnlyEditorRef}
					value={value}
					theme={novaXPathTheme}
					extensions={readOnlyExtensions}
					basicSetup={false}
					editable={false}
				/>
			</button>
		);
	}

	// ── Editing state ──────────────────────────────────────────────────

	return (
		<InlineXPathEditor
			value={value}
			onSave={(v) => {
				/* Always propagate empty commits: the parent needs the callback
				 * to clean up addable-field state (e.g. xpathField.clear(),
				 * setAddingCondition(false)). Skip only an unchanged draft: the
				 * text is stored as its parse, never as typed. */
				if (!v.trim() || v !== value) {
					const outcome = onSave?.(v);
					if (outcome && outcome.ok === false && outcome.messages.length > 0) {
						/* The commit gate refused the edit: hand the rejection
						 * back so the inline editor stays open with the draft. */
						return outcome;
					}
				}
				clickPosRef.current = null;
				/* setEditing after the save callback so the external store
				 * update (from onSave → notifyBlueprintChanged) and the local
				 * state update batch in the same React render cycle. Calling
				 * setEditing first could trigger a synchronous re-render via
				 * useSyncExternalStore before the save fires. */
				setEditing(false);
				return undefined;
			}}
			onCancel={() => {
				clickPosRef.current = null;
				setEditing(false);
			}}
			getEditorContext={getEditorContext}
			clickPosition={clickPosRef.current}
		/>
	);
}

// ── Inline editor sub-component ────────────────────────────────────────

interface InlineXPathEditorProps {
	value: string;
	/** Commit the draft. A returned rejection (`ok: false` with messages)
	 *  means the doc-level gate refused: the editor stays open. */
	onSave: (draft: string) => CommitOutcome | undefined;
	/** Cancel editing and revert to the original value (no save). */
	onCancel: () => void;
	getEditorContext?: () => ExpressionEditorContext | undefined;
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
	getEditorContext,
	clickPosition,
}: InlineXPathEditorProps) {
	const projectedValue = value;
	/* The document and lookup definitions the draft's identities resolve
	 * against: a peer's rename changes them, sometimes without changing the
	 * stored expression's own text. */
	const scopeRevision = useExpressionScopeRevision();
	const editorRef = useRef<ReactCodeMirrorRef>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const baseProjectionRef = useRef(projectedValue);
	/* Set by the reconciliation effect, whose first run (a clean draft) needs
	 * no base scope. */
	const baseScopeRef = useRef<ExpressionEditorContext["scope"] | undefined>(
		undefined,
	);
	const draftRef = useRef(projectedValue);
	/* What the draft read at the last reconciliation, so the next one does
	 * not parse it again. */
	const draftReadingRef = useRef<XPathDraftReading | undefined>(undefined);
	const projectionConflictRef = useRef(false);
	const [draft, setDraft] = useState(projectedValue);
	/** Guards against double-fire: once save or cancel runs, block the other. */
	const doneRef = useRef(false);
	const [shaking, setShaking] = useState(false);
	/** Set true by a document-level mousedown outside the editor wrapper.
	 *  Read by the blur handler to distinguish genuine outside-clicks from
	 *  Chrome's contentEditable focus bounce (where blur fires but no
	 *  mousedown preceded it outside the editor). */
	const clickedOutsideRef = useRef(false);

	// ── Error tooltip ───────────────────────────────────────────────────

	const [tooltipMessage, setTooltipMessage] = useState<string | null>(null);

	/* Stable ref so closures always read the latest context getter. */
	const getEditorContextRef = useRef(getEditorContext);
	getEditorContextRef.current = getEditorContext;

	/*
	 * Identity-backed projections can change while this editor remains mounted
	 * (a peer renames a question, a choice's value, a table). A clean draft
	 * follows; a dirty one is respelled at each renamed identity's span, and
	 * any change to the stored expression itself conflicts, so the controlled
	 * CodeMirror value never erases local work.
	 */
	// biome-ignore lint/correctness/useExhaustiveDependencies: the scope revision is what a peer's rename changes; the context getter reads it.
	useEffect(() => {
		const incomingScope = getEditorContextRef.current?.()?.scope;
		const reconciled = reconcileXPathDraft({
			base: baseProjectionRef.current,
			draft: draftRef.current,
			incoming: projectedValue,
			baseScope: baseScopeRef.current,
			incomingScope,
			conflict: projectionConflictRef.current,
			reading: draftReadingRef.current,
		});
		draftReadingRef.current = reconciled.reading;
		baseProjectionRef.current = reconciled.base;
		baseScopeRef.current = incomingScope;
		draftRef.current = reconciled.draft;
		projectionConflictRef.current = reconciled.conflict;
		setDraft(reconciled.draft);
		/* The chips name what the new document calls each identity. */
		editorRef.current?.view?.dispatch({
			effects: refreshExpressionChips.of(null),
		});
		if (reconciled.conflict) {
			setTooltipMessage(XPATH_PROJECTION_CONFLICT_MESSAGE);
		}
	}, [projectedValue, scopeRevision]);

	/* Auto-dismiss tooltip after 4 seconds. */
	useEffect(() => {
		if (!tooltipMessage) return;
		const timer = setTimeout(() => setTooltipMessage(null), 4000);
		return () => clearTimeout(timer);
	}, [tooltipMessage]);

	// ── Validation & save gate ──────────────────────────────────────────

	/**
	 * Return validation error messages for the current editor content.
	 * These ARE the CodeMirror linter's diagnostics (`xpathDiagnostics`, the
	 * same context), so the save gate can never refuse with a sentence the
	 * inline lint did not show, or pass a draft it underlined: a
	 * session-scoped slot's "runs after the form has closed" reads the same
	 * on both. An editor whose actual slot disappeared refuses the save.
	 */
	const getErrors = useCallback((): string[] => {
		if (projectionConflictRef.current) {
			return [XPATH_PROJECTION_CONFLICT_MESSAGE];
		}
		const currentDraft = draftRef.current;
		if (!currentDraft.trim()) return [];
		return xpathDiagnostics(currentDraft, getEditorContextRef.current?.()).map(
			(diagnostic) => diagnostic.message,
		);
	}, []);

	/** Trigger the reject shake animation on the editor wrapper. The
	 *  `onAnimationEnd` handler on the wrapper clears `shaking` when the
	 *  CSS keyframe completes: see the `xpath-shake` utility in
	 *  `globals.css`. */
	const shake = useCallback(() => {
		setShaking(true);
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
		let outcome: CommitOutcome | undefined;
		try {
			outcome = onSave(draftRef.current);
		} catch (error) {
			outcome = {
				ok: false,
				messages: [
					error instanceof Error
						? error.message
						: "This expression could not be saved. Reopen it and try again.",
				],
			};
		}
		if (outcome && outcome.ok === false && outcome.messages.length > 0) {
			/* The doc-level commit gate refused a draft the inline lint
			 * passed (a dependency cycle, a type error: findings only the
			 * whole-doc validator can see). Stay open with the draft intact
			 * and show the finding the same way an inline lint error shows:
			 * the typed expression is never discarded. */
			doneRef.current = false;
			shake();
			setTooltipMessage(outcome.messages[0]);
			editorRef.current?.view?.focus();
		}
	}, [onSave, getErrors, shake]);

	/** Cancel editing: revert to the original value without saving. */
	const cancel = useCallback(() => {
		if (doneRef.current) return;
		doneRef.current = true;
		onCancel();
	}, [onCancel]);

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

	/* Edit guard: blocks selection changes while the editor has unsaved
	 * invalid content. The two-strike pattern ("warn then allow") lives
	 * inside the predicate: first invocation returns false and surfaces a
	 * warning; second invocation returns true, letting the selection through.
	 *
	 * `enabled` is always true while this component is mounted (it only
	 * renders during editing). Unmounting automatically deregisters via
	 * the hook's effect cleanup. */
	useRegisterEditGuard(
		useCallback(() => {
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
			return true;
		}, []),
		true,
	);

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

	// ── Click-outside detection ────────────────────────────────────────
	// Chrome's contentEditable focus management can bounce focus back to
	// cm-content when the user clicks a non-focusable ancestor element.
	// The blur handler's `hasFocus` check races with this bounce and
	// sometimes bails, requiring a second click. Instead of relying on
	// focus state in a rAF, we track mousedown-outside as the definitive
	// signal that the user intended to leave the editor.

	useEffect(() => {
		const onMousedown = (e: MouseEvent) => {
			const wrapper = wrapperRef.current;
			if (!wrapper) return;
			const target = e.target as Node;
			/* Clicks inside the editor wrapper or inside a portal-mounted
			 * autocomplete tooltip are not "outside" clicks. */
			if (
				wrapper.contains(target) ||
				(target instanceof HTMLElement && target.closest(".cm-tooltip"))
			)
				return;
			clickedOutsideRef.current = true;
		};
		document.addEventListener("mousedown", onMousedown, true);
		return () => document.removeEventListener("mousedown", onMousedown, true);
	}, []);

	const extensions = useMemo(
		() => [
			...baseEditingExtensions,
			/* Portal tooltips to body so they aren't clipped by overflow on
			 * the scrolling ancestor (the inspector rail, FormSettingsPanel). */
			tooltips({ parent: document.body }),
			xpathLinter(() => getEditorContextRef.current?.()),
			xpathAutocomplete(() => getEditorContextRef.current?.()),
			xpathChips(() => getEditorContextRef.current?.()),
			novaAutocompleteTheme,
			novaChipTheme,
			saveKeymap,
			escapeDom,
			tooltipDismissExt,
		],
		[saveKeymap, escapeDom, tooltipDismissExt],
	);

	return (
		// Filter `onAnimationEnd` on the keyframe name: animation events
		// bubble, and any descendant @keyframes (CodeMirror cursor blink, etc.)
		// would otherwise clear `shaking` mid-shake.
		<div
			ref={wrapperRef}
			onAnimationEnd={(e) => {
				if (e.animationName === "shake") setShaking(false);
			}}
			className={`rounded-lg border border-nova-violet/40 ring-1 ring-nova-violet/30 bg-nova-deep/50 min-h-11 flex flex-col justify-center ${shaking ? "xpath-shake" : ""}`}
		>
			<CodeMirror
				ref={editorRef}
				value={draft}
				theme={novaXPathTheme}
				extensions={extensions}
				autoFocus
				onChange={(next) => {
					draftRef.current = next;
					setDraft(next);
				}}
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
					/* Mousedown-outside as the authoritative blur signal.
					 * The capture-phase mousedown listener sets clickedOutsideRef
					 * synchronously before blur fires, so we can read it directly
					 * here: no rAF or setTimeout needed.
					 *
					 * This sidesteps Chrome's contentEditable focus bounce: when
					 * the user clicks a non-focusable ancestor of cm-content,
					 * Chrome fires blur → focusin (bounce) → blur. A hasFocus
					 * check in a rAF races with the bounce. The mousedown flag
					 * doesn't: it's set once, definitively, before any focus
					 * events fire.
					 *
					 * Autocomplete tooltip clicks are excluded in the mousedown
					 * listener, so transient blurs from tooltip interactions
					 * (portal-mounted to body) are ignored automatically. */
					if (!clickedOutsideRef.current) return;
					clickedOutsideRef.current = false;
					const errors = getErrorsRef.current();
					if (errors.length > 0) {
						/* If the edit guard already warned on this interaction (user
						 * clicked a navigation target), skip the duplicate shake/tooltip:
						 * the guard already provided the visual feedback. */
						if (!warnedRef.current) {
							shakeRef.current();
							setTooltipMessage(errors[0]);
						}
						/* Refocus so Escape works without waiting for the shake
						 * animation to finish. The shake is CSS-only on the wrapper
						 * div: unaffected by focus state. */
						editorRef.current?.view?.focus();
					} else {
						saveRef.current();
					}
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
						// The shared floating plane, not a popover tier: this notice
						// portals to the body, and an XPath field inside a dialog (the
						// Connect settings dialog embeds one) would otherwise raise its
						// alert BEHIND the panel that hosts the field.
						className={FLOATING_LAYER_CLS}
					>
						<Popover.Popup
							className={POPOVER_POPUP_CLS}
							// This is a notice about the active editor, not a new focus
							// destination. Opening or retiring it must preserve selection.
							initialFocus={false}
							finalFocus={false}
						>
							<div
								role="alert"
								className={`px-3 py-2.5 max-w-sm ${REJECTION_SURFACE_CLS}`}
							>
								<RejectionBody
									message={tooltipMessage ?? ""}
									hint="Press Esc to discard changes"
								/>
							</div>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}
