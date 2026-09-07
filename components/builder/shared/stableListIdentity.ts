export type StableListOperation =
	| { readonly kind: "replace" }
	| {
			readonly kind: "splice";
			readonly index: number;
			readonly deleteCount: number;
			readonly insertCount: number;
	  }
	| {
			readonly kind: "move";
			readonly fromIndex: number;
			readonly toIndex: number;
	  }
	| { readonly kind: "reset" };

interface IdentitySnapshot<T> {
	readonly items: readonly T[];
	readonly fingerprints: readonly string[];
	readonly keys: readonly string[];
	readonly nextOrdinal: number;
}

interface PendingSnapshot<T> extends IdentitySnapshot<T> {
	readonly expectedItems: readonly T[];
}

export interface StableListIdentity<T> {
	/** One occurrence-safe key for each item at the matching array index. */
	readonly keys: readonly string[];
	/**
	 * Stage the exact logical list operation before calling the parent's
	 * onChange. The staged key vector is adopted when the next value arrives,
	 * even when every item was structured-cloned in between.
	 */
	readonly stage: (
		nextItems: readonly T[],
		operation: StableListOperation,
	) => void;
}

/** Canonical structural fingerprint for Blueprint value objects. Object keys
 * are sorted, so equivalent objects reconstructed with a different insertion
 * order still compare equal. Arrays remain ordered and duplicate occurrences
 * remain distinct at the list-reconciliation layer. */
