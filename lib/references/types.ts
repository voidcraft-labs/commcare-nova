/**
 * Shared types for the chip reference system.
 *
 * References are data source pointers (#form/, #case/, #user/) that appear
 * in XPath expressions and labels. The Reference type is a discriminated union
 * because the three namespaces have fundamentally different path semantics:
 *   - form: QuestionPath (slash-delimited, potentially nested in groups)
 *   - case: bare case property name (flat identifier)
 *   - user: bare user property name (flat identifier)
 */

import type { IconifyIcon } from "@iconify/react/offline";
import type { QuestionPath } from "@/lib/services/questionPath";

/** The three hashtag reference namespaces in CommCare XPath. */
export type ReferenceType = "form" | "case" | "user";

/** Shared fields across all reference types. */
interface BaseReference {
	/** Human-readable label for autocomplete display. Falls back to path/name if unavailable. */
	label: string;
	/** Canonical serialization form: "#type/path" (e.g. "#form/patient_name"). */
	raw: string;
	/** Override icon for this specific reference (e.g. question type icon for #form/ refs). */
	icon?: IconifyIcon;
}

/** A form question reference — path may be nested (e.g. "group1/age"). */
export interface FormReference extends BaseReference {
	type: "form";
	path: QuestionPath;
}

/** A case property reference — always a bare identifier (e.g. "age"). */
export interface CaseReference extends BaseReference {
	type: "case";
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
