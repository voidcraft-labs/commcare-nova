// lib/commcare/index.ts
//
// The one-way bridge from our normalized domain to CommCare's wire
// formats. THIS PACKAGE IS THE ONLY PLACE in lib/ that imports
// CommCare-specific vocabulary (question, case_property_on, etc.).
//
// In Phase 1 this directory is empty. Phase 2+ populates it by moving
// lib/services/cczCompiler, hqJsonExpander, lib/transpiler, and
// lib/services/commcare/validate/ here.

export {};
