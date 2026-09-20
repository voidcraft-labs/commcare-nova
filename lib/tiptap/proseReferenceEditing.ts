import type { Editor, Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, PluginKey, type Transaction } from "@tiptap/pm/state";
import { exitSuggestion } from "@tiptap/suggestion";
import { buildHashtagRefRegex, prosePartSchema } from "@/lib/domain";
import type { ReferenceProvider } from "@/lib/references/provider";
import type { Reference } from "@/lib/references/types";

export const proseSuggestionKey = new PluginKey("proseReferences");

export function dismissProseSuggestion(editor: Editor): boolean {
	if (!proseSuggestionKey.getState(editor.state)?.active) return false;
	exitSuggestion(editor.view, proseSuggestionKey);
	return true;
}

/** A picker is part of the editing session, even while its input has focus. */
const openPickers = new WeakSet<Editor>();
export function setProsePickerOpen(editor: Editor, open: boolean) {
	if (open) openPickers.add(editor);
	else openPickers.delete(editor);
}
export function prosePickerIsOpen(editor: Editor) {
	return openPickers.has(editor);
}

export function proseReferenceSelection(editor: Editor) {
	const { selection, doc } = editor.state;
	const { from, to } = selection;
	const part =
		selection instanceof NodeSelection &&
		selection.node.type.name === "commcareRef"
			? prosePartSchema.safeParse(selection.node.attrs.part)
			: undefined;
	const text = doc.textBetween(from, to, "\n", "\ufffc");
	return {
		range: { from, to },
		doc,
		part: part?.success && part.data.kind !== "text" ? part.data : undefined,
		text,
		isToken: new RegExp(`^(?:${buildHashtagRefRegex().source})$`).test(text),
	};
}

/** Resolve the chosen identity again. A rename while the picker is open must
 * never bind the old spelling to a different field. */
export function insertProseReference(
	editor: Editor,
	range: Range,
	reference: Reference,
	provider: ReferenceProvider,
	formUuid: string | undefined,
): boolean {
	const live = provider.resolvePart(reference.part, formUuid);
	if (!live || editor.isDestroyed) return false;
	const { doc, storedMarks } = editor.state;
	const start = doc.resolve(range.from);
	const marks =
		range.from === range.to
			? (storedMarks ?? start.marks())
			: (start.marksAcross(doc.resolve(range.to)) ?? []);
	return editProseReference(editor, (tr) => {
		const node = editor.schema.nodes.commcareRef.create(
			{ part: live.part },
			null,
			marks,
		);
		tr.replaceWith(range.from, range.to, node);
	});
}

export function searchProseReferences(
	provider: ReferenceProvider,
	formUuid: string | undefined,
	query: string,
) {
	const needle = query.trim().toLowerCase();
	return provider
		.namespaces(formUuid)
		.flatMap((namespace) => provider.search(namespace, "", formUuid))
		.filter(
			(reference) =>
				reference.raw.toLowerCase().includes(needle) ||
				reference.label.toLowerCase().includes(needle),
		);
}

const editorIds = new WeakMap<Editor, string>();
let nextEditorId = 0;
export function proseEditorId(editor: Editor) {
	let id = editorIds.get(editor);
	if (!id) {
		id = `prose-editor-${++nextEditorId}`;
		editorIds.set(editor, id);
	}
	return id;
}
export function proseEditorOwnsFocus(
	editor: Editor,
	target: EventTarget | null,
) {
	return (
		target instanceof Element &&
		Boolean(target.closest(`[data-prose-editor="${proseEditorId(editor)}"]`))
	);
}

/** Explicit insertion/conversion is one undo step, separate from typing on
 * either side even when the author moves quickly. */
export function editProseReference(
	editor: Editor,
	edit: (tr: Transaction) => void,
) {
	const changed = editor
		.chain()
		.focus()
		.command(({ tr }) => {
			closeHistory(tr);
			edit(tr);
			return true;
		})
		.run();
	editor.view.dispatch(closeHistory(editor.state.tr));
	return changed;
}
