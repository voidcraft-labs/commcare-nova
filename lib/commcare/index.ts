// lib/commcare/index.ts
//
// The client-safe emission primitives of the CommCare boundary. The
// package owns every CommCare-specific vocabulary item (HQ JSON shapes,
// XForm XML, doc_type strings, session datums, identifier rules): it
// writes our normalized domain as CommCare's wire formats and, in
// `reader/`, which sits outside this barrel, reads an HQ app back.
// Everything else in lib/ reaches CommCare only through this package.
//
// The barrel re-exports only the primitives that are safe to pull
// into any layer, including client components: constants, HQ JSON
// type declarations, boilerplate shell factories, hashtag expansion,
// identifier validation, session mechanics, the derived wire identity of
// every menu and form, and XML helpers. Anything that drags Node-only
// dependencies (the .ccz archive packer) or a heavy pipeline surface (the
// BlueprintDoc → HqApplication expander, XForm emitter, validator,
// xpath engine, encryption, HQ HTTP client) is imported directly from
// its sub-path (`@/lib/commcare/expander`, `@/lib/commcare/xform`,
// etc.) so Turbopack can tree-shake it out of the client bundle.

export * from "./constants";
export {
	type CsqlRuntimeReads,
	type CsqlRuntimeRow,
	type CsqlRuntimeValues,
	csqlRuntimeReads,
	csqlRuntimeRow,
	foldCsqlRuntime,
} from "./csql/fold";
export * from "./csql/positions";
export {
	type EntryPointProjection,
	type EntryPointRequiredSelection,
	entryPointProjectionIssue,
	projectEntryPoint,
} from "./entryPointProjection";
export * from "./formActions";
export * from "./hashtags";
export * from "./hqShells";
export * from "./identifierValidation";
export {
	homeSelectionConsumers,
	type PreviousTaskProjection,
	type PreviousTaskSelection,
	previousTaskFrame,
	projectModuleTaskSelectionUuids,
	projectPreviousTask,
	projectTaskFormSelections,
	readPreviousTaskProjection,
} from "./previousTaskProjection";
export * from "./session";
export * from "./types";
export * from "./wireIdentity";
export * from "./xml";
