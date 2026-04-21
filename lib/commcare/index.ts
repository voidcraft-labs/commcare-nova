// lib/commcare/index.ts
//
// The one-way bridge from our normalized domain to CommCare's wire
// formats. This package owns every CommCare-specific vocabulary item
// (HQ JSON shapes, XForm XML, doc_type strings, session datums,
// identifier rules) — everything else in lib/ talks to CommCare only
// through this barrel.
//
// The barrel re-exports only the primitives that are safe to pull
// into any layer, including client components: constants, HQ JSON
// type declarations, boilerplate shell factories, hashtag expansion,
// identifier validation, session mechanics, and XML helpers. Anything
// that drags Node-only dependencies (the .ccz archive packer,
// `node:crypto` id generators) or a heavy pipeline surface (the
// BlueprintDoc → HqApplication expander, XForm emitter, validator,
// xpath engine, encryption, HQ HTTP client) is imported directly from
// its sub-path so Turbopack can tree-shake it out of the client
// bundle. See CLAUDE.md for the exact sub-path conventions.

export * from "./constants";
export * from "./deriveCaseConfig";
export * from "./formActions";
export * from "./hashtags";
export * from "./hqShells";
export * from "./identifierValidation";
export * from "./session";
export * from "./types";
export * from "./xml";
