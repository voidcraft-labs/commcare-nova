/** React NodeView for a structural prose-reference atom. */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { fallbackProseProjection, prosePartSchema } from "@/lib/domain";
import { ReferenceChip } from "@/lib/references/ReferenceChip";
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
	const fallback = fallbackProseProjection({ parts: [parsed.data] });
	const resolved = provider?.resolvePart(parsed.data, formUuid);
	return (
		<NodeViewWrapper as="span" className="inline">
			{resolved ? (
				<ReferenceChip reference={resolved} />
			) : (
				<span className="text-nova-text-muted">{fallback}</span>
			)}
		</NodeViewWrapper>
	);
}
