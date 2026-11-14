/** React NodeView for a structural prose atom: a reference or a calculated
 * value. */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import type { MouseEvent } from "react";
import { prosePartSchema } from "@/lib/domain";
import { unresolvedReferenceProjection } from "@/lib/references/provider";
import {
	ReferenceChip,
	UnresolvedReferenceChip,
} from "@/lib/references/ReferenceChip";
import {
	useCurrentFormUuid,
	useReferenceProvider,
	useReferenceTemplateProjection,
} from "@/lib/references/ReferenceContext";
import { ProseValueAtom } from "@/lib/references/ValueChip";

export function CommcareRefView({
	node,
	selected,
	editor,
	getPos,
}: NodeViewProps) {
	const provider = useReferenceProvider();
	const formUuid = useCurrentFormUuid();
	const parsed = prosePartSchema.safeParse(node.attrs.part);
	useReferenceTemplateProjection(
		parsed.success ? { parts: [parsed.data] } : undefined,
		formUuid,
	);
	if (!parsed.success || parsed.data.kind === "text") {
		return (
			<NodeViewWrapper as="span" className="inline text-nova-text-muted">
				Invalid reference
			</NodeViewWrapper>
		);
	}
	const atom = parsed.data;
	const projected =
		atom.kind === "value"
			? undefined
			: (provider?.projectPart(atom, formUuid) ??
				({
					ok: false,
					unresolved: unresolvedReferenceProjection(atom),
				} as const));
	return (
		<NodeViewWrapper
			as="span"
			className={selected ? "inline rounded ring-2 ring-nova-violet" : "inline"}
			contentEditable={false}
			onMouseDown={(event: MouseEvent) => {
				if (event.button !== 0) return;
				const position = getPos();
				if (position === undefined) return;
				event.preventDefault();
				editor.chain().focus().setNodeSelection(position).run();
			}}
		>
			{atom.kind === "value" ? (
				<ProseValueAtom part={atom} />
			) : projected?.ok ? (
				<ReferenceChip reference={projected.reference} />
			) : projected !== undefined ? (
				<UnresolvedReferenceChip unresolved={projected.unresolved} />
			) : null}
		</NodeViewWrapper>
	);
}
