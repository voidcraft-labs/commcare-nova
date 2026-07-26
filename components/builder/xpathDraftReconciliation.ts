/**
 * Three-way reconciliation for an open XPath editor.
 *
 * `base` is the projection the local draft started from, while `incoming` is
 * the newest projection of the identity-backed AST. A peer rename generally
 * appears as one contiguous replacement. When the local draft still carries
 * that exact old span at the same anchored position, apply the replacement and
 * retain local additions around it. If both sides changed the same span, keep
 * the local text byte-for-byte and require an explicit recovery instead of
 * overwriting either author's intent.
 */
export function reconcileXPathDraft({
	base,
	draft,
	incoming,
	conflict = false,
}: {
	readonly base: string;
	readonly draft: string;
	readonly incoming: string;
	/** A same-slot collision was already observed in this mounted edit. */
	readonly conflict?: boolean;
}): { base: string; draft: string; conflict: boolean } {
	// A later peer projection cannot prove that the local same-slot edit is
	// suddenly safe. Advance the shared base for diagnostics, but preserve both
	// the draft and the refusal until the editor's explicit cancel/reload path
	// unmounts this controller.
	if (conflict) return { base: incoming, draft, conflict: true };
	if (incoming === base) return { base, draft, conflict: false };
	if (draft === base || draft === incoming) {
		return { base: incoming, draft: incoming, conflict: false };
	}

	let prefixLength = 0;
	const prefixLimit = Math.min(base.length, incoming.length);
	while (
		prefixLength < prefixLimit &&
		base[prefixLength] === incoming[prefixLength]
	) {
		prefixLength++;
	}

	let suffixLength = 0;
	const suffixLimit = Math.min(
		base.length - prefixLength,
		incoming.length - prefixLength,
	);
	while (
		suffixLength < suffixLimit &&
		base[base.length - suffixLength - 1] ===
			incoming[incoming.length - suffixLength - 1]
	) {
		suffixLength++;
	}

	const oldEnd = base.length - suffixLength;
	const oldSpan = base.slice(prefixLength, oldEnd);
	const newSpan = incoming.slice(prefixLength, incoming.length - suffixLength);
	const unchangedPrefix = base.slice(0, prefixLength);

	const draftKeepsAnchor =
		draft.slice(0, prefixLength) === unchangedPrefix &&
		draft.slice(prefixLength, prefixLength + oldSpan.length) === oldSpan;
	if (draftKeepsAnchor) {
		return {
			base: incoming,
			draft:
				draft.slice(0, prefixLength) +
				newSpan +
				draft.slice(prefixLength + oldSpan.length),
			conflict: false,
		};
	}

	return { base: incoming, draft, conflict: true };
}
