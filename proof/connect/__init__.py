"""The Connect proof: CommCare Connect's own server over what HQ forwards of a Nova app's submissions.

Connect is the last reader of a Connect app's forms. A worker submits a form
to HQ; HQ's Connect repeater forwards the form's metadata and its Connect
blocks (``corehq/motech/repeaters/repeater_generators.py::
ConnectFormRepeaterPayloadGenerator``); Connect's receiver
(``commcare_connect/form_receiver``) turns them into completed learn modules,
visits, completed work and completed tasks, against the learn modules,
deliver units and task types it read from the app's build when the
opportunity was made (``opportunity/tasks.py::
sync_learn_modules_and_deliver_units``).

Every one of those runs with its own code, at the pins ``proof/pins.json``
names:

- ``proof.connect.hq`` (HQ's process): the project space's Connect repeater,
  a device's post to HQ's own receiver view, and what HQ keeps of each
  forward its own repeater sent;
- ``proof.connect.runtime``: Connect's services (its Postgres with PostGIS
  and its Redis, as its ``docker-compose.yml`` runs them), Connect's
  database as its own migrations leave it, and Connect itself, as one
  scenario's process or served for as long as an opportunity is observed;
- ``proof.connect.driver`` (Connect's process, on Connect's interpreter and
  virtualenv): Connect's sync of an app's build, its receiver over each
  payload, through its own URLconf, authentication and request transaction,
  and its queued tasks, run by Celery's own task machinery;
- ``proof.connect.checkout``: Connect's source, fetched at its pin when the
  proof runs (the image holds Connect's virtualenv and none of its source).

A Connect document's unit uses all of it for every state it serves
(``proof.observe.connect``); the package's own tests run the scenarios the
unit does not (``test_receiver.py``) and hold the chain itself
(``test_forwarding.py``, ``test_runtime.py``).
"""
