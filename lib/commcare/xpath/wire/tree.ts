import type { JavaRosaFunction } from "../functionCapabilities";
import type { InstanceDecl } from "./instances";

export type WireFunction =
	| JavaRosaFunction
	| "jr:itext"
	| "jr:choice-name"
	| "here";
export type WireComparison = "=" | "!=" | "<" | "<=" | ">" | ">=";
export type WireArithmetic = "+" | "-" | "*" | "div" | "mod";

/** Resolved wire identities only. No raw expression or arbitrary variable arm. */
export type WireExpr =
	| { readonly k: "str"; readonly value: string }
	| { readonly k: "num"; readonly value: number }
	| {
			readonly k: "cmp";
			readonly op: WireComparison;
			readonly left: WireExpr;
			readonly right: WireExpr;
	  }
	| {
			readonly k: "arith";
			readonly op: WireArithmetic;
			readonly left: WireExpr;
			readonly right: WireExpr;
	  }
	| {
			readonly k: "and" | "or";
			readonly items: readonly [WireExpr, WireExpr, ...WireExpr[]];
	  }
	| { readonly k: "neg"; readonly value: WireExpr }
	| {
			readonly k: "call";
			readonly fn: WireFunction;
			readonly args: readonly WireExpr[];
	  }
	| WirePath
	| {
			readonly k: "expansion";
			readonly of: "case" | "worker" | "search";
			readonly expr: WireExpr;
	  }
	| { readonly k: "case-id-var" | "next-input-var" | "calculated-property-var" }
	| { readonly k: "enum-label-var" | "hq-enum-var"; readonly index: number }
	| { readonly k: "image-alt-var"; readonly value: string }
	| { readonly k: "endpoint-argument-var"; readonly name: string };

export interface WirePath {
	readonly k: "path";
	readonly root: WireRoot;
	readonly steps: readonly WireStep[];
	/** Core's refusal of this read over an instance with no rows is the
	 * behavior wanted, so it is never guarded (`emptyRows.ts`): a case
	 * owner moved to a place, where a worker assigned nowhere must stop the
	 * form at the read rather than write a blank owner. */
	readonly refusesEmpty?: true;
}

export type WireRoot =
	| { readonly k: "form"; readonly spelling: "hashtag" | "absolute" }
	| { readonly k: "context" | "current" | "hq-case" }
	| { readonly k: "instance"; readonly decl: InstanceDecl };

export interface WireStep {
	readonly axis: "child" | "attribute" | "self" | "parent" | "wildcard";
	readonly name?: string;
	readonly predicates: readonly WireExpr[];
}

export type WireMode =
	| { readonly target: "xform"; readonly constraint: boolean }
	| { readonly target: "vellum"; readonly constraint: boolean }
	| { readonly target: "suite" | "preview" }
	| {
			readonly target: "hq-json";
			readonly interpolation:
				| "none"
				| "case"
				| "no-case"
				| "no-dots"
				| "enum-key";
	  };

export type NonShadowWireMode = Exclude<
	WireMode,
	{ readonly target: "vellum" }
>;

export interface SerializedWire {
	readonly text: string;
	readonly instances: ReadonlySet<InstanceDecl>;
}
