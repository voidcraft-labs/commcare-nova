/**
 * Static configuration for reference types — icons, colors, and the shared
 * regex pattern used to identify hashtag references in text.
 *
 * Color mapping:
 *   form  = violet  (primary building block)
 *   case  = violet  (persistent external data — distinguished by icon + prefix;
 *                    every case type shares this one coarse config)
 *   user  = orchid  (stable system properties — warm pink-purple)
 */

import tablerDatabase from "@iconify-icons/tabler/database";
import tablerFileText from "@iconify-icons/tabler/file-text";
import tablerUser from "@iconify-icons/tabler/user";
import { fpathId } from "@/lib/doc/fieldPath";
import { buildHashtagRefRegex } from "@/lib/domain";
import type { Reference, ReferenceType, ReferenceTypeConfig } from "./types";

/**
 * Extract the display ID for a reference chip. Form refs use fpathId to get
 * the leaf field ID from a potentially nested path. Case and user refs
 * are already bare identifiers — returned as-is.
 */
export function displayId(ref: Reference): string {
	return ref.type === "form" ? fpathId(ref.path) : ref.path;
}

/**
 * The wire namespace of a reference — the token between `#` and the first `/`.
 * For form/user refs it's the coarse `type`; for case refs it's the concrete
 * `caseType` (e.g. "mother"). Accepts the minimal shape both a resolved
 * `Reference` and a `ParsedReference` satisfy, so every node-attr write site
 * derives the namespace through one rule instead of writing the literal
 * coarse "case".
 */
export function namespaceOf(
	ref: { type: "form" | "user" } | { type: "case"; caseType: string },
): string {
	return ref.type === "case" ? ref.caseType : ref.type;
}

/**
 * Classify a namespace token into its coarse reference family. `form` and
 * `user` are the only fixed namespaces; every other identifier is a case-type
 * name (the family `"case"`). Single source of the "form/user fixed, else case"
 * rule — `ReferenceProvider.parse`, the TipTap suggestion, and the chip fallback
 * all derive from it so they can't drift.
 */
export function classifyNamespace(namespace: string): ReferenceType {
	if (namespace === "form") return "form";
	if (namespace === "user") return "user";
	return "case";
}

/**
 * Regex matching hashtag references: #form/path, #user/path, and #<caseType>/path
 * (one namespace per case type, e.g. #mother/household_code). Built from the
 * shared segment definition in `lib/domain/hashtagSegments.ts` so it stays in
 * lockstep with the prose matcher (`BARE_HASHTAG_PATTERN`) and the Lezer
 * grammar's hashtag tokens. The namespace is any identifier — the resolve gate
 * (not this regex) decides whether a match renders as a chip or stays plain
 * text, so the pattern stays deliberately permissive. Path segments are
 * `/`-joined identifiers (nested groups make multi-segment paths); a segment
 * never captures trailing sentence punctuation. Exported WITHOUT the `g` flag
 * to avoid shared mutable `lastIndex` state — consumers create a global
 * instance via `new RegExp(HASHTAG_REF_PATTERN, 'g')`.
 */
export const HASHTAG_REF_PATTERN = buildHashtagRefRegex();

/** The three hashtag namespaces — single source of truth for iteration and validation. */
export const REFERENCE_TYPES: readonly ReferenceType[] = [
	"form",
	"case",
	"user",
] as const;

/**
 * Shared chip dimension constants. Used by chipDom.ts (CodeMirror inline CSS)
 * and ReferenceChip.tsx (Tailwind) to keep both rendering paths in sync.
 */
export const CHIP = {
	height: 18,
	fontSize: 11,
	iconSize: 11,
	borderRadius: 4,
	paddingX: 5,
	gap: 3,
	maxLabelWidth: 140,
} as const;

export const REF_TYPE_CONFIG: Record<ReferenceType, ReferenceTypeConfig> = {
	form: {
		type: "form",
		icon: tablerFileText,
		bgClass: "bg-[rgba(146,143,214,0.15)]",
		textClass: "text-[#928fd6]",
		borderClass: "border-[rgba(146,143,214,0.2)]",
		cssColor: "#928fd6",
		cssBg: "rgba(146, 143, 214, 0.15)",
		cssBorder: "rgba(146, 143, 214, 0.2)",
	},
	case: {
		type: "case",
		icon: tablerDatabase,
		bgClass: "bg-nova-violet/15",
		textClass: "text-nova-violet-bright",
		borderClass: "border-nova-violet/20",
		cssColor: "#a78bfa",
		cssBg: "rgba(139, 92, 246, 0.15)",
		cssBorder: "rgba(139, 92, 246, 0.2)",
	},
	user: {
		type: "user",
		icon: tablerUser,
		bgClass: "bg-[rgba(197,149,208,0.15)]",
		textClass: "text-[#c595d0]",
		borderClass: "border-[rgba(197,149,208,0.2)]",
		cssColor: "#c595d0",
		cssBg: "rgba(197, 149, 208, 0.15)",
		cssBorder: "rgba(197, 149, 208, 0.2)",
	},
};