export function stableValueFingerprint(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "undefined":
			return "undefined";
		case "string":
			return `string:${JSON.stringify(value)}`;
		case "boolean":
			return `boolean:${value ? "1" : "0"}`;
		case "number":
			return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
		case "bigint":
			return `bigint:${String(value)}`;
		case "symbol":
			return `symbol:${String(value.description)}`;
		case "function":
			return `function:${String(value)}`;
	}
	if (value instanceof Date) return `date:${value.toISOString()}`;
	if (Array.isArray(value)) {
		return `array:[${value.map(stableValueFingerprint).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `object:{${keys
		.map(
			(key) => `${JSON.stringify(key)}:${stableValueFingerprint(record[key])}`,
		)
		.join(",")}}`;
}

function fingerprintsFor<T>(items: readonly T[]): readonly string[] {
	return items.map(stableValueFingerprint);
}

function sameFingerprintSequence<T>(
	items: readonly T[],
	fingerprints: readonly string[],
): boolean {
	if (items.length !== fingerprints.length) return false;
	return items.every(
		(item, index) => stableValueFingerprint(item) === fingerprints[index],
	);
}

function mintKeys(
	prefix: string,
	startOrdinal: number,
	count: number,
): { readonly keys: readonly string[]; readonly nextOrdinal: number } {
	return {
		keys: Array.from(
			{ length: count },
			(_, offset) => `${prefix}:row:${startOrdinal + offset}`,
		),
		nextOrdinal: startOrdinal + count,
	};
}

/** Pure fallback for snapshots not preceded by a local staged operation.
 * Match exact references first, then structurally equal occurrences through
 * one-to-one queues. Only a single unmatched old/new pair is unambiguously a
 * same-slot replacement; ambiguous peers receive fresh UI keys. */
export function reconcileStableListKeys<T>(args: {
	readonly previousItems: readonly T[];
	readonly previousKeys: readonly string[];
	readonly nextItems: readonly T[];
	readonly prefix: string;
	readonly nextOrdinal: number;
}): { readonly keys: readonly string[]; readonly nextOrdinal: number } {
	const {
		previousItems,
		previousKeys,
		nextItems,
		prefix,
		nextOrdinal: initialOrdinal,
	} = args;
	const nextKeys: Array<string | undefined> = Array(nextItems.length);
	const usedPrevious = new Set<number>();

	// Preserve exact objects first. This is the common local reorder path before
	// a document boundary and removes ambiguity between equal-valued siblings.
	for (let nextIndex = 0; nextIndex < nextItems.length; nextIndex += 1) {
		const item = nextItems[nextIndex];
		const previousIndex = previousItems.findIndex(
			(candidate, index) => !usedPrevious.has(index) && candidate === item,
		);
		if (previousIndex < 0) continue;
		nextKeys[nextIndex] = previousKeys[previousIndex];
		usedPrevious.add(previousIndex);
	}

	// A queue per canonical shape consumes duplicate occurrences exactly once.
	const previousByFingerprint = new Map<string, number[]>();
	for (let index = 0; index < previousItems.length; index += 1) {
		if (usedPrevious.has(index)) continue;
		const fingerprint = stableValueFingerprint(previousItems[index]);
		const queue = previousByFingerprint.get(fingerprint) ?? [];
		queue.push(index);
		previousByFingerprint.set(fingerprint, queue);
	}
	for (let nextIndex = 0; nextIndex < nextItems.length; nextIndex += 1) {
		if (nextKeys[nextIndex] !== undefined) continue;
		const queue = previousByFingerprint.get(
			stableValueFingerprint(nextItems[nextIndex]),
		);
		const previousIndex = queue?.shift();
		if (previousIndex === undefined) continue;
		nextKeys[nextIndex] = previousKeys[previousIndex];
		usedPrevious.add(previousIndex);
	}

	const unmatchedPrevious = previousItems
		.map((_, index) => index)
		.filter((index) => !usedPrevious.has(index));
	const unmatchedNext = nextItems
		.map((_, index) => index)
		.filter((index) => nextKeys[index] === undefined);
	if (
		unmatchedPrevious.length === 1 &&
		unmatchedNext.length === 1 &&
		unmatchedPrevious[0] === unmatchedNext[0]
	) {
		nextKeys[unmatchedNext[0]] = previousKeys[unmatchedPrevious[0]];
	}

	let nextOrdinal = initialOrdinal;
	for (const index of unmatchedNext) {
		if (nextKeys[index] !== undefined) continue;
		nextKeys[index] = `${prefix}:row:${nextOrdinal}`;
		nextOrdinal += 1;
	}
	return { keys: nextKeys as string[], nextOrdinal };
}

function stageKeys<T>(args: {
	readonly current: IdentitySnapshot<T>;
	readonly nextItems: readonly T[];
	readonly operation: StableListOperation;
	readonly prefix: string;
}): PendingSnapshot<T> {
	const { current, nextItems, operation, prefix } = args;
	let keys = [...current.keys];
	let nextOrdinal = current.nextOrdinal;
	if (operation.kind === "replace") {
		if (nextItems.length !== keys.length) {
			throw new Error("A stable-list replace must keep the same row count");
		}
	} else if (operation.kind === "splice") {
		const minted = mintKeys(prefix, nextOrdinal, operation.insertCount);
		nextOrdinal = minted.nextOrdinal;
		keys.splice(operation.index, operation.deleteCount, ...minted.keys);
	} else if (operation.kind === "move") {
		const [moved] = keys.splice(operation.fromIndex, 1);
		if (moved === undefined) {
			throw new Error("A stable-list move must start at an existing row");
		}
		keys.splice(operation.toIndex, 0, moved);
	} else {
		const minted = mintKeys(prefix, nextOrdinal, nextItems.length);
		keys = [...minted.keys];
		nextOrdinal = minted.nextOrdinal;
	}
	if (keys.length !== nextItems.length) {
		throw new Error("Stable-list operation does not match its next row count");
	}
	const fingerprints = fingerprintsFor(nextItems);
	return {
		items: nextItems,
		expectedItems: nextItems,
		fingerprints,
		keys,
		nextOrdinal,
	};
}

/** The sidecar ledger is published only by a committed React render. Computing a
 * frame is speculative; abandoning one must leave the visible row identities
 * untouched. Staging records local intent until the next committed snapshot. */
export function createStableListIdentity<T>(prefix: string) {
	let committed: IdentitySnapshot<T> | null = null;
	let pendingSnapshot: PendingSnapshot<T> | null = null;
	return {
		render(items: readonly T[]) {
			const previous = committed;
			const pending = pendingSnapshot;

			let candidate: IdentitySnapshot<T>;
			let pendingDisposition: "none" | "adopt" | "discard" = "none";
			if (previous === null) {
				const minted = mintKeys(prefix, 0, items.length);
				candidate = {
					items,
					fingerprints: fingerprintsFor(items),
					keys: minted.keys,
					nextOrdinal: minted.nextOrdinal,
				};
			} else if (pending !== null && items === previous.items) {
				// Guarded document writes are synchronous. A committed render with the
				// exact previous list means the staged edit was rejected; discard it so a
				// later clone of old state cannot resurrect stale duplicate-row intent.
				candidate = previous;
				pendingDisposition = "discard";
			} else if (
				pending !== null &&
				(items === pending.expectedItems || items !== previous.items) &&
				sameFingerprintSequence(items, pending.fingerprints)
			) {
				candidate = { ...pending, items };
				pendingDisposition = "adopt";
			} else {
				const reconciled = reconcileStableListKeys({
					previousItems: previous.items,
					previousKeys: previous.keys,
					nextItems: items,
					prefix,
					nextOrdinal: previous.nextOrdinal,
				});
				candidate = {
					items,
					fingerprints: fingerprintsFor(items),
					keys: reconciled.keys,
					nextOrdinal: reconciled.nextOrdinal,
				};
				pendingDisposition = pending === null ? "none" : "discard";
			}

			return {
				keys: candidate.keys,
				stage(nextItems: readonly T[], operation: StableListOperation) {
					pendingSnapshot = stageKeys({
						current: candidate,
						nextItems,
						operation,
						prefix,
					});
				},
				commit() {
					committed = candidate;
					if (pendingSnapshot === pending && pendingDisposition !== "none")
						pendingSnapshot = null;
				},
			};
		},
	};
}
