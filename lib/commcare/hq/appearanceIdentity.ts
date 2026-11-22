/** A protected question presentation, extracted from the identity reader's
 * own body/control and bind facts. Compare the spellings the publication
 * actually carried; a missing or unreadable setting can never erase one. */
import type { FieldKind } from "@/lib/domain";
import { writeFieldAppearance } from "../xform/appearance";
import { UPLOAD_MEDIATYPE_BY_CAPTURE_KIND } from "../xform/captureUpload";
import { readFieldAppearance } from "../xform/readDisplaySettings";
import type {
	AnswerLeaf,
	ContainerIdentity,
	CoreTypeClass,
} from "./sourceIdentity";

type Control = AnswerLeaf | ContainerIdentity;

const inputKinds: Partial<Record<CoreTypeClass, FieldKind>> = {
	text: "text",
	integer: "int",
	decimal: "decimal",
	date: "date",
	time: "time",
	"date-time": "datetime",
	geopoint: "geopoint",
	barcode: "barcode",
};

function displayKind(control: Control): FieldKind | undefined {
	if ("kind" in control) return control.kind;
	switch (control.control) {
		case "input":
			return inputKinds[control.typeClass];
		case "select1":
			return "single_select";
		case "select":
			return "multi_select";
		case "secret":
			return "secret";
		case "trigger":
			return "label";
		case "upload": {
			if (control.mediatype === UPLOAD_MEDIATYPE_BY_CAPTURE_KIND.image)
				return control.appearance === "signature" ? "signature" : "image";
			for (const kind of ["audio", "video", "file"] as const)
				if (control.mediatype === UPLOAD_MEDIATYPE_BY_CAPTURE_KIND[kind])
					return kind;
			return undefined;
		}
		default:
			return undefined;
	}
}

function presentationOf(control: Control): string | undefined {
	if (!control.appearance) return undefined;
	const kind = displayKind(control);
	if (!kind) return undefined;
	const settings = readFieldAppearance(
		kind,
		control.appearance,
		"kind" in control && control.hasRepeatingRows === true,
	);
	if (!settings) return undefined;
	const emitted = writeFieldAppearance(kind, settings);
	if (!emitted) return undefined;
	return kind + " " + emitted;
}

export function holdsQuestionAppearance(control: Control): boolean {
	return presentationOf(control) !== undefined;
}

export function sameQuestionAppearance(a: Control, b: Control): boolean {
	if (a.appearance === b.appearance) return true;
	const left = presentationOf(a);
	return left !== undefined && left === presentationOf(b);
}
