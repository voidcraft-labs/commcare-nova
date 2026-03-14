# Gold-Standard Form Design Examples

These examples show what excellent CommCare form design looks like — not just technically valid forms, but thoughtful workflows designed for real field workers. Study the reasoning behind each design decision.

---

## Example 1: Client Registration (registration, case_type: client)

Design rationale: A field worker registers a new client during a home visit. They're on a phone, often outdoors, possibly low connectivity. Speed and simplicity matter most. Every question should earn its place.

```
GROUP: "demographics" (label: "Client Information")
  - full_name (text, required, case_name)
    Why text not split first/last: field workers in many contexts use single names,
    patronymics, or name structures that don't fit first/last. One field is universal.
  - date_of_birth (date, required)
    Why date not age: dates are verifiable from health cards, self-reported ages are
    often wrong by 1-2 years. More useful for age-based eligibility calculations downstream.
  - age_years (hidden, calculate: int((today() - #form/date_of_birth) div 365.25))
    Calculated, never asked. Stored as case property for case list display and reporting.
  - sex (select: male/female, required)
    Only two options — use a select, not a radio group. Renders faster on mobile.

GROUP: "contact" (label: "Contact Details")
  - phone_number (phone, required)
    Phone type triggers the phone keyboard on mobile — never use text for phone numbers.
  - village (text)
    Free text, not a dropdown, because village lists change frequently and
    maintaining a lookup table creates an admin burden.

GROUP: "enrollment" (label: "Enrollment")
  - enrollment_date (date, default: today(), required)
    Defaults to today because 95% of registrations happen same-day.
    Worker can change it for backlog data entry.
  - referred_by (select: self/community_health_worker/clinic/other)
    Captures referral source for program reporting.

Total: 8 questions. A field worker can complete this in under 2 minutes.
```

Why this design is good:
- Calculated age from DOB instead of asking both (reduces errors, one source of truth)
- Phone type for phone numbers (mobile keyboard optimization)
- Default today() on enrollment date (reduces taps for the common case)
- Groups create visual sections but aren't deeply nested
- Under 10 questions — respects the field worker's time

---

## Example 2: Client Registration + Edit Followup Pair (same module)

Design rationale: Registration creates the case. The edit/followup form lets workers update information. These two forms must be coordinated — same field order, same grouping, but the followup preloads existing values.

Registration form: (as above)

Edit form (followup, same case_type):
```
GROUP: "demographics" (label: "Client Information")
  - full_name (text, required, case_property: full_name, case_name)
    Preloaded from case. Worker sees current value, can edit.
  - date_of_birth (date, required, case_property: date_of_birth)
    Preloaded. Same position as registration form.
  - age_years (hidden, calculate: same as registration)
  - sex (select: male/female, required, case_property: sex)

GROUP: "contact" (label: "Contact Details")
  - phone_number (phone, required, case_property: phone_number)
  - village (text, case_property: village)

GROUP: "enrollment" (label: "Enrollment")
  - enrollment_info (trigger, label: "Enrolled: <output value="#case/enrollment_date"/> | Referred by: <output value="#case/referred_by"/>")
    Display-only context — uses a trigger with output references to show
    historical facts that shouldn't change after registration.
```

Key coordination rules:
- Same question order as registration
- Same groups with same labels
- Same question IDs where possible (so case property mapping is identical)
- Fields that shouldn't change after registration use trigger questions with <output value="#case/..."/> for display-only context
- Editable fields preload from the case (this happens automatically via formType: followup + case_property mapping)

---

## Example 3: Referral Placement (followup, case_type: referral)

Design rationale: A case manager opens a referral from the case list. They see the client name and waitlisted facility in the columns. The form should acknowledge this context — not re-ask for information the worker already sees — and guide them through one of three possible actions.

