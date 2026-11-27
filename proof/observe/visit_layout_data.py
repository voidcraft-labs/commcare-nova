"""Two visits with distinguishable values for the Details and persistent context reader journeys."""

from proof.observe.casedata import CaseDatabase, CaseRecord, USER_ID, USERNAME


def visits():
    moment = "2026-01-01T00:00:00.000000Z"

    def visit(case_id, name, village, previous):
        return CaseRecord(
            case_id=case_id,
            case_type="visit",
            name=name,
            owner_id=USER_ID,
            opened_on=moment,
            modified_on=moment,
            external_id=None,
            properties=(("village", village), ("last_visit", previous), ("rank", name))
            + tuple((f"visit_part_{i}", f"{name} {i}") for i in range(1, 8)),
        )

    return CaseDatabase(USER_ID, USERNAME, (), (visit("west", "Amina", "West", "Monday"),
                                                visit("east", "Baraka", "East", "Tuesday")))
