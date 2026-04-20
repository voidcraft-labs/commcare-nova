/**
 * TipTap-based label input with inline reference chip support.
 *
 * Replaces EditableText for the label field, adding the ability to insert
 * #form/, #case/, #user/ references that render as styled inline chips.
 * Preserves the same focus/blur/commit/cancel UX as EditableText:
 *   - Blur → save
 *   - Enter → save (single-line mode)
 *   - Cmd/Ctrl+Enter → save (multiline mode)
 *   - Escape → cancel (revert to original value)
 *   - Emerald checkmark animation on save
 *
 * The underlying document model stores commcareRef nodes. Serialization
 * to/from the canonical string format (#type/path) happens on save/load.
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
import { ReferenceProvider } from "@/lib/references/provider";
import { useReferenceProvider } from "@/lib/references/ReferenceContext";
import { parseLabelSegments } from "@/lib/references/renderLabel";
import { CommcareRef } from "@/lib/tiptap/commcareRefNode";
import { createRefSuggestion } from "@/lib/tiptap/refSuggestion";

interface RefLabelInputProps {
	label: string;
	value: string;
	onSave: (value: string) => void;
	/** Called on every content change (not just commit). Lets the canvas show chips in real-time. */
	onChange?: (value: string) => void;
	onEmpty?: () => void;
	multiline?: boolean;
	autoFocus?: boolean;
	selectAll?: boolean;
	/** Content rendered right-aligned in the label row (e.g. a toggle). */
	labelRight?: React.ReactNode;
}

// ── Serialization ───────────────────────────────────────────────────────

/**
 * Parse a label string into TipTap JSON content.
 * Bare `#type/path` hashtags become commcareRef nodes; everything else
 * becomes text nodes. Delegates to parseLabelSegments for the regex
 * splitting (single source of truth for the hashtag pattern).
 */
function parseValueToContent(
	value: string,
	provider: ReferenceProvider | null,
): JSONContent {
	if (!value) {
		return { type: "doc", content: [{ type: "paragraph" }] };
	}

	const segments = parseLabelSegments(value);
	const inlineContent: JSONContent[] = [];

	for (const seg of segments) {
		if (seg.kind === "text") {
			inlineContent.push({ type: "text", text: seg.text });
			continue;
		}
		const parsed = ReferenceProvider.parse(seg.value);
		if (!parsed) {
			inlineContent.push({ type: "text", text: seg.value });
			continue;
		}
		const resolved = provider?.resolve(seg.value);
		inlineContent.push({
			type: "commcareRef",
			attrs: {
				refType: parsed.type,
				path: parsed.path,
				label: resolved?.label ?? parsed.path,
			},
		});
	}

	return {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: inlineContent.length > 0 ? inlineContent : undefined,
			},
		],
	};
}

/**
 * Serialize TipTap document content to a label string.
 * commcareRef nodes become bare `#type/path` hashtags (canonical internal
 * format), text nodes become their text content.
 */
function serializeContent(doc: JSONContent): string {
	let result = "";
	const paragraphs = doc.content ?? [];
	for (let pi = 0; pi < paragraphs.length; pi++) {
		const paragraph = paragraphs[pi];
		for (const node of paragraph.content ?? []) {
			if (node.type === "text") {
				result += node.text ?? "";
			} else if (node.type === "commcareRef") {
				result += `#${node.attrs?.refType}/${node.attrs?.path}`;
			}
		}
		if (pi < paragraphs.length - 1) {
			result += "\n";
		}
	}
	return result;
}

// ── Component ───────────────────────────────────────────────────────────

export function RefLabelInput({
	label: fieldLabel,
	value,
	onSave,
	onChange,
	onEmpty,
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

	const suggestion = useMemo(() => {
		if (!provider) return undefined;
		return createRefSuggestion(provider);
	}, [provider]);

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
		() => parseValueToContent(value, provider),
		[value, provider],
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
		if (currentSerialized !== value) {
			const content = parseValueToContent(value, provider);
			editor.commands.setContent(content);
		}
	}, [editor, value, focused, provider]);

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

		const serialized = serializeContent(editor.getJSON()).trim();
		if (!serialized && onEmpty) {
			onEmpty();
			return;
		}
		if (serialized !== savedValueRef.current) {
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

		const content = parseValueToContent(savedValueRef.current, provider);
		editor.commands.setContent(content);

		/* Push the reverted value back to the parent so the canvas stays in sync. */
		onChangeRef.current?.(savedValueRef.current);

		if (!savedValueRef.current.trim() && onEmpty) {
			onEmpty();
		}
	}, [editor, provider, onEmpty]);

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
	const isEmpty = !value && !focused;
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
			<div className={wrapperCls}>
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
