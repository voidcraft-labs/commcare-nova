"""Only regroup interleaved destinations of the same Android result name."""

import pytest
from lxml import etree

from proof.rules import normalized
from proof.rules.android_intent_response_groups import RULE


def _form(rows, *, intent_attributes='id="meter" class="org.example.MEASURE"'):
    return etree.fromstring(f'''<h:html xmlns:h="http://www.w3.org/1999/xhtml"
        xmlns="http://www.w3.org/2002/xforms" xmlns:o="http://opendatakit.org/xforms">
        <h:head><o:intent {intent_attributes}>{rows}</o:intent></h:head>
        <h:body/>
    </h:html>'''.encode())


def _compare(rows, *, intent_attributes='id="meter" class="org.example.MEASURE"'):
    root = _form(rows, intent_attributes=intent_attributes)
    return etree.tostring(normalized("form:0.0", root, rules=(RULE,)))


_FIRST = '<response key="Aa" ref="/data/one"/>'
_OTHER = '<response key="BB" ref="/data/one"/>'  # Same Java String hash as Aa.
_LAST = '<response key="Aa" ref="/data/two"/>'


def test_vellum_grouping_keeps_key_insertion_and_destination_order():
    assert _compare(_FIRST + _OTHER + _LAST) == _compare(_FIRST + _LAST + _OTHER)


@pytest.mark.parametrize("modified", [
    _OTHER + _FIRST + _LAST,  # A different first insertion order can change which colliding key writes last.
    _LAST + _FIRST + _OTHER,
    _FIRST + _OTHER + _LAST.replace('/data/two', '/data/one'),
    _FIRST + _OTHER + _LAST.replace('key="Aa"', 'key="BB"'),
    _FIRST + _OTHER,
])
def test_unrelated_intent_response_changes_remain_visible(modified):
    assert _compare(_FIRST + _OTHER + _LAST) != _compare(modified)


def test_unowned_payloads_and_relative_positions_of_extras_are_not_reordered():
    quick = 'id="meter" class="org.example.MEASURE" appearance="quick"'
    assert _compare(_FIRST + _OTHER + _LAST, intent_attributes=quick) != _compare(
        _FIRST + _LAST + _OTHER, intent_attributes=quick,
    )
    extra = '<extra key="sent" ref="/data/value"/>'
    assert _compare(_FIRST + _OTHER + extra + _LAST) != _compare(_FIRST + _LAST + _OTHER + extra)
