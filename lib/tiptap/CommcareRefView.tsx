/**
 * React NodeView for the commcareRef TipTap node.
 *
 * Renders the shared ReferenceChip component inside a NodeViewWrapper,
 * keeping chip appearance consistent between CodeMirror and TipTap surfaces.
 * Uses the ReferenceProvider from context to resolve the full reference
 * (including the field kind icon for #form/ refs).
 */

import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import type { FieldPath } from "@/lib/doc/fieldPath";
import { classifyNamespace } from "@/lib/references/config";
import { ReferenceChip } from "@/lib/references/ReferenceChip";
import {
	useCurrentFormUuid,
	useReferenceProvider,
} from "@/lib/references/ReferenceContext";
import type { Reference } from "@/lib/references/types";

/** Build the un-resolved fallback chip from the node attrs. `refType` is the
 *  namespace: `form`/`user`, else a case-type name. `classifyNamespace` maps it
 *  back to the coarse reference family for styling. Only used during the initial
 *  mount before a provider exists. */
function fallbackReference(
	refType: string,
	path: string,
	label: string,
	raw: string,
): Reference {
	switch (classifyNamespace(refType)) {
		case "form":
			return { type: "form", path: path as FieldPath, label, raw };
		case "user":
			return { type: "user", path, label, raw };
		default:
			return { type: "case", caseType: refType, path, label, raw };
	}
}

export function CommcareRefView({ node }: NodeViewProps) {
	const provider = useReferenceProvider();
	const formUuid = useCurrentFormUuid();
	/* `refType` holds the namespace string — `form`/`user`, or a case-type name
	 * for case refs. */
	const raw = `#${node.attrs.refType}/${node.attrs.path}`;

	/* Only render a chip when the provider can actually resolve the ref.
	 * Unresolvable refs (typos, partial edits, stale paths, unreachable case
	 * types) render as plain text so users don't get a false sense of validity.
	 * Without a provider (e.g. during initial load), fall back to a bare chip so
	 * content isn't invisible while the context mounts. */
	const resolved = provider?.resolve(raw, formUuid);

	if (provider && !resolved) {
		return (
			<NodeViewWrapper as="span" className="inline">
				<span className="text-nova-text-muted">{raw}</span>
			</NodeViewWrapper>
		);
	}

	const ref: Reference =
		resolved ??
		fallbackReference(
			node.attrs.refType,
			node.attrs.path,
			node.attrs.label || node.attrs.path,
			raw,
		);

	return (
		<NodeViewWrapper as="span" className="inline">
			<ReferenceChip reference={ref} />
		</NodeViewWrapper>
	);
}
