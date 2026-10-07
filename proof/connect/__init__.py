"""The Connect proof: CommCare Connect's own form receiver over what HQ forwards of a Nova app's submissions.

Connect is the last reader of a Connect app's forms. A worker submits a form
to HQ; HQ's Connect repeater forwards the form's metadata and its Connect
blocks (``corehq/motech/repeaters/repeater_generators.py::
ConnectFormRepeaterPayloadGenerator``); Connect's receiver
(``commcare_connect/form_receiver``) turns them into completed learn modules,
visits, completed work and completed tasks, against the learn modules,
deliver units and task types it read from the app's build when the
opportunity was made (``opportunity/tasks.py::
sync_learn_modules_and_deliver_units``).

The proof runs every one of those with its own code, at the pins
``proof/pins.json`` names:

- ``proof.connect.hq`` (HQ's process): HQ's reading of a submission as its
  receiver reads it, and HQ's own payload generator over the form;
- ``proof.connect.runtime``: Connect's services (its Postgres with PostGIS
  and its Redis, as its ``docker-compose.yml`` runs them) and Connect's
  database as its own migrations leave it, each scenario in a clone;
- ``proof.connect.driver`` (Connect's process, on Connect's interpreter and
  virtualenv): Connect's sync of an app's build, and its receiver over each
  payload, through its own URLconf, authentication and request transaction;
- ``proof.connect.checkout``: Connect's source, fetched at its pin when the
  proof runs (the image holds Connect's virtualenv and none of its source).
"""
