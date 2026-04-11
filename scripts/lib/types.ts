/**
 * Type re-exports for diagnostic scripts.
 *
 * Imports canonical types from the app's type system so scripts have a
 * single import path. Eliminates the duplicated interfaces that previously
 * lived in inspect-logs.ts and inspect-app.ts.
 *
 * Import from here — never define script-local interfaces for types that
 * already exist in lib/db/types.ts or lib/schemas/blueprint.ts.
 */

// ── Log event system ────────────────────────────────────────────────

export type {
	ConfigEvent,
	EmissionEvent,
	ErrorEvent,
	LogEvent,
	LogToolCall,
	MessageEvent,
	StepEvent,
	StoredEvent,
	TokenUsage,
} from "../../lib/db/types";

// ── Blueprint structure ─────────────────────────────────────────────

export type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	CaseProperty,
	CaseType,
	ConnectConfig,
	FormLink,
	Question,
} from "../../lib/schemas/blueprint";

// ── Model pricing ───────────────────────────────────────────────────

export { DEFAULT_PRICING, MODEL_PRICING } from "../../lib/models";
