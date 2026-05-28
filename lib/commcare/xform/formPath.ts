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
 * This type covers PATH REFERENCES — bind `nodeset`, control `ref`,
 * `<setvalue ref>`, splice walk steps. XPath EXPRESSIONS (calculate /
 * relevant / constraint bodies, predicates like `[@case_id='X']`,
 * function calls like `count(...)`) stay as XPath strings parsed via the
 * Lezer grammar; the typed-path discipline applies to STRUCTURAL paths,
 * not to full XPath bodies.
 *
 * Element steps and attribute steps are the only segment kinds. Attribute
 * steps are terminal at the type level — once added, `child` / `attr`
 * throw on the next call. The serializer mirrors CCHQ's path-walker
 * semantics: `commcare-hq/.../app_manager/xform.py::XForm._create_casexml`
 * calls `self.instance_node.find(repeat_context)` with the literal string
 * the path serializes to, relying on the path being a pure structural
 * reference with no predicates or function calls.
 */

import { XML_ELEMENT_NAME_REGEX } from "../constants";

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
					`isn't a path — route it through the Lezer XPath parser instead.`,
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
					`FormPath.parse found an empty segment in "${raw}" — paths can't ` +
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
				`FormPath.child got invalid element name "${name}" — XForm ` +
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
				`FormPath.attr got invalid attribute name "${name}" — XForm ` +
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

	/** True if the path ends in an attribute step. */
	endsInAttribute(): boolean {
		const last = this._segments[this._segments.length - 1];
		return last !== undefined && last.kind === "attribute";
	}

	/**
	 * Serialize to the XPath string the wire expects (`/data`, `/data/foo`,
	 * `/data/foo/@bar`). The single serializer; the only place `/` literals
	 * appear in path emission. Every bind `nodeset`, control `ref`, and
	 * `<setvalue ref>` attribute that consumes a `FormPath` goes through
	 * this method at the attribute-emit site.
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
	 * `/data` root, the rest of the path is verbatim. Every bind's
	 * `vellum:nodeset` attribute consumes this (the dual-attribute pattern
	 * documented in `lib/commcare/CLAUDE.md` — Vellum's editor requires the
	 * hashtag-shaped reference alongside the expanded XPath).
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
