"""Defect 15: Nova's deep link ID rule is HQ's own rule for a session endpoint id.

Contract: a deep link ID Nova admits (``lib/domain/entryPoints.ts::
entryPointIdProblem`` answers nothing) is exactly one HQ saves as written.
HQ answers a save of a form's or a menu's session endpoint 400 unless the id
equals Django's ``slugify`` of itself (``views/utils.py::
get_cleaned_session_endpoint_id``, reached from ``set_session_endpoint`` and
``set_case_list_session_endpoint``). Every id of one to seven characters
drawn from ``a``, ``9``, ``_`` and ``-`` (a letter, a digit, and the two marks
``slugify`` treats differently) is given to Nova's function
(``proof/hq/entryPointIdVerdicts.ts``) and to HQ's, and the two agree on
each. No Nova test transcribes ``slugify``: this is where the pattern is held
to HQ.

The plausible failures: a pattern that admits an id HQ cleans (an edge
underscore, a doubled hyphen), so every settings save of its form fails in
HQ; and one that refuses an id HQ keeps, so Nova renames a deep link that
needed no rename.

Nova's verdicts are Nova's TypeScript, so they are produced where Nova's
``node_modules`` are (``proof.native.produce``): read from the products the
lane's corpus carries, or produced here when it carries none.
"""

import json

import pytest

from proof.hq.conftest import timed
from proof.native import produce

# How many ids the verdicts hold: every string of one to seven characters over four.
DRAWN = sum(4**length for length in range(1, 8))


@pytest.fixture(scope="module")
def verdicts(tmp_path_factory):
    """Nova's verdict on each drawn id: ``{id: problem or None}``."""
    root = tmp_path_factory.mktemp(produce.ENTRY_POINT_IDS)
    log = root / "verdicts.log"
    products = produce.produced_directory()
    with timed("entry_point_id_verdicts"):
        if products is not None:
            failure = produce.read_product(products, produce.ENTRY_POINT_IDS, root, log)
        else:
            _, failure = produce.produce_entry_point_ids(root, log)
    output = log.read_text(errors="replace")[-4000:] if log.is_file() else ""
    assert failure is None, f"Nova's entry-point id verdicts {failure}. Their output ({log}) ends:\n{output}"
    found = dict(json.loads((root / "verdicts.json").read_text()))
    assert len(found) == DRAWN, len(found)
    return found


def _hq_saves(endpoint_id) -> bool:
    """Whether HQ saves ``endpoint_id`` as written: its own cleaner returns it unchanged, where it raises for any
    id it would change."""
    from corehq.apps.app_manager.exceptions import AppMisconfigurationError
    from corehq.apps.app_manager.views.utils import get_cleaned_session_endpoint_id

    try:
        return get_cleaned_session_endpoint_id(endpoint_id) == endpoint_id
    except AppMisconfigurationError:
        return False


def test_nova_admits_exactly_the_deep_link_ids_hq_saves_as_written(hq, verdicts):
    disagreements = [
        (endpoint_id, problem)
        for endpoint_id, problem in verdicts.items()
        if (problem is None) != _hq_saves(endpoint_id)
    ]
    assert disagreements == [], disagreements[:20]
    # Both sides of the rule are drawn: ids HQ keeps, and ids it refuses for each of Nova's reasons.
    assert {problem for problem in verdicts.values()} == {None, "edge", "doubled-hyphen"}
    assert verdicts["a_-9"] is None and verdicts["a--9"] == "doubled-hyphen" and verdicts["a_"] == "edge"
