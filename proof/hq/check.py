"""One check's HQ: its unit and the seams every path runs under, together.

``hq_check(configuration)`` opens a ``proof.hq.state`` unit for
the configuration, its root key the configuration's digest, with the seams
(``proof.hq.seams.check_seams``), and yields the unit and the seams' record.
The unit holds what a check's state held (``configuration``, ``domain``,
``couch``, ``blob_db``, ``web_user``, ``changes``, ``database``), and its
``request`` and ``fork`` serve the editors. The test that opens it owns both,
and both are closed when it exits, in reverse order, whether the check passed
or failed.
"""

from proof.hq.state import hq_check

__all__ = ["hq_check"]
