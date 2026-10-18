/** One parent element's names: authored ones first, then each allocation. */
export class Namespace {
	private readonly taken: Set<string>;
	constructor(authored: Iterable<string>) {
		this.taken = new Set(authored);
	}
	/** The first free spelling of `base`, without taking it. */
	peek(base: string): string {
		let name = base;
		for (let n = 1; this.taken.has(name); n++) name = `${base}_${n}`;
		return name;
	}
	allocate(base: string): string {
		const name = this.peek(base);
		this.taken.add(name);
		return name;
	}
}
