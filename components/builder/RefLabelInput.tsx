/**
 * TipTap-based label input with inline reference chip support.
 *
 * Replaces EditableText for the label field, adding the ability to insert
 * #form/, #<case_type>/, #user/ references that render as styled inline chips.
 * Preserves the same focus/blur/commit/cancel UX as EditableText:
 *   - Blur → save
 *   - Enter → save (single-line mode)
 *   - Cmd/Ctrl+Enter → save (multiline mode)
 *   - Escape → cancel (revert to original value)
 *   - Emerald checkmark animation on save
 *
 * The underlying document model stores canonical ProseTemplate parts.
 * Display hashtags are projections only and are never parsed back to identity.
 */

"use client";
import type { JSONContent } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import {
	canonicalProseTemplate,
	type ProseTemplate,
	proseTemplateIsEmpty,
} from "@/lib/domain";
import { displayId } from "@/lib/references/config";
import type { ReferenceProvider } from "@/lib/references/provider";
import {
	useCurrentFormUuid,
	useLiveFormUuidGetter,
	useReferenceProvider,
} from "@/lib/references/ReferenceContext";
import { CommcareRef } from "@/lib/tiptap/commcareRefNode";
import {
	proseTemplateToTiptapContent,
	tiptapContentToProseTemplate,
} from "@/lib/tiptap/proseTemplateCodec";
import { createRefSuggestion } from "@/lib/tiptap/refSuggestion";

interface RefLabelInputProps {
	label: string;
	value: ProseTemplate;
	onSave: (value: ProseTemplate) => void;
	/** Called on every content change (not just commit). Lets the canvas show chips in real-time. */
	onChange?: (value: ProseTemplate) => void;
	onEmpty?: () => void;
	dataFieldId?: string;
	multiline?: boolean;
	autoFocus?: boolean;
	selectAll?: boolean;
	/** Content rendered right-aligned in the label row (e.g. a toggle). */
	labelRight?: React.ReactNode;
}

// ── Serialization ───────────────────────────────────────────────────────

/**
 * Project canonical prose parts into TipTap JSON. References are already
 * typed atoms; hashtag-looking text stays an ordinary text node.
 */
function parseValueToContent(
	value: ProseTemplate,
	provider: ReferenceProvider | null,
	formUuid: string | undefined,
): JSONContent {
	return proseTemplateToTiptapContent(value, (part) => {
		const resolved = provider?.resolvePart(part, formUuid);
		// What the CHIP shows, which is `displayId` — not `Reference.label`, the
		// autocomplete string. The atom's `label` is the text Backspace converts
		// the chip back into, so the two have to be the same thing or that gesture
		// replaces a reference with words the author never saw.
		return resolved == null ? "" : displayId(resolved);
	}) as JSONContent;
}

/**
 * Serialize TipTap document content directly to canonical prose parts.
 */
function serializeContent(doc: JSONContent): ProseTemplate {
	return tiptapContentToProseTemplate(doc);
}

function sameTemplate(left: ProseTemplate, right: ProseTemplate): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

// ── Component ───────────────────────────────────────────────────────────

