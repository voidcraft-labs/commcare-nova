/** React NodeView for a structural prose-reference atom. */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { prosePartSchema } from "@/lib/domain";
import { unresolvedReferenceProjection } from "@/lib/references/provider";
import {
	ReferenceChip,
	UnresolvedReferenceChip,
} from "@/lib/references/ReferenceChip";
import {
	useCurrentFormUuid,
	useReferenceProvider,
} from "@/lib/references/ReferenceContext";

export function CommcareRefView({ node }: NodeViewProps) {
	const provider = useReferenceProvider();
	const formUuid = useCurrentFormUuid();
	const parsed = prosePartSchema.safeParse(node.attrs.part);
	if (!parsed.success || parsed.data.kind === "text") {
		return (
			<NodeViewWrapper as="span" className="inline text-nova-text-muted">
				Invalid reference
			</NodeViewWrapper>
		);
	}
	const projected =
		provider?.projectPart(parsed.data, formUuid) ??
		({
			ok: false,
			unresolved: unresolvedReferenceProjection(parsed.data),
		} as const);
	return (
		<NodeViewWrapper as="span" className="inline">
			{projected.ok ? (
				<ReferenceChip reference={projected.reference} />
			) : (
				<UnresolvedReferenceChip unresolved={projected.unresolved} />
			)}
		</NodeViewWrapper>
	);
}
