/**
 * Typed reference to a node inside a Nova-emitted XForm's primary data
 * instance — the structural `/data/<element>/<element>/@attr` shape.
 *
 * Construction is through segment-builder methods; serialization is the
 * sole place `/` literals appear. Treat instances like DOM nodes: opaque
 * to callers, manipulated through named operations. The design forecloses
 * the failure mode behind the splice bug `addCaseBlocks` shipped — the
 * walker and the bind emitter both consume the same constructed value, so
 * a disagreement between "where the wrapper lands" and "where the bind
 * points" becomes unrepresentable at the type level.
 *
 * This type owns structural form coordinates, shared by DOM splicing and
 * generated XPath. `toWire()` and `toWireRelative()` project those coordinates
 * into the common wire tree; the XML boundary serializes that tree. The old
 * text projections remain only for HQ metadata and the PR5 authored transition.
 *
 * Element steps and attribute steps are the only segment kinds. Attribute
 * steps are terminal at the type level — once added, `child` / `attr`
 * throw on the next call. The serializer mirrors CCHQ's path-walker
 * semantics: `commcare-hq/.../app_manager/xform.py::XForm._create_casexml`
 * calls `self.instance_node.find(repeat_context)` with the literal string
 * the path serializes to, relying on the path being a pure structural
 * reference with no predicates or function calls.
 */

import type { Field } from "@/lib/domain";
import { XML_ELEMENT_NAME_REGEX } from "../constants";
import { w } from "../xpath/wire/builders";
import type { WirePath, WireStep } from "../xpath/wire/tree";

/** One step in a `FormPath`. Element steps descend; attribute steps terminate. */
export type FormPathSegment =
	| { readonly kind: "element"; readonly name: string }
	| { readonly kind: "attribute"; readonly name: string };

export class FormPath {
	private constructor(
		private readonly _segments: ReadonlyArray<FormPathSegment>,
	) {}

	/**
	 * The form's primary instance root — serializes to `/data`. Every
	 * `FormPath` is rooted here (the wire emitter only emits one `<data>`
	 * element per form, so there's no other anchor).
	 */
	static root(): FormPath {
		return new FormPath([{ kind: "element", name: "data" }]);
	}

	/**
	 * Strict parser from a serialized path back into a typed `FormPath`.
	 * The reverse of `toXPath()` for any path the typed builder produces.
	 *
	 * Throws on any input that isn't a Nova-emittable path shape: must
	 * start with `/data`, segments must be valid XML element names, and
	 * an attribute step (`@name`) must be terminal. The parser is the
	 * boundary between string-typed wire shapes (e.g.
	 * `OpenSubCaseAction.repeat_context`, which stays `string` because
	 * HQ JSON serializes it verbatim) and the typed pipeline that
	 * consumes it inside the emitter.
	 */
	static parse(raw: string): FormPath {
		if (!raw.startsWith("/data")) {
			throw new Error(
				`FormPath.parse expected a path anchored at /data, got "${raw}". ` +
					`Nova XForm paths always start at the primary <data> instance; ` +
					`an XPath expression body (with predicates or function calls) ` +
					`isn't a path. Route it through the Lezer XPath parser instead.`,
			);
		}
		if (raw === "/data") return FormPath.root();
		if (raw[5] !== "/") {
			throw new Error(
				`FormPath.parse expected "/data" or "/data/...", got "${raw}".`,
			);
		}
		const parts = raw.slice("/data/".length).split("/");
		const segments: FormPathSegment[] = [{ kind: "element", name: "data" }];
		for (const part of parts) {
			if (!part) {
				throw new Error(
					`FormPath.parse found an empty segment in "${raw}". Paths can't ` +
						`contain double slashes or trailing slashes.`,
				);
			}
			if (segments[segments.length - 1].kind === "attribute") {
				throw new Error(
					`FormPath.parse found a step after an attribute in "${raw}". ` +
						`Attribute references terminate the path; you can't descend ` +
						`into an attribute.`,
				);
			}
			const isAttr = part.startsWith("@");
			const name = isAttr ? part.slice(1) : part;
			if (!XML_ELEMENT_NAME_REGEX.test(name)) {
				throw new Error(
					`FormPath.parse found an invalid ${isAttr ? "attribute" : "element"} ` +
						`name "${name}" in "${raw}". Segment names must match ` +
						`${XML_ELEMENT_NAME_REGEX}.`,
				);
			}
			segments.push(
				isAttr ? { kind: "attribute", name } : { kind: "element", name },
			);
		}
		return new FormPath(segments);
	}

