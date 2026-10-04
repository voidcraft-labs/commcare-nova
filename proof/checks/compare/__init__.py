"""Structural comparators: every difference between two parsed artifacts, never the first.

- ``json_tree``: JSON values, by JSON Pointer.
- ``xml_tree``: XML documents parsed by lxml, attributes as a map, children
  paired by identity or position, each element named as its document's
  readers name it (``names``).
- ``names``: which element names in an XForm's data, a submission and Core's
  case database are the app's (``*`` in a path, a run of them one ``*``) and
  which a reader's; the same naming writes where HQ finds a case block.
- ``app_strings``: app strings files as the maps HQ's reader makes of them,
  each key at its HQ key family (``app_strings_families.json``, HQ's registry
  at the pin).
- ``app_json``: where the app JSON's keys are the app's data, HQ's translated
  fields by HQ's schema among them.
- ``trace``: Core runner traces as JSON, the XML documents they carry as XML,
  a search's own query keys apart from its prompts', each generated id named
  by the first place both runs hold it, and Core's refusal of a submission
  by its cause.
- ``build_files``: every file ``create_all_files()`` writes, each by its
  comparator, refusing a file none reads.
- ``versions``: proof 2's clause on which version numbers two builds may
  differ in.
- ``spelling``: the spelling rules a comparison is given, applied. The
  comparators read the rules their caller hands them, never the registry
  (``proof.rules``), so the observation compares raw builds without it.
"""
