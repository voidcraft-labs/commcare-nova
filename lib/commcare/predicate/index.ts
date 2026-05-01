// lib/commcare/predicate/index.ts
//
// Public surface for the CommCare-side predicate emitters. Predicate
// ASTs originate in `lib/domain/predicate` and cross the
// domain → CommCare boundary here at wire-emission time, so this
// barrel is the single import point for callers that need to compile
// a predicate to CommCare's XPath/CSQL wire format. Other consumers
// in `lib/commcare` (the expander, validator, etc.) should reach
// through this barrel rather than importing the emitter file
// directly so any future addition to the wire-format surface
// (alternative emitters, helpers shared across emitters) lands in
// one place.

export * from "./xpathEmitter";
