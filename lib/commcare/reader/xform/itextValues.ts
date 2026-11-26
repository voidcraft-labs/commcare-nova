/** HQ compares the byte serialization of each value, including the namespaces
 * lxml copies onto a standalone value and its tail. Assign exact identities
 * to those parts without copying inherited namespace text into each label. */
import { createHash } from "node:crypto";
import { type Element, isTag, isText } from "domhandler";
import { chargeWork } from "../../workMeter";
import { splitName } from "../../xmlNamespaces";

interface Prefixes {
	readonly bindings: ReadonlyMap<string, number>;
	readonly orders: Map<string, number>;
}
interface Order {
	readonly first: readonly number[];
	readonly rest: Prefixes;
}
function ordered({ first, rest }: Order): number[] {
	chargeWork("compare", first.length + rest.bindings.size);
	const seen = new Set(first);
	const list = [...first];
	for (const id of rest.bindings.values()) if (!seen.has(id)) list.push(id);
	return list;
}

export class ItextValues {
	private next = 1;
	private readonly atoms = new Map<string, number>();
	private readonly tuples = new Map<string, number>();
	private readonly own = new WeakMap<Element, ReadonlyMap<string, number>>();
	private readonly scopes = new WeakMap<Element, Prefixes>();
	private readonly empty: Prefixes = { bindings: new Map(), orders: new Map() };
	private readonly orders = new Map<string, { id: number; order: Order }[]>();
	private readonly values = new WeakMap<Element, number>();

	private atom(text: string): number {
		chargeWork("compare", text.length + 1);
		const found = this.atoms.get(text);
		if (found !== undefined) return found;
		const id = this.next++;
		this.atoms.set(text, id);
		return id;
	}

	private tuple(parts: readonly number[]): number {
		chargeWork("compare", parts.length + 1);
		const key = parts.join(",");
		const found = this.tuples.get(key);
		if (found !== undefined) return found;
		const id = this.next++;
		this.tuples.set(key, id);
		return id;
	}

	private declarations(element: Element): ReadonlyMap<string, number> {
		const known = this.own.get(element);
		if (known) return known;
		let own: Map<string, number> | undefined;
		for (const [name, uri] of Object.entries(element.attribs)) {
			chargeWork("visit", 1);
			if (
				name !== "xmlns:xml" &&
				(name === "xmlns" || name.startsWith("xmlns:"))
			) {
				const prefix = name === "xmlns" ? "" : name.slice(6);
				own ??= new Map();
				own.set(prefix, this.tuple([this.atom(name), this.atom(uri)]));
			}
		}
		const bindings = own ?? this.empty.bindings;
		this.own.set(element, bindings);
		return bindings;
	}

	private scope(element: Element): Prefixes {
		const known = this.scopes.get(element);
		if (known) return known;
		const parent =
			element.parent && isTag(element.parent)
				? this.scope(element.parent)
				: this.empty;
		const own = this.declarations(element);
		let result = parent;
		if (own.size) {
			chargeWork("visit", own.size + parent.bindings.size);
			const bindings = new Map(own);
			for (const [prefix, id] of parent.bindings)
				if (!bindings.has(prefix)) bindings.set(prefix, id);
			result = { bindings, orders: new Map() };
		}
		this.scopes.set(element, result);
		return result;
	}

	private namespaceOrder(element: Element, standalone: boolean): number {
		const rest = standalone ? this.scope(element) : this.empty;
		const first = new Set(this.declarations(element).values());
		if (standalone) {
			const used = (prefix: string) => {
				const id = rest.bindings.get(prefix);
				if (id !== undefined && prefix !== "xml") first.add(id);
			};
			used(splitName(element.name).prefix);
			for (const name of Object.keys(element.attribs)) {
				const prefix = splitName(name).prefix;
				if (prefix && prefix !== "xmlns") used(prefix);
			}
		}
		const lead = [...first];
		const cacheKey = lead.join(",");
		const known = rest.orders.get(cacheKey);
		if (known !== undefined) return known;
		const order = { first: lead, rest };
		const list = ordered(order);
		// Keep a compact recipe per order. Hashing only indexes candidates. The
		// exact comparison establishes identity, including across different scopes.
		const digest = createHash("sha256")
			.update(new Uint8Array(Uint32Array.from(list).buffer))
			.digest("hex");
		const bucket = this.orders.get(digest) ?? [];
		let id: number | undefined;
		for (const previous of bucket) {
			const other = ordered(previous.order);
			if (
				other.length === list.length &&
				other.every((x, i) => x === list[i])
			) {
				id = previous.id;
				break;
			}
		}
		if (id === undefined) {
			id = this.next++;
			bucket.push({ id, order });
			this.orders.set(digest, bucket);
		}
		rest.orders.set(cacheKey, id);
		return id;
	}

	private element(element: Element, standalone: boolean): number {
		chargeWork("visit", 1);
		const attrs: number[] = [];
		for (const [name, value] of Object.entries(element.attribs))
			if (name !== "xmlns" && !name.startsWith("xmlns:"))
				attrs.push(this.atom(name), this.atom(value));
		const content: number[] = [];
		let text: string[] = [];
		let sawText = false;
		const flush = () => {
			if (!text.length) return;
			sawText = true;
			const combined = text.join("");
			if (combined) content.push(this.atom(combined));
			text = [];
		};
		for (const child of element.children) {
			chargeWork("visit", 1);
			if (isText(child)) {
				chargeWork("compare", child.data.length);
				text.push(child.data);
			} else if (isTag(child)) {
				flush();
				content.push(this.element(child, false));
			} else if (child.type === "directive") {
				flush();
				content.push(this.tuple([-1, this.atom(child.data)]));
			}
		}
		flush();
		// An empty CDATA leaves a text node: lxml prints <value></value>.
		// It changes no bytes if another child already requires an end tag.
		if (!content.length && sawText) content.push(this.atom(""));
		return this.tuple([
			-2,
			this.atom(element.name),
			this.namespaceOrder(element, standalone),
			this.tuple(attrs),
			this.tuple(content),
		]);
	}

	value(element: Element): number {
		const known = this.values.get(element);
		if (known !== undefined) return known;
		const trailing: string[] = [];
		for (
			let next = element.next;
			next && (isText(next) || next.type === "comment");
			next = next.next
		) {
			chargeWork("visit", 1);
			if (isText(next)) {
				chargeWork("compare", next.data.length);
				trailing.push(next.data);
			}
		}
		const tail = trailing.join("");
		// bytes.strip() on lxml output; a literal CR was escaped to &#13;.
		let end = tail.length;
		while (
			end &&
			(tail[end - 1] === " " ||
				tail[end - 1] === "\t" ||
				tail[end - 1] === "\n")
		)
			end--;
		const id = this.tuple([
			this.element(element, true),
			this.atom(tail.slice(0, end)),
		]);
		this.values.set(element, id);
		return id;
	}

	language(code: string): number {
		return this.atom(code);
	}

	translation(lang: number, forms: Map<string | undefined, number>): number {
		// HQ sorts a multiset. Sorting compact identities gives the same equality.
		chargeWork(
			"compare",
			forms.size * Math.ceil(Math.log2(Math.max(1, forms.size))),
		);
		return this.tuple([lang, ...[...forms.values()].sort((a, b) => a - b)]);
	}
}