	/**
	 * Append an element step. Throws if the path already terminates in
	 * an attribute step (attributes are terminal) or if `name` is not a
	 * valid XML element name.
	 */
	child(name: string): FormPath {
		this.assertNotTerminated("child");
		if (!XML_ELEMENT_NAME_REGEX.test(name)) {
			throw new Error(
				`FormPath.child got invalid element name "${name}". XForm ` +
					`element names must match ${XML_ELEMENT_NAME_REGEX} (letter or ` +
					`underscore, then letters / digits / underscores).`,
			);
		}
		return new FormPath([...this._segments, { kind: "element", name }]);
	}

	/**
	 * Append a terminating attribute step (`@name`). After this, further
	 * `child` / `attr` calls throw — attributes are leaves in the XForm
	 * data tree, and a step past an attribute has no meaning.
	 */
	attr(name: string): FormPath {
		this.assertNotTerminated("attr");
		if (!XML_ELEMENT_NAME_REGEX.test(name)) {
			throw new Error(
				`FormPath.attr got invalid attribute name "${name}". XForm ` +
					`attribute names must match ${XML_ELEMENT_NAME_REGEX} (letter or ` +
					`underscore, then letters / digits / underscores).`,
			);
		}
		return new FormPath([...this._segments, { kind: "attribute", name }]);
	}

	/**
	 * Append the model-iteration item step — equivalent to `.child("item")`
	 * but named for the structural rewrite it represents.
	 *
	 * For a `query_bound` (Vellum "model iteration") repeat the per-iteration
	 * template lives at `<X>/<item>`, so fields under such a repeat resolve
	 * to `/data/<X>/item/<field>`. Mirrors `Vellum/src/modeliteration.js::
	 * modelRepeatMugOptions.getPathName`, which appends `"/item"` when
	 * `dataSource.idsQuery` is set. Naming this operation explicitly keeps
	 * the load-bearing rewrite searchable — every caller that adds `/item`
	 * does so through this method, never through a literal `.child("item")`.
	 */
	queryBoundIteration(): FormPath {
		return this.child("item");
	}

	/**
	 * Drop the last segment, returning the parent path. Throws when called
	 * on the root (`/data`) because there's no parent. Useful for the rare
	 * case where a consumer has a leaf path but needs to address a sibling
	 * — usually `child` on the parent is the natural shape, but `parent` is
	 * here for symmetry with DOM navigation.
	 */
	parent(): FormPath {
		if (this._segments.length <= 1) {
			throw new Error(
				`FormPath.parent called on /data (no parent exists). Construct ` +
					`paths from FormPath.root() and descend via .child(...); only ` +
					`call .parent() on a path that has at least one step past /data.`,
			);
		}
		return new FormPath(this._segments.slice(0, -1));
	}

	/**
	 * Element + attribute steps in walk order. First segment is always
	 * `{ kind: "element", name: "data" }` — the splice walker should skip
	 * it (the parsed DOM's `<data>` element IS that segment) and step
	 * through `segments.slice(1)`.
	 */
	segments(): ReadonlyArray<FormPathSegment> {
		return this._segments;
	}

	/** Project structural coordinates directly into the emitted XPath tree. */
	toWire(spelling: "hashtag" | "absolute" = "absolute"): WirePath {
		return w.form(
			this._segments
				.slice(1)
				.map((segment) =>
					segment.kind === "element"
						? w.step(segment.name)
						: w.attr(segment.name),
				),
			spelling,
		);
	}

	/** Address this node from another structural node without parsing text. */
	toWireRelative(
		from: FormPath,
		root: "context" | "current" = "context",
	): WirePath {
		const fromSegments = from.segments();
		let shared = 0;
		while (
			shared < fromSegments.length &&
			shared < this._segments.length &&
			fromSegments[shared].kind === this._segments[shared].kind &&
			fromSegments[shared].name === this._segments[shared].name
		)
			shared++;
		const steps: WireStep[] = [];
		for (let index = shared; index < fromSegments.length; index++)
			steps.push(w.parent());
		for (const segment of this._segments.slice(shared))
			steps.push(
				segment.kind === "element"
					? w.step(segment.name)
					: w.attr(segment.name),
			);
		if (steps.length === 0) steps.push(w.self());
		return root === "current" ? w.current(steps) : w.context(steps);
	}

