import type { Element } from "domhandler";
import { decodeXML } from "entities";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type ProseTemplate,
	printProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { el, text } from "../elementBuilders";
import { xpathStringLiteral } from "../xpath/stringLiteral";
import type { FormPath } from "./formPath";

interface LocalizedMessage {
	readonly language: string;
	readonly template: ProseTemplate;
}
type MessagePart =
	| { readonly literal: string }
	| { readonly expression: string };

export interface ProtectedConstraintMessage {
	readonly expression: string;
	readonly forms: ReadonlyMap<string, Element[]>;
}

/** Core's alert filler treats literal and returned `${n}` as output slots.
 * Compose these messages in the raw constraint expression instead. Standard
 * itext values remain intact, owned by an irrelevant input, for HQ/Vellum and
 * multimedia. Plain literal messages keep their existing alert spelling.
 */
export function protectConstraintMessage(
	id: string,
	messages: readonly LocalizedMessage[],
	doc: BlueprintDoc,
	expand: (expression: string) => string,
): ProtectedConstraintMessage | undefined {
	if (
		!messages.some(({ template }) =>
			template.parts.some(
				(part) => part.kind !== "text" || decodeXML(part.text).includes("${"),
			),
		)
	)
		return undefined;

	// A non-expanding typed reference has always rendered its projected text.
	// Keep that branch, including identity resolution's dangling-ref refusal.
	const terms = messages.map(({ language, template }) => ({
		language,
		parts: template.parts.map<MessagePart>((part) => {
			if (part.kind === "text") return { literal: decodeXML(part.text) };
			const projected = printProseTemplate({ parts: [part] }, doc);
			const expanded = expand(projected);
			return expanded === projected
				? { literal: decodeXML(projected) }
				: { expression: expanded };
		}),
	}));
	const pieceIndices = new Set(
		terms.flatMap(({ parts }) =>
			parts.flatMap((part, index) => ("literal" in part ? [index] : [])),
		),
	);
	const forms = new Map<string, Element[]>();
	const itext = (form?: string): string =>
		`jr:itext(${xpathStringLiteral(form === undefined ? id : `${id};${form}`)})`;
	const expressions: string[] = [];
	for (const { language, parts } of terms) {
		const values: Element[] = [];
		const add = (form: string, value: string): void => {
			values.push(el("value", { form }, [text(value)]));
		};
		// HQ merges equal itext groups but only rewrites exact base-id refs.
		// Keep suffix-based internal refs attached to this group's identity.
		add("__nova_identity", id);
		add("__nova_mode", "plain");
		add("__nova_mode;markdown", "plain");
		for (const mode of ["image", "audio", "video", "video-inline"])
			add(`__nova_mode;${mode}`, "media");
		add("__nova_locale", language);
		add("__nova_locale;markdown", language);
		for (const index of pieceIndices) {
			const part = parts[index];
			const payload = asciiJson(
				part !== undefined && "literal" in part ? part.literal : "",
			);
			add(`__nova_piece_${index}`, payload);
			add(`__nova_piece_${index};markdown`, payload);
		}
		forms.set(language, values);
		const composed = parts.map((part, index) =>
			"expression" in part
				? part.expression
				: `json-property(${itext(`__nova_piece_${index}`)}, 'v')`,
		);
		// concat(singleNodeset) joins multiple nodes in Core; ordinary output
		// instead unpacks one scalar. Do not silently change that contract.
		const composedExpression =
			composed.length === 0
				? "''"
				: composed.length === 1
					? composed[0]
					: `concat(${composed.join(", ")})`;
		const ambiguousReferences = [
			...new Set(
				parts.flatMap((part) =>
					"expression" in part ? [part.expression] : [],
				),
			),
		]
			.map((reference) => `count(${reference}) > 1`)
			.join(" or ");
		// Core catches raw-message errors and exposes the expression itself.
		// A reference to several answers instead requests the client's normal
		// validation warning. The lazy branch preserves zero/singleton coercion
		// and chooses no answer from an ambiguous repeat.
		expressions.push(
			ambiguousReferences
				? `if(${ambiguousReferences}, '', ${composedExpression})`
				: composedExpression,
		);
	}
	let expression = expressions.at(-1) ?? "''";
	for (let index = messages.length - 2; index >= 0; index--) {
		expression = `if(${itext("__nova_locale")} = ${xpathStringLiteral(messages[index].language)}, ${expressions[index]}, ${expression})`;
	}
	return {
		forms,
		expression: `if(${itext("__nova_mode")} = 'media', ${itext()}, ${expression})`,
	};
}

/** ASCII JSON survives XML indentation and Vellum's NBSP replacement. */
function asciiJson(value: string): string {
	const json = JSON.stringify({ v: value });
	let encoded = "";
	for (let index = 0; index < json.length; index++) {
		const unit = json.charCodeAt(index);
		encoded +=
			unit > 0x7f || "<>&'".includes(json[index])
				? `\\u${unit.toString(16).padStart(4, "0")}`
				: json[index];
	}
	return encoded;
}

/** All later authored siblings and root Connect blocks are reserved up front.
 * Other generated siblings cannot overlap: count uses `nova_count_`, while
 * URL/datetime/constraint collections use reserved `__nova_` prefixes. Case
 * and metadata scaffolding use fixed `case`/`subcase`/`meta` names.
 */
export class ConstraintMessageNames {
	private readonly scopes = new Map<string, Set<string>>();
	constructor(
		private readonly doc: BlueprintDoc,
		private readonly rootNames: ReadonlySet<string>,
	) {}
	allocate(fieldUuid: Uuid, parent: FormPath): string {
		const scope = parent.toXPath();
		let names = this.scopes.get(scope);
		if (names === undefined) {
			names = new Set(
				orderedFieldUuids(this.doc, this.doc.fieldParent[fieldUuid]).map(
					(uuid) => this.doc.fields[uuid].id,
				),
			);
			if (scope === "/data") for (const name of this.rootNames) names.add(name);
			this.scopes.set(scope, names);
		}
		const base = `nova_constraint_message_${this.doc.fields[fieldUuid].id}`;
		let name = base;
		for (let suffix = 1; names.has(name); suffix++) name = `${base}_${suffix}`;
		names.add(name);
		return name;
	}
}
