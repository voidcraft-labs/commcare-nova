# Built-in record reads in forms

A form could read a built-in value only if its case-type catalog happened to
explicitly declare that property. `toReachableIndex` seeded only record ID,
while the effective catalog exposed all standard metadata. This caused normal
form authoring to reject an owner read and suggest adding a custom property.

Admission alone was insufficient. `expandCaseToWire` and Preview's
`previewHashtagNodeSet` special-cased record ID but treated owner and lifecycle
status as child elements. The existing case-list/query mapping correctly knew
these were attributes. Preview also omitted Core's copied external-ID child.

The correction gives form-readable catalogs the same standard properties and
uses the existing attribute mapping for both form consumers. Registration and
survey narrowing remains unchanged. Standard properties remain platform-owned;
this does not introduce generic writes to owner or lifecycle status.

## Primary sources and observations

CommCare Core `8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`:

- `CaseChildElement::cache` installs case ID, owner and status as attributes.
  `case_name`, `date_opened` and `last_modified` are children.
- `Case::setExternalId` stores the value in the property data; `CaseChildElement`
  exposes both its attribute and the copied child property.
- Opening and modification children use `DateData`, not `DateTimeData`. The
  stored timestamps therefore do not imply time-of-day precision in form reads.

`StandardCaseReadsRuntimeTest` opens the exact admitted CCZ form against native
Case instances. It reads all seven supported values on both the selected record
and its closed parent. The paired Nova test uses production FormEngine and the
casedb projection. These checks passed; they do not establish sync eligibility,
Android presentation or HQ regeneration. Existing registration/survey narrowing
and unknown-property checks still run at the shared admission boundary.

The independent agent trials underway when this defect was found remain on
their frozen revision. No evaluated app received an expert correction, and this
controlled fix does not retroactively pass any failed agent result.