	/** True if the path ends in an attribute step. */
	endsInAttribute(): boolean {
		const last = this._segments[this._segments.length - 1];
		return last !== undefined && last.kind === "attribute";
	}

	/**
	 * Project structural coordinates for HQ metadata and DOM lookup keys.
	 * Executable XPath attributes use `toWire()` and the shared serializer.
	 */
	toXPath(): string {
		let out = "";
		for (const seg of this._segments) {
			out += seg.kind === "element" ? `/${seg.name}` : `/@${seg.name}`;
		}
		return out;
	}

	/**
	 * Serialize as a Vellum hashtag path — `#form` substitutes for the
	 * `/data` root, the rest of the path is verbatim. This text projection
	 * remains for the authored transition; generated Vellum slots use
	 * `toWire("hashtag")` and the serializer's explicit Vellum mode.
	 */
	toVellum(): string {
		let out = "#form";
		// Skip the leading `data` segment — `#form` substitutes for it.
		for (let i = 1; i < this._segments.length; i++) {
			const seg = this._segments[i];
			out += seg.kind === "element" ? `/${seg.name}` : `/@${seg.name}`;
		}
		return out;
	}

	/** Structural equality — same segment kinds + names in the same order. */
	equals(other: FormPath): boolean {
		if (this._segments.length !== other._segments.length) return false;
		for (let i = 0; i < this._segments.length; i++) {
			const a = this._segments[i];
			const b = other._segments[i];
			if (a.kind !== b.kind || a.name !== b.name) return false;
		}
		return true;
	}

	private assertNotTerminated(operation: "child" | "attr"): void {
		if (this.endsInAttribute()) {
			throw new Error(
				`FormPath.${operation} can't extend a path that already terminates ` +
					`in an attribute step (${this.toXPath()}). Attribute steps are ` +
					`leaves in the XForm data tree; drop back to the parent element ` +
					`first via .parent() if you need a different attribute on the same node.`,
			);
		}
	}
}

/** Resolve the child-container path for a generic field-tree walk. */
export function descendFormPathIntoField(
	field: Field,
	ownPath: FormPath,
): FormPath {
	return field.kind === "repeat" && field.repeat_mode === "query_bound"
		? ownPath.queryBoundIteration()
		: ownPath;
}

/**
 * The relative steps from `from` to `to`: one `..` for every step from
 * `from` up to the nearest ancestor the two share, then the steps down to
 * `to`. `.` when the two are the same node.
 */
export function relativeXPath(from: FormPath, to: FormPath): string {
	const fromSegments = from.segments();
	const toSegments = to.segments();
	let shared = 0;
	while (
		shared < fromSegments.length &&
		shared < toSegments.length &&
		fromSegments[shared].kind === toSegments[shared].kind &&
		fromSegments[shared].name === toSegments[shared].name
	) {
		shared += 1;
	}
	const parts: string[] = [];
	for (let index = shared; index < fromSegments.length; index += 1) {
		parts.push("..");
	}
	for (let index = shared; index < toSegments.length; index += 1) {
		const segment = toSegments[index];
		parts.push(segment.kind === "element" ? segment.name : `@${segment.name}`);
	}
	return parts.join("/") || ".";
}

/**
 * Address `to` from the node `from` whose expression reads it, as
 * `current()/<relative steps>`. `current()` is intentional even where a
 * bare relative path would do at the expression root: JavaRosa keeps it
 * anchored on the expression's original context while a predicate
 * temporarily moves the evaluation context to a candidate node, so a bare
 * `../field` nested inside a predicate would read from the candidate. Core
 * evaluates a bind's expressions with its node as that context and a
 * setvalue's value with its target as that context
 * (commcare-core `SetValueAction.processAction`).
 */
export function originalContextPath(from: FormPath, to: FormPath): string {
	return `current()/${relativeXPath(from, to)}`;
}

/** The generated-wire counterpart; the old string projection retires in PR5. */
export function originalContextWirePath(
	from: FormPath,
	to: FormPath,
): WirePath {
	return to.toWireRelative(from, "current");
}
