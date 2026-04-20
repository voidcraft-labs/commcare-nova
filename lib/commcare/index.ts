// lib/commcare/index.ts
//
// The one-way bridge from our normalized domain to CommCare's wire
// formats. This package owns every CommCare-specific vocabulary item
// (question, case_property_on, doc_type, HQ JSON shapes, XForm XML,
// session datums, identifier rules) — everything else in lib/ talks
// to CommCare only through this barrel.
//
// The barrel re-exports primitives that upstream layers legitimately
// need: constants, HQ JSON types, boilerplate shell factories,
// hashtag expansion, id generation, identifier validation, session
// mechanics, and XML helpers. Sub-packages with their own surface
// (xpath, encryption, HQ HTTP client) are imported directly from
// their sub-path rather than re-exported here, to keep the barrel
// focused on shared primitives.

export * from "./constants";
export * from "./deriveCaseConfig";
export * from "./expander";
export * from "./formActions";
export * from "./hashtags";
export * from "./hqShells";
export * from "./identifierValidation";
export * from "./ids";
export * from "./session";
export * from "./types";
export * from "./xform";
export * from "./xml";
