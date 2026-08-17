// lib/domain/index.ts
//
// Public barrel for the domain layer. Every consumer outside lib/domain/
// imports from here or from the kind-specific files under ./fields.

export * from "./authoredIdentities";
export * from "./automations";
export * from "./blueprint";
export * from "./builtinIcons";
export * from "./caseOperationIdentifiers";
export * from "./caseOperationIdentity";
export * from "./caseOperationScope";
export * from "./casePropertyName";
export * from "./casePropertyTypes";
export * from "./caseRetype";
export * from "./caseScalarText";
export * from "./caseTypes";
export * from "./caseWriteInventory";
export * from "./columnApplicability";
export * from "./commCareDatePattern";
export * from "./dateFormats";
export * from "./effectiveCaseTypes";
export * from "./expressionSource";
export * from "./externalUserProperty";
export * from "./fields";
export * from "./forms";
export * from "./hashtagSegments";
export * from "./idSlug";
export * from "./jsonNumber";
export * from "./kinds";
export * from "./localization";
export * from "./localizedBlueprintProjection";
export * from "./lookupCarriers";
export * from "./lookupIds";
export * from "./modules";
export * from "./multimedia";
export * from "./organization";
export * from "./prose";
export * from "./records";
export * from "./referenceIndex";
export * from "./referenceSlots";
export * from "./searchRuntimeValidationMessages";
export * from "./standardCaseProperties";
export * from "./temporalValues";
export * from "./translationUnits";
export * from "./users";
export * from "./uuid";
export * from "./xpath";
