import type { FieldTreeNode } from "./fieldTree";

/**
 * Flat data store keyed by absolute path.
 * Paths: /data/field_id, /data/group_id/child_id, /data/repeat_id[0]/child_id
 *
 * Repeat cardinality is tracked EXPLICITLY in `counts`, keyed by the
 * concrete repeat container path (`/data/orders`, `/data/a[0]/b`) — never
 * derived from which value keys happen to exist. Deriving from keys broke
 * two ways: a repeat with no leaf descendants (only structural children)
 * counted 0 and went dead, and a repeat's count silently followed whatever
 * keys other operations left behind. `set` auto-extends counts from a
 * path's indexed segments so restore/rename flows that write indexed paths
 * directly keep the map consistent.
 */
export class DataInstance {
	private data = new Map<string, string>();
	private counts = new Map<string, number>();

	/** Initialize from a field tree, creating an entry for each non-structural field. */
	initFromFields(tree: FieldTreeNode[], prefix = "/data"): void {
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;

			if (f.kind === "group") {
				// Groups don't have values — recurse into children
				if (node.children) this.initFromFields(node.children, path);
			} else if (f.kind === "repeat") {
				// Repeats start with one instance [0]
				this.counts.set(path, 1);
				if (node.children) this.initFromFields(node.children, `${path}[0]`);
			} else {
				// Leaf field — empty string initial value
				this.data.set(path, "");
			}
		}
	}

	get(path: string): string | undefined {
		return this.data.get(path);
	}

	set(path: string, value: string): void {
		this.data.set(path, value);
		this.extendCountsFor(path);
	}

	has(path: string): boolean {
		return this.data.has(path);
	}

	/** Drop a path's value — and, if the path is a repeat container, its
	 *  instance count. Used when a field is retyped (its old value is stale
	 *  under the new kind) or removed remotely, so a later re-seed at the
	 *  same path starts empty rather than resurfacing the old answer. */
	delete(path: string): void {
		this.data.delete(path);
		this.counts.delete(path);
	}

	/** Register a repeat container, seeding one instance if it has no live
	 *  count yet. The incremental add-field path uses this — the full
	 *  `initFromFields` walk seeds counts itself. */
	ensureRepeat(repeatPath: string): void {
		if (!this.counts.has(repeatPath)) this.counts.set(repeatPath, 1);
	}

	/**
	 * Add a new repeat instance. Returns the new index.
	 *
	 * The new instance is seeded from the AUTHORED template shape — the
	 * `[0]` subtree with every nested repeat at one instance — not from
	 * instance `[0]`'s live shape. A user who grew a nested repeat to three
	 * rows inside instance 1 gets a fresh instance with one nested row,
	 * matching what the deployed form's `jr:template` would produce.
	 */
	addRepeatInstance(repeatPath: string): number {
		const count = this.getRepeatCount(repeatPath);
		const newIndex = count;

		const templatePrefix = `${repeatPath}[0]/`;
		for (const [key] of this.data) {
			if (!key.startsWith(templatePrefix)) continue;
			const suffix = key.slice(templatePrefix.length);
			// Skip keys inside nested instances >= 1 — template shape only.
			if (/\[[1-9]\d*\]/.test(suffix)) continue;
			this.data.set(`${repeatPath}[${newIndex}]/${suffix}`, "");
		}
		// Nested repeat containers restart at one instance in the new copy.
		for (const key of [...this.counts.keys()]) {
			if (!key.startsWith(templatePrefix)) continue;
			const suffix = key.slice(templatePrefix.length);
			if (/\[[1-9]\d*\]/.test(suffix)) continue;
			this.counts.set(`${repeatPath}[${newIndex}]/${suffix}`, 1);
		}

		this.counts.set(repeatPath, newIndex + 1);
		return newIndex;
	}

	/** Remove a repeat instance and renumber higher indices. */
	removeRepeatInstance(repeatPath: string, index: number): void {
		const count = this.getRepeatCount(repeatPath);
		if (count <= 1) return; // Keep at least one instance

		// Remove value + nested-count keys for this index
		const prefix = `${repeatPath}[${index}]/`;
		for (const key of [...this.data.keys()]) {
			if (key.startsWith(prefix)) this.data.delete(key);
		}
		for (const key of [...this.counts.keys()]) {
			if (key.startsWith(prefix)) this.counts.delete(key);
		}

		// Renumber higher indices
		for (let i = index + 1; i < count; i++) {
			const oldPrefix = `${repeatPath}[${i}]/`;
			const newPrefix = `${repeatPath}[${i - 1}]/`;
			for (const key of [...this.data.keys()]) {
				if (key.startsWith(oldPrefix)) {
					const suffix = key.slice(oldPrefix.length);
					const value = this.data.get(key) ?? "";
					this.data.delete(key);
					this.data.set(newPrefix + suffix, value);
				}
			}
			for (const key of [...this.counts.keys()]) {
				if (key.startsWith(oldPrefix)) {
					const suffix = key.slice(oldPrefix.length);
					const nested = this.counts.get(key) ?? 1;
					this.counts.delete(key);
					this.counts.set(newPrefix + suffix, nested);
				}
			}
		}

		this.counts.set(repeatPath, count - 1);
	}

	/** Live instance count for a repeat container path. Zero for paths
	 *  that aren't registered repeats. */
	getRepeatCount(repeatPath: string): number {
		return this.counts.get(repeatPath) ?? 0;
	}

	/** Move a key — its value and/or its repeat count — to a new path.
	 *  The old key is deleted so index-free reads can't resurrect the
	 *  pre-rename value. */
	rename(from: string, to: string): void {
		if (this.data.has(from)) {
			const value = this.data.get(from) ?? "";
			this.data.delete(from);
			this.set(to, value);
		}
		const count = this.counts.get(from);
		if (count !== undefined) {
			this.counts.delete(from);
			this.counts.set(to, count);
		}
	}

	/** Get all entries (for debugging). */
	entries(): [string, string][] {
		return [...this.data.entries()];
	}

	/** Grow every repeat count along a path's indexed segments so the map
	 *  admits the instance the path names — `/data/a[2]/b[1]/c` implies at
	 *  least 3 instances of `/data/a` and 2 of `/data/a[2]/b`. */
	private extendCountsFor(path: string): void {
		let rest = path;
		let prefix = "";
		for (;;) {
			const open = rest.indexOf("[");
			if (open === -1) return;
			const close = rest.indexOf("]", open);
			if (close === -1) return;
			const repeatPath = prefix + rest.slice(0, open);
			const index = Number.parseInt(rest.slice(open + 1, close), 10);
			if (Number.isInteger(index)) {
				const current = this.counts.get(repeatPath) ?? 0;
				if (index + 1 > current) this.counts.set(repeatPath, index + 1);
			}
			prefix += rest.slice(0, close + 1);
			rest = rest.slice(close + 1);
		}
	}
}
