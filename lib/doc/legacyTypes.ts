/**
 * Legacy wire-format types — the nested, CommCare-flavored shape the
 * compile / HQ-upload path still operates on.
 *
 * These types exist only to back the three code paths that need to
 * produce CommCare's nested app blueprint:
 *
 *   - `lib/doc/legacyBridge.ts` — converts a normalized `BlueprintDoc`
 *     into this shape (`toBlueprint`) and back (`legacyAppBlueprintToDoc`).
 *   - `lib/services/xformBuilder.ts`, `hqJsonExpander.ts`, `cczCompiler.ts`
 *     — read this shape to emit XForm XML and HQ JSON.
 *   - `scripts/migrate/legacy-event-translator.ts` — translates historical
 *     stored events that captured SA emissions in this shape.
 *
 * **Nothing outside those three surfaces should import from this
 * module.** Agent code uses domain types (`Field`, `Form`, `Module`)
 * exclusively; anything that speaks CommCare wire terms is a boundary.
 *
 * The types are hand-written TypeScript interfaces. Runtime validation
 * on the bridge path happens at the other end via
 * `blueprintDocSchema.parse`; no Zod schema is needed on this side.
 */

/**
 * Wire-format question — nested, pre-normalization. Field names use the
 * CommCare dialect (`type`, `validation`, `validation_msg`,
 * `case_property_on`) because that's what historical data in Firestore
 * and XForm-bound tooling expects.
 */
export interface Question {
	/** Stable crypto UUID assigned at creation. */
	uuid: string;
	/** Semantic id (CommCare property name / XForm node name). */
	id: string;
	/** Field kind discriminator — e.g. "text", "int", "group". */
	type: string;
	label?: string;
	hint?: string;
	required?: string;
	validation?: string;
	validation_msg?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	options?: Array<{ value: string; label: string }>;
	case_property_on?: string;
	/** Nested questions for group / repeat containers. */
	children?: Question[];
}

/** Wire-format close_condition on a close-typed form. */
export interface WireCloseCondition {
	question: string;
	answer: string;
	operator?: "=" | "selected";
}

/** Wire-format form link datum override. */
export interface WireFormLinkDatum {
	name: string;
	xpath: string;
}

/** Wire-format form link target — index-based rather than uuid-based. */
export type WireFormLinkTarget =
	| { type: "form"; moduleIndex: number; formIndex: number }
	| { type: "module"; moduleIndex: number };

/** Wire-format form link. */
export interface WireFormLink {
	condition?: string;
	target: WireFormLinkTarget;
	datums?: WireFormLinkDatum[];
}

/** Wire-format Connect learn module (training content) sub-config. */
export interface WireConnectLearnModule {
	id?: string;
	name: string;
	description: string;
	time_estimate: number;
}

/** Wire-format Connect assessment (quiz / certification). */
export interface WireConnectAssessment {
	id?: string;
	user_score: string;
}

/** Wire-format Connect deliver unit (paid-service-delivery entity). */
export interface WireConnectDeliverUnit {
	id?: string;
	name: string;
	entity_id: string;
	entity_name: string;
}

/** Wire-format Connect task (experimental FLW remediation). */
export interface WireConnectTask {
	id?: string;
	name: string;
	description: string;
}

/** Wire-format Connect config. */
export interface WireConnectConfig {
	learn_module?: WireConnectLearnModule;
	assessment?: WireConnectAssessment;
	deliver_unit?: WireConnectDeliverUnit;
	task?: WireConnectTask;
}

/** Wire-format form — one data-collection surface within a module. */
export interface BlueprintForm {
	uuid: string;
	name: string;
	type: "registration" | "followup" | "close" | "survey";
	close_condition?: WireCloseCondition;
	post_submit?: "app_home" | "root" | "module" | "parent_module" | "previous";
	form_links?: WireFormLink[];
	connect?: WireConnectConfig;
	questions: Question[];
}

/** Wire-format case list column (also used for detail columns). */
export interface WireCaseListColumn {
	field: string;
	header: string;
}

/** Wire-format module — a menu grouping related forms under a case type. */
export interface BlueprintModule {
	uuid: string;
	name: string;
	case_type?: string;
	case_list_only?: boolean;
	forms: BlueprintForm[];
	case_list_columns?: WireCaseListColumn[];
	case_detail_columns?: WireCaseListColumn[];
}

/** Wire-format case property metadata (used inside wire case types). */
export interface WireCaseProperty {
	name: string;
	label: string;
	data_type?:
		| "text"
		| "int"
		| "decimal"
		| "date"
		| "time"
		| "datetime"
		| "single_select"
		| "multi_select"
		| "geopoint";
	hint?: string;
	required?: string;
	validation?: string;
	validation_msg?: string;
	options?: Array<{ value: string; label: string }>;
}

/** Wire-format case type definition. */
export interface WireCaseType {
	name: string;
	properties: WireCaseProperty[];
	parent_type?: string;
	relationship?: "child" | "extension";
}

/** Wire-format app — the legacy nested `AppBlueprint` shape. */
export interface AppBlueprint {
	app_name: string;
	connect_type?: "learn" | "deliver";
	modules: BlueprintModule[];
	case_types: WireCaseType[] | null;
}
