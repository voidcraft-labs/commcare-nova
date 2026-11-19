"""The named changes of ``proof/matrix/variants.json``: one module a manifest area, each public function a change.

A row ``{"op": "named", "name": <function>}`` names one function of these
modules, which is handed the ``Authoring`` (``proof.matrix.author``) and the
app's id and makes the change through HQ's own code (``proof.matrix.ops``).
``proof.matrix.registry.load_variants`` refuses a row naming a function no
module defines and a function no row names. A module is named for its area
with ``-`` as ``_``: ``application_and_settings``, ``case_search``,
``expressions_and_data``, ``forms_and_case_writes``, ``menus_and_case_lists``,
``questions``.
"""