export function RefLabelInput({
	label: fieldLabel,
	value,
	onSave,
	onChange,
	onEmpty,
	dataFieldId,
	multiline,
	autoFocus,
	selectAll,
	labelRight,
}: RefLabelInputProps) {
	const labelId = useId();
	const [focused, setFocused] = useState(false);
	const [saved, setSaved] = useState(false);
	const committedRef = useRef(false);
	const valueRef = useRef(value);
	valueRef.current = value;
	/** Captures the value at focus time — used by cancel to revert to the
	 *  pre-edit state, unaffected by debounced onChange updates. */
	const savedValueRef = useRef(value);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	/* Clean up pending timers on unmount to prevent stale state updates. */
	useEffect(
		() => () => {
			clearTimeout(debounceRef.current);
			clearTimeout(savedTimerRef.current);
		},
		[],
	);

	const provider = useReferenceProvider();
	const currentFormUuid = useCurrentFormUuid();
	const getFormUuid = useLiveFormUuidGetter();

	const suggestion = useMemo(() => {
		if (!provider) return undefined;
		return createRefSuggestion(provider, getFormUuid);
	}, [provider, getFormUuid]);

	/**
	 * TipTap extension for commit/cancel keyboard shortcuts. Runs at ProseMirror
	 * keymap priority, intercepting Enter/Escape before StarterKit's handlers
	 * (which would otherwise insert a newline before our DOM listener could fire).
	 */
	const keyboardExtension = useMemo(
		() =>
			Extension.create({
				name: "labelInputKeyboard",
				addKeyboardShortcuts() {
					return {
						"Mod-Enter": () => {
							commitRef.current();
							return true;
						},
						...(!multiline
							? {
									Enter: () => {
										commitRef.current();
										return true;
									},
								}
							: {}),
					};
				},
			}),
		[multiline],
	);

	/* Only paragraphs + text + commcareRef nodes — no block-level elements. */
	const extensions = useMemo(
		() => [
			StarterKit.configure({
				/* Disable everything except paragraph — we only want inline text. */
				heading: false,
				blockquote: false,
				bulletList: false,
				orderedList: false,
				codeBlock: false,
				horizontalRule: false,
				listItem: false,
			}),
			CommcareRef,
			keyboardExtension,
			...(suggestion
				? [
						Mention.configure({
							HTMLAttributes: { class: "commcare-ref-mention" },
							suggestion,
							renderLabel: () => "",
						}),
					]
				: []),
		],
		[suggestion, keyboardExtension],
	);

	const initialContent = useMemo(
		() => parseValueToContent(value, provider, currentFormUuid),
		[value, provider, currentFormUuid],
	);

	const editor = useEditor({
		extensions,
		content: initialContent,
		immediatelyRender: false,
		/* Debounced live update — avoids a full builder notification per keystroke
       while still keeping the canvas in sync for chip insertion. */
		onUpdate: ({ editor: e }) => {
			clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				onChangeRef.current?.(serializeContent(e.getJSON()));
			}, 200);
		},
		editorProps: {
			attributes: {
				class: "outline-none",
				"data-1p-ignore": "",
				autocomplete: "off",
				"aria-labelledby": labelId,
				role: "textbox",
			},
		},
	});

	/* Sync editor content when the value prop changes externally (e.g. undo). */
	useEffect(() => {
		if (!editor || focused) return;
		const currentSerialized = serializeContent(editor.getJSON());
		if (!sameTemplate(currentSerialized, value)) {
			const content = parseValueToContent(value, provider, currentFormUuid);
			editor.commands.setContent(content);
		}
	}, [editor, value, focused, provider, currentFormUuid]);

	/* Auto-focus and selectAll on mount. */
	useEffect(() => {
		if (!editor) return;
		if (autoFocus) {
			editor.commands.focus();
			if (selectAll) {
				editor.commands.selectAll();
			} else {
				editor.commands.focus("end");
			}
		}
	}, [editor, autoFocus, selectAll]);

	/**
	 * Commit the current editor content as the new label value. Sets the
	 * committedRef flag to prevent the subsequent blur event from double-saving.
	 * Triggers the emerald checkmark animation on successful save.
	 */
	const commit = useCallback(() => {
		if (committedRef.current || !editor) return;
		committedRef.current = true;
		setFocused(false);
		editor.commands.blur();

		const serialized = canonicalProseTemplate(
			serializeContent(editor.getJSON()).parts,
			{ trim: true },
		);
		if (proseTemplateIsEmpty(serialized) && onEmpty) {
			onEmpty();
			return;
		}
		if (!sameTemplate(serialized, savedValueRef.current)) {
			onSave(serialized);
			setSaved(true);
			savedTimerRef.current = setTimeout(() => setSaved(false), 1500);
		}
	}, [editor, onSave, onEmpty]);

	/**
	 * Cancel editing and revert the editor content to the last saved value.
	 * Called on Escape. If the original value was empty and onEmpty is provided,
	 * signals removal (matching EditableText's "delete on empty cancel" behavior).
	 */
	const cancel = useCallback(() => {
		if (committedRef.current || !editor) return;
		committedRef.current = true;
		setFocused(false);
		editor.commands.blur();

		const content = parseValueToContent(
			savedValueRef.current,
			provider,
			currentFormUuid,
		);
		editor.commands.setContent(content);

		/* Push the reverted value back to the parent so the canvas stays in sync. */
		onChangeRef.current?.(savedValueRef.current);

		if (proseTemplateIsEmpty(savedValueRef.current) && onEmpty) {
			onEmpty();
		}
	}, [editor, provider, onEmpty, currentFormUuid]);

	/* Stable refs so the event listener effect doesn't re-register on every
     parent render (commit/cancel get new identities when onSave/onEmpty change). */
	const commitRef = useRef(commit);
	commitRef.current = commit;
	const cancelRef = useRef(cancel);
	cancelRef.current = cancel;

	/* Register focus/blur handlers on the editor. Escape is handled here as a
     DOM keydown listener (rather than via TipTap addKeyboardShortcuts) so we
     can call stopPropagation — preventing the parent popover dismiss
     handler from closing the field inspector during an edit cancel. */
	useEffect(() => {
		if (!editor) return;

		const handleFocus = () => {
			committedRef.current = false;
			savedValueRef.current = valueRef.current;
			setFocused(true);
			if (selectAll) {
				setTimeout(() => editor.commands.selectAll(), 0);
			}
		};

		const handleBlur = () => {
			if (committedRef.current) {
				committedRef.current = false;
				return;
			}
			commitRef.current();
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				cancelRef.current();
			}
		};

		editor.on("focus", handleFocus);
		editor.on("blur", handleBlur);

		const dom = editor.view.dom;
		dom.addEventListener("keydown", handleKeyDown);

		return () => {
			editor.off("focus", handleFocus);
			editor.off("blur", handleBlur);
			dom.removeEventListener("keydown", handleKeyDown);
		};
	}, [editor, selectAll]);

	/* Derive styling classes matching EditableText. */
	const baseCls =
		"w-full text-sm rounded px-2 py-1 border outline-none transition-colors";
	const focusedCls = `${baseCls} bg-nova-surface text-nova-text border-nova-violet/60`;
	const isEmpty = proseTemplateIsEmpty(value) && !focused;
	const unfocusedCls = `${baseCls} bg-transparent border-transparent cursor-text ${isEmpty ? "text-nova-text-muted italic" : "font-medium"} hover:border-nova-border/40`;
	const wrapperCls = focused ? focusedCls : unfocusedCls;

	return (
		<div>
			<span
				id={labelId}
				className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5"
			>
				{fieldLabel}
				<SavedCheck
					visible={saved && !focused}
					size={12}
					className="shrink-0"
				/>
				{focused && multiline && <SaveShortcutHint />}
				{labelRight}
			</span>
			<div className={wrapperCls} data-field-id={dataFieldId}>
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
