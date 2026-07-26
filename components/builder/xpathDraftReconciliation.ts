/**
 * Three-way reconciliation for an open XPath editor.
 *
 * `base` is the projection the local draft started from, while `incoming` is
 * the newest projection of the identity-backed AST. A peer rename generally
 * appears as one contiguous token replacement. When that original token span
 * has exactly one optimal correspondence in the locally edited draft, apply
 * the replacement there and retain local additions around it. If both sides
 * changed the same span, or the correspondence is ambiguous, keep the local
 * text byte-for-byte and require an explicit recovery instead of overwriting
 * either author's intent.
 */
interface XPathToken {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

interface PeerChange {
	readonly oldTokens: readonly string[];
	readonly replacement: string;
	readonly baseStart: number;
	readonly baseEnd: number;
}

const NAME_CHARACTER = /[A-Za-z0-9_.:-]/;

function tokenizeXPath(value: string): XPathToken[] {
	const tokens: XPathToken[] = [];
	let start = 0;
	while (start < value.length) {
		const first = value[start];
		let end = start + 1;

		if (first === "'" || first === '"') {
			while (end < value.length) {
				if (value[end++] === first) break;
			}
		} else if (/\s/.test(first)) {
			while (end < value.length && /\s/.test(value[end])) end++;
		} else if (NAME_CHARACTER.test(first)) {
			while (end < value.length && NAME_CHARACTER.test(value[end])) end++;
		} else if (
			end < value.length &&
			["!=", "<=", ">=", "//", "::"].includes(value.slice(start, end + 1))
		) {
			end++;
		}

		tokens.push({ text: value.slice(start, end), start, end });
		start = end;
	}
	return tokens;
}

function changedTokenSpan(base: string, incoming: string): PeerChange | null {
	const baseTokens = tokenizeXPath(base);
	const incomingTokens = tokenizeXPath(incoming);

	let prefix = 0;
	while (
		prefix < baseTokens.length &&
		prefix < incomingTokens.length &&
		baseTokens[prefix].text === incomingTokens[prefix].text
	) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < baseTokens.length - prefix &&
		suffix < incomingTokens.length - prefix &&
		baseTokens[baseTokens.length - suffix - 1].text ===
			incomingTokens[incomingTokens.length - suffix - 1].text
	) {
		suffix++;
	}

	const baseEnd = baseTokens.length - suffix;
	const incomingEnd = incomingTokens.length - suffix;
	const oldTokens = baseTokens.slice(prefix, baseEnd).map(({ text }) => text);
	const newTokens = incomingTokens
		.slice(prefix, incomingEnd)
		.map(({ text }) => text);

	// A matching token inside the changed middle is evidence that the peer
	// projection contains more than one edit hunk. There is no unique span to
	// project in that case, so fail closed rather than guessing.
	const newTokenSet = new Set(newTokens);
	if (oldTokens.some((token) => newTokenSet.has(token))) return null;

	const replacementStart = incomingTokens[prefix]?.start ?? incoming.length;
	const replacementEnd =
		incomingEnd > prefix
			? incomingTokens[incomingEnd - 1].end
			: replacementStart;

	return {
		oldTokens,
		replacement: incoming.slice(replacementStart, replacementEnd),
		baseStart: prefix,
		baseEnd,
	};
}

/** Levenshtein distances from `source` to every prefix of `target`. */
function prefixEditDistances(
	source: readonly string[],
	target: readonly string[],
): number[] {
	let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
	for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
		const current = [sourceIndex + 1];
		for (let targetIndex = 0; targetIndex < target.length; targetIndex++) {
			current.push(
				Math.min(
					previous[targetIndex + 1] + 1,
					current[targetIndex] + 1,
					previous[targetIndex] +
						(source[sourceIndex] === target[targetIndex] ? 0 : 1),
				),
			);
		}
		previous = current;
	}
	return previous;
}

function tokenSequenceStartsAt(
	draftTokens: readonly XPathToken[],
	start: number,
	expected: readonly string[],
): boolean {
	return expected.every(
		(token, offset) => draftTokens[start + offset]?.text === token,
	);
}

function uniquelyMappedDraftSpan({
	baseTokens,
	draftTokens,
	baseStart,
	baseEnd,
	oldTokens,
}: {
	readonly baseTokens: readonly string[];
	readonly draftTokens: readonly XPathToken[];
	readonly baseStart: number;
	readonly baseEnd: number;
	readonly oldTokens: readonly string[];
}): { start: number; end: number } | null {
	const draftTokenTexts = draftTokens.map(({ text }) => text);
	const prefixCosts = prefixEditDistances(
		baseTokens.slice(0, baseStart),
		draftTokenTexts,
	);
	const suffixCosts = prefixEditDistances(
		baseTokens.slice(baseEnd).toReversed(),
		draftTokenTexts.toReversed(),
	);
	const totalCost = prefixEditDistances(baseTokens, draftTokenTexts).at(-1);
	if (totalCost === undefined) return null;

	const candidates: Array<{ start: number; end: number }> = [];
	const lastStart = draftTokens.length - oldTokens.length;
	for (let start = 0; start <= lastStart; start++) {
		if (!tokenSequenceStartsAt(draftTokens, start, oldTokens)) continue;
		const end = start + oldTokens.length;
		if (
			prefixCosts[start] + suffixCosts[draftTokens.length - end] !==
			totalCost
		) {
			continue;
		}
		candidates.push({ start, end });
		if (candidates.length > 1) return null;
	}
	return candidates[0] ?? null;
}

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

	const peerChange = changedTokenSpan(base, incoming);
	if (!peerChange) return { base: incoming, draft, conflict: true };

	const baseTokens = tokenizeXPath(base).map(({ text }) => text);
	const draftTokens = tokenizeXPath(draft);
	const mapped = uniquelyMappedDraftSpan({
		baseTokens,
		draftTokens,
		baseStart: peerChange.baseStart,
		baseEnd: peerChange.baseEnd,
		oldTokens: peerChange.oldTokens,
	});
	if (!mapped) return { base: incoming, draft, conflict: true };

	const draftStart = draftTokens[mapped.start]?.start ?? draft.length;
	const draftEnd =
		mapped.end > mapped.start ? draftTokens[mapped.end - 1].end : draftStart;
	return {
		base: incoming,
		draft:
			draft.slice(0, draftStart) +
			peerChange.replacement +
			draft.slice(draftEnd),
		conflict: false,
	};
}
