/**
 * Shared types for the chip reference system.
 *
 * References are data source pointers (#form/, #user/, and one namespace per
 * readable case type — e.g. #mother/, #pregnancy/) that appear in XPath
 * expressions and labels. The Reference type is a discriminated union because
 * the namespace families have fundamentally different path semantics:
 *   - form: FieldPath (slash-delimited, potentially nested in groups)
 *   - case: bare case property name (flat identifier), scoped to a case type
 *   - user: bare user property name (flat identifier)
 */

import type { IconifyIcon } from "@iconify/react/offline";
import type { FieldPath } from "@/lib/doc/fieldPath";

/** The coarse reference families. `case` is one family covering every case
 *  type — the concrete type lives on `CaseReference.caseType`. Styling keys on
 *  this coarse type (every case type shares the db-icon/violet config); the
 *  namespace that appears on the wire is `caseType`, not the literal "case". */
export type ReferenceType = "form" | "case" | "user";

/** Shared fields across all reference types. */
interface BaseReference {
	/** Human-readable label for autocomplete display. Falls back to path/name if unavailable. */
	label: string;
	/** Canonical serialization form: "#type/path" (e.g. "#form/patient_name"). */
	raw: string;
	/** Override icon for this specific reference (e.g. field kind icon for #form/ refs). */
	icon?: IconifyIcon;
}

/** A form field reference — path may be nested (e.g. "group1/age"). */
export interface FormReference extends BaseReference {
	type: "form";
	path: FieldPath;
}

/** A case property reference — a bare property identifier (e.g. "age") scoped
 *  to a specific addressable case type. `raw` is `#<caseType>/<path>`
 *  (e.g. "#mother/household_code"); `caseType` names the type the property is
 *  read from. The type must be the form's own case type or an ancestor. */
export interface CaseReference extends BaseReference {
	type: "case";
	caseType: string;
	path: string;
}

/** A user property reference — always a bare identifier (e.g. "username"). */
export interface UserReference extends BaseReference {
	type: "user";
	path: string;
}

export type Reference = FormReference | CaseReference | UserReference;

/**
 * Visual configuration for a reference type — icon, Tailwind classes (for React
 * components like TipTap NodeView), and raw CSS values (for CM6 WidgetType.toDOM
 * where Tailwind classes aren't available).
 */
export interface ReferenceTypeConfig {
	type: ReferenceType;
	icon: IconifyIcon;

	/* Tailwind classes for React-rendered chips */
	bgClass: string;
	textClass: string;
	borderClass: string;

	/* Raw CSS values for CM6 DOM-based chips (no Tailwind in WidgetType) */
	cssColor: string;
	cssBg: string;
	cssBorder: string;
}