```
GROUP: "context" (label: "Referral Details")
  - referral_info (trigger, label: "Client: <output value="#case/client_name"/> | Facility: <output value="#case/waitlisted_facility"/> | Date: <output value="#case/referral_date"/>")
    Display-only context using trigger with output references. Confirms the worker opened the right record without creating editable inputs.
  - service_type (hidden, case_property: service_type)
    Hidden — needed for filtering facilities below but not shown to the worker.

GROUP: "action" (label: "Placement Action")
  - placement_action (select: place_at_waitlisted/place_at_other/unable_to_place, required)
    Single question drives the entire rest of the form.
    This is the core UX pattern: one decision point, then conditional detail.

GROUP: "placement_other" (label: "Alternative Facility", relevant: #form/placement_action = 'place_at_other')
  - facility (select, itemset from facility case type, filtered by service_type matching #form/service_type)
    Lookup table / case list filtered select. Only shows facilities that provide
    the service type this referral needs.
  - placement_reason (text)
    Why not the waitlisted facility? Useful for program learning.

GROUP: "barriers" (label: "Barriers to Placement", relevant: #form/placement_action = 'unable_to_place')
  - barrier_type (select: no_beds/client_refused/transport_issue/documentation_missing/other, required)
  - barrier_notes (text, relevant: #form/barrier_type = 'other')
    Only shown for "other" — structured options cover most cases.
  - reschedule_date (date, constraint: . > today())
    When to try again. Must be in the future.

GROUP: "completion" (label: "Completion")
  - placement_date (date, default: today(), relevant: #form/placement_action != 'unable_to_place')
    Only asked when placement actually happened.
  - follow_up_needed (select: yes/no, required)
  - follow_up_date (date, relevant: #form/follow_up_needed = 'yes', constraint: . > today())
  - notes (text)
    Open field for anything not captured above.

CLOSE CASE: conditional on placement_action != 'unable_to_place'
  Successfully placed referrals close the case. Failed placements stay open for follow-up.

CHILD CASE: none (the placement updates the referral case, doesn't create new cases)
```

Why this design is good:
- Context group with trigger/output references confirms the record without re-asking
- One decision point (placement_action) drives all conditional logic
- Each action path has its own group — the form reshapes itself based on the worker's intent
- Barriers are structured (select) with an escape hatch (other + notes)
- Close case is conditional — only closes on successful placement
- 13 questions total but the worker only sees 7-9 depending on their path

---

## Example 4: Household Survey with Repeat Group (registration, case_type: household)

Design rationale: An enumerator visits a household and registers it along with all household members. The household is one case; each member becomes a child case. The form uses a repeat group for members.

```
GROUP: "household_info" (label: "Household Information")
  - household_head_name (text, required, case_name)
  - address (text, required)
  - gps_location (geopoint)
    Captured once at the household level, not per member.
  - dwelling_type (select: permanent/semi_permanent/temporary, required)
  - water_source (select: piped/borehole/well/river/rainwater/other)
  - has_electricity (select: yes/no)
  - num_rooms (integer, constraint: . > 0 and . <= 20)

REPEAT GROUP: "household_members" (label: "Household Members")
  This creates a child case of type "household_member" for each iteration.

  - member_name (text, required, child case_name for household_member)
  - relationship_to_head (select: head/spouse/child/parent/sibling/other, required)
  - member_dob (date, required)
  - member_age (hidden, calculate from member_dob)
  - member_sex (select: male/female, required)
  - currently_enrolled_in_school (select: yes/no/not_applicable,
    relevant: #form/household_members/member_age >= 5 and #form/household_members/member_age <= 18)
    Only asked for school-age members. Not applicable hidden via skip logic.
  - has_chronic_illness (select: yes/no)
  - chronic_illness_type (multi-select: diabetes/hypertension/hiv/tb/asthma/other,
    relevant: #form/household_members/has_chronic_illness = 'yes')

GROUP: "summary" (label: "Summary")
  - total_members (hidden, calculate: count of repeat group iterations)
    Auto-counted, stored for case list display and reporting.
  - notes (text)

CHILD CASE: household_member (created from repeat group)
  Maps member_name, relationship_to_head, member_dob, member_age, member_sex,
  currently_enrolled_in_school, has_chronic_illness, chronic_illness_type
```

Why this design is good:
- Household data captured once, member data repeats per person
- Skip logic within the repeat: school enrollment only for ages 5-18
- Conditional chronic illness detail only when has_chronic_illness = yes
- Auto-calculated total_members for reporting
- Geopoint at household level, not member level (one GPS reading per visit)
- Child case creation from repeat group — each member becomes a trackable case