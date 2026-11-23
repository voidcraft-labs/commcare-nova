import { chargeWork } from "../../workMeter";

/** One bytewise XForm.normalize_itext replacement, streamed across chunk
 * boundaries. The pending prefix is an offset in the original needle. */
class ReferenceReplacement {
	private readonly prefix: Uint32Array;
	private matched = 0;
	constructor(
		private readonly old: string,
		private readonly kept: string,
	) {
		chargeWork("compare", old.length);
		this.prefix = new Uint32Array(old.length);
		for (let i = 1, k = 0; i < old.length; i++) {
			while (k && old[i] !== old[k]) k = this.prefix[k - 1];
			if (old[i] === old[k]) k++;
			this.prefix[i] = k;
		}
	}

	*write(text: string): Generator<string> {
		chargeWork("visit", text.length);
		let plain = 0;
		for (let i = 0; i < text.length; i++) {
			while (this.matched && text[i] !== this.old[this.matched]) {
				const keep = this.prefix[this.matched - 1];
				yield this.old.slice(0, this.matched - keep);
				this.matched = keep;
			}
			if (text[i] === this.old[this.matched]) {
				if (plain < i) yield text.slice(plain, i);
				plain = i + 1;
				if (++this.matched === this.old.length) {
					this.matched = 0;
					chargeWork("print", this.kept.length);
					yield this.kept;
				}
			}
		}
		if (plain < text.length) yield text.slice(plain);
	}

	finish(): string {
		return this.old.slice(0, this.matched);
	}
}

function* through(
	stages: readonly ReferenceReplacement[],
	start: number,
	text: string,
): Generator<string> {
	// A source can name many renames: the pipeline uses data, not the JS call stack.
	const frames: Iterator<string>[] = [[text][Symbol.iterator]()];
	while (frames.length) {
		const next = frames[frames.length - 1].next();
		if (next.done) {
			frames.pop();
			continue;
		}
		const stage = stages[start + frames.length - 1];
		if (stage === undefined) yield next.value;
		else frames.push(stage.write(next.value));
	}
}

/** HQ replaces each old reference before running the instance scanner. A
 * repeated reference can expand to the same long ID thousands of times.
 * Keep each replacement text once and scan bounded batches at a literal ')':
 * no HTML character reference or HQ instance match can cross that delimiter. */
export function* scanAfterRenames(
	source: string,
	renames: ReadonlyMap<string, string>,
): Generator<string> {
	if (!renames.size) {
		yield source;
		return;
	}
	const refs = new Map<string, string>();
	const reference = (id: string) => {
		let ref = refs.get(id);
		if (ref === undefined) {
			chargeWork("print", id.length + 12);
			ref = `jr:itext('${id}')`;
			refs.set(id, ref);
		}
		return ref;
	};
	const stages = [...renames].map(
		([old, kept]) => new ReferenceReplacement(reference(old), reference(kept)),
	);
	let blocks: string[] = [];
	let parts: string[] = [];
	let length = 0;
	for (let start = 0; start <= stages.length; start++) {
		const input = start === 0 ? source : stages[start - 1].finish();
		if (!input.length) continue;
		for (const chunk of through(stages, start, input)) {
			chargeWork("visit", chunk.length);
			const stop = length + chunk.length >= 8192 ? chunk.lastIndexOf(")") : -1;
			if (stop < 0) {
				parts.push(chunk);
				// A source can contain many incomplete call prefixes before its
				// first delimiter. Hold those short fragments in compact blocks.
				if (parts.length === 1024) {
					blocks.push(parts.join(""));
					parts = [];
				}
				length += chunk.length;
				continue;
			}
			parts.push(chunk.slice(0, stop + 1));
			blocks.push(parts.join(""));
			yield blocks.join("");
			blocks = [];
			parts = [];
			const remaining = chunk.slice(stop + 1);
			if (remaining) parts.push(remaining);
			length = remaining.length;
		}
	}
	if (length) {
		blocks.push(parts.join(""));
		yield blocks.join("");
	}
}
