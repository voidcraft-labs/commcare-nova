"""Connect's side of the Connect proof: one scenario run over Connect's own code, in Connect's own process.

This file is run by Connect's interpreter (Connect's virtualenv on Python
3.11, ``proof/connect/runtime.py``), never imported by the harness, so it
imports only the standard library, Django and Connect at its pin. It boots
Connect with Connect's own test settings (``config.settings.test``) over the
scenario's own database, a clone of the one Connect's migrations made, and
Connect's Redis, then runs the scenario's steps in order and writes what each
left.

A scenario is the life of one opportunity. Everything that reads an app or a
form is Connect's own code:

- ``sync`` runs ``opportunity/tasks.py::sync_learn_modules_and_deliver_units``
  (the task Connect runs when an opportunity is created and whenever a manager
  asks for its app's units again), which downloads each app's CCZ from HQ and
  reads its Connect blocks with ``opportunity/app_xml.py``, and
  ``app_xml.py::get_task_units_for_app``, whose task units become task types
  as Connect's manager pages make them. The one thing answered for it is the
  download itself (``httpx.get`` to HQ's ``download_ccz``), with the archive
  HQ built for that app; any other request it makes is refused.
- ``post`` sends one payload to Connect's form receiver through Connect's own
  URLconf, middleware, OAuth authentication and request transaction
  (``/api/receiver/``, ``form_receiver/views.py::FormReceiver``), as HQ's
  repeater posts it with its OAuth application's token, and records the
  response and every row the processor wrote.

What a person does in Connect's pages is written through Connect's models:
the opportunity with its apps, HQ server and worker (made with the factories
Connect's own tests use, so each row is one Connect accepts at the pin), a
payment unit holding deliver units, the worker's claim with its limits
(``OpportunityClaimLimit.create_claim_limits``, as claiming makes them), the
verification flags, and a task assigned to the worker.

Usage: ``python driver.py <connect checkout> <scenario.json> <result.json>``
"""

import json
import os
import sys
import traceback
from datetime import date, timedelta
from pathlib import Path

# The seeded dates: an opportunity that started long before any clock the lane uses and ends long after, so no
# outcome depends on the day the lane runs.
STARTED = date(2020, 1, 1)
ENDS = date(2099, 12, 31)
RECEIVER_PATH = "/api/receiver/"
TOKEN = "proof-connect-receiver-token"


def boot(checkout):
    sys.path.insert(0, str(checkout))
    os.chdir(checkout)
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.test"
    import django
    from django.test.utils import setup_test_environment

    django.setup()
    # What Connect's own tests run under (pytest-django sets it up): the test client's host is allowed, and mail
    # stays in memory.
    setup_test_environment()


class Scenario:
    def __init__(self, spec):
        self.spec = spec
        self.opportunity = None
        self.user = None
        self.access = None
        self.oauth_application = None

    # Steps ---------------------------------------------------------------------------------------------------

    def opportunity_step(self, step):
        """An active opportunity over a learn app and a deliver app on one HQ server, and its worker.

        The worker is linked to the HQ username the submissions carry
        (``form_receiver/processor.py::get_user`` finds the worker by it), and
        has accepted the opportunity; ``claim`` makes the claim.
        """
        from commcare_connect.commcarehq.tests.factories import HQServerFactory
        from commcare_connect.opportunity.models import Opportunity, OpportunityVerificationFlags
        from commcare_connect.opportunity.tests.factories import (
            CommCareAppFactory,
            HQApiKeyFactory,
            OpportunityAccessFactory,
            OpportunityFactory,
        )
        from commcare_connect.users.tests.factories import (
            ConnectIdUserLinkFactory,
            MobileUserFactory,
            OrgWithUsersFactory,
            UserFactory,
        )
        from django.utils.timezone import now
        from oauth2_provider.models import AccessToken

        organization = OrgWithUsersFactory()
        hq_server = HQServerFactory(url=step["hqUrl"])
        apps = {
            role: CommCareAppFactory(
                organization=organization,
                hq_server=hq_server,
                cc_domain=step["domain"],
                cc_app_id=step[f"{role}App"],
                name=f"{role} app",
                passing_score=step.get("passingScore", 50),
            )
            for role in ("learn", "deliver")
        }
        options = {name: step[name] for name in ("auto_approve_visits", "automatic_visit_verification") if name in step}
        self.opportunity = OpportunityFactory(
            organization=organization,
            hq_server=hq_server,
            api_key=HQApiKeyFactory(hq_server=hq_server),
            learn_app=apps["learn"],
            deliver_app=apps["deliver"],
            name="Proof opportunity",
            active=True,
            is_test=False,
            start_date=STARTED,
            end_date=ENDS,
            total_budget=1_000_000,
            **options,
        )
        OpportunityVerificationFlags.objects.get_or_create(opportunity=self.opportunity)
        self.user = MobileUserFactory(username="proof-worker", name="Proof Worker")
        ConnectIdUserLinkFactory(
            user=self.user, commcare_username=step["commcareUsername"], hq_server=hq_server, domain=step["domain"]
        )
        self.access = OpportunityAccessFactory(user=self.user, opportunity=self.opportunity, accepted=True)
        self.oauth_application = hq_server.oauth_application
        AccessToken.objects.create(
            user=UserFactory(email="hq-repeater@example.com"),
            token=TOKEN,
            scope="read write",
            expires=now() + timedelta(days=1),
            application=self.oauth_application,
        )
        assert Opportunity.objects.count() == 1
        return {}

    def sync_step(self, step):
        """Connect's own reading of the opportunity's apps: its sync of learn modules and deliver units, and the
        deliver app's task units made task types. ``step["ccz"]`` names the archive HQ built for each app id."""
        import httpx
        from commcare_connect.opportunity import app_xml
        from commcare_connect.opportunity.models import TaskType
        from commcare_connect.opportunity.tasks import sync_learn_modules_and_deliver_units
        from django.core.cache import cache

        archives = {app_id: Path(path).read_bytes() for app_id, path in step["ccz"].items()}
        asked = []
        real_get = httpx.get

        def hq_download(url, params=None, **kwargs):
            app = next(
                (
                    app
                    for app in (self.opportunity.learn_app, self.opportunity.deliver_app)
                    if url == f"{app.hq_server.url}/a/{app.cc_domain}/apps/api/download_ccz/"
                    and (params or {}).get("app_id") == app.cc_app_id
                ),
                None,
            )
            if app is None:
                raise AssertionError(
                    f"Connect's sync asked HQ for {url} with {params}, which is not the CCZ download of either of the"
                    " opportunity's apps. The proof answers only that download, with the archive HQ built; look at"
                    " what commcare_connect/opportunity/app_xml.py::get_form_xml_for_app asks for at the pin."
                )
            asked.append({"app": app.cc_app_id, "latest": (params or {}).get("latest")})
            request = httpx.Request("GET", url, params=params)
            if app.cc_app_id not in archives:
                return httpx.Response(404, request=request)
            return httpx.Response(200, content=archives[app.cc_app_id], request=request)

        httpx.get = hq_download
        try:
            # The task units are cached by app id for an hour; a scenario's later sync reads the app as it is then.
            cache.delete(f"task_units_{self.opportunity.deliver_app.cc_app_id}")
            sync_learn_modules_and_deliver_units(self.opportunity)
            task_units = app_xml.get_task_units_for_app(self.opportunity.deliver_app)
        finally:
            httpx.get = real_get
        for unit in task_units:
            TaskType.objects.get_or_create(
                app=self.opportunity.deliver_app,
                slug=unit.id,
                defaults={"name": unit.name, "description": unit.description or ""},
            )
        return {"asked": asked}

    def pay_step(self, step):
        """A payment unit a manager makes (or the one of that name, edited), holding the named deliver units too."""
        from commcare_connect.opportunity.models import DeliverUnit, PaymentUnit
        from commcare_connect.opportunity.tests.factories import PaymentUnitFactory

        unit = PaymentUnit.objects.filter(opportunity=self.opportunity, name=step["name"]).first()
        if unit is None:
            unit = PaymentUnitFactory(
                opportunity=self.opportunity,
                name=step["name"],
                amount=10,
                org_amount=0,
                max_daily=step.get("maxDaily", 50),
                max_total=step.get("maxTotal", 100),
            )
        held = DeliverUnit.objects.filter(app=self.opportunity.deliver_app, slug__in=step["deliverUnits"])
        missing = sorted(set(step["deliverUnits"]) - set(held.values_list("slug", flat=True)))
        if missing:
            raise AssertionError(
                f"The scenario pays for the deliver units {missing}, which Connect's sync did not read from the deliver"
                " app. Name units the app's forms hold, and run the sync first."
            )
        held.update(payment_unit=unit)
        return {}

    def claim_step(self, step):
        """The worker's claim, with the limits claiming gives it for the payment units that exist then."""
        from commcare_connect.opportunity.models import OpportunityClaim, OpportunityClaimLimit

        claim, _ = OpportunityClaim.objects.get_or_create(opportunity_access=self.access, defaults={"end_date": ENDS})
        OpportunityClaimLimit.create_claim_limits(self.opportunity, claim)
        return {}

    def flags_step(self, step):
        """The opportunity's verification flags, as its manager sets them."""
        from commcare_connect.opportunity.models import OpportunityVerificationFlags

        flags = OpportunityVerificationFlags.objects.get(opportunity=self.opportunity)
        for name in ("gps", "location", "duplicate"):
            if name in step:
                setattr(flags, name, step[name])
        flags.save()
        return {}

    def assign_task_step(self, step):
        """A task of the named type assigned to the worker."""
        from commcare_connect.opportunity.models import TaskType
        from commcare_connect.opportunity.tests.factories import AssignedTaskFactory

        task_type = TaskType.objects.get(app=self.opportunity.deliver_app, slug=step["slug"])
        AssignedTaskFactory(task_type=task_type, opportunity_access=self.access, completed_at=None, duration=None)
        return {}

    def post_step(self, step):
        """One payload posted to Connect's receiver as HQ's repeater posts it: the response HQ's repeater gets,
        and, where a view raised, what it raised (Connect answers 500 and HQ retries the record later)."""
        from django.core.signals import got_request_exception
        from django.test import Client

        raised = []

        def note(sender, **kwargs):
            error = sys.exc_info()[1]
            traceback.print_exc()
            raised.append({"class": type(error).__name__, "message": str(error)})

        got_request_exception.connect(note)
        try:
            response = Client(raise_request_exception=False).post(
                RECEIVER_PATH,
                data=json.dumps(step["payload"]),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {TOKEN}",
            )
        finally:
            got_request_exception.disconnect(note)
        body = None
        if response.get("Content-Type", "").startswith("application/json") and response.content:
            body = json.loads(response.content)
        return {"status": response.status_code, "body": body, "raised": raised}

    # What Connect holds --------------------------------------------------------------------------------------

    def state(self):
        """Every row the receiver reads or writes for the opportunity, by the names the app and HQ gave them."""
        from commcare_connect.opportunity.models import (
            Assessment,
            AssignedTask,
            CompletedModule,
            CompletedWork,
            DeliverUnit,
            LearnModule,
            OpportunityAccess,
            TaskType,
            UserVisit,
        )

        if self.opportunity is None:
            return None
        learn_app, deliver_app = self.opportunity.learn_app, self.opportunity.deliver_app
        access = OpportunityAccess.objects.get(pk=self.access.pk)
        return {
            "learnModules": [
                {"slug": m.slug, "name": m.name, "description": m.description, "time_estimate": m.time_estimate}
                for m in LearnModule.objects.filter(app=learn_app).order_by("slug")
            ],
            "deliverUnits": [
                {"slug": u.slug, "name": u.name, "paymentUnit": u.payment_unit.name if u.payment_unit else None}
                for u in DeliverUnit.objects.filter(app=deliver_app).order_by("slug")
            ],
            "taskTypes": [
                {"slug": t.slug, "name": t.name, "description": t.description}
                for t in TaskType.objects.filter(app=deliver_app).order_by("slug")
            ],
            "access": {
                "learnProgress": access.learn_progress,
                "completedLearnDate": _instant(access.completed_learn_date),
                "lastActive": _instant(access.last_active),
                "paymentAccrued": access.payment_accrued,
            },
            "completedModules": [
                {
                    "module": c.module.slug,
                    "xform": c.xform_id,
                    "date": _instant(c.date),
                    "seconds": c.duration.total_seconds(),
                    "appBuildId": c.app_build_id,
                    "appBuildVersion": c.app_build_version,
                }
                for c in CompletedModule.objects.filter(opportunity=self.opportunity).order_by(
                    "xform_id", "module__slug"
                )
            ],
            "assessments": [
                {"xform": a.xform_id, "score": a.score, "passingScore": a.passing_score, "passed": a.passed}
                for a in Assessment.objects.filter(opportunity=self.opportunity).order_by("xform_id")
            ],
            "visits": [
                {
                    "xform": v.xform_id,
                    "deliverUnit": v.deliver_unit.slug,
                    "entityId": v.entity_id,
                    "entityName": v.entity_name,
                    "visitDate": _instant(v.visit_date),
                    "status": v.status,
                    "reviewStatus": v.review_status,
                    "flagged": v.flagged,
                    "flags": (v.flag_reason or {}).get("flags"),
                    "location": v.location,
                    "overLimitReasons": list(v.over_limit_reasons),
                    "workArea": str(v.work_area.case_id) if v.work_area else None,
                    "completedWork": v.completed_work.status if v.completed_work else None,
                    "appBuildId": v.app_build_id,
                    "appBuildVersion": v.app_build_version,
                    "formJsonKeys": sorted(v.form_json),
                }
                for v in UserVisit.objects.filter(opportunity=self.opportunity).order_by(
                    "xform_id", "deliver_unit__slug"
                )
            ],
            "completedWorks": [
                {
                    "entityId": w.entity_id,
                    "paymentUnit": w.payment_unit.name,
                    "status": w.status,
                    "savedCompletedCount": w.saved_completed_count,
                    "savedApprovedCount": w.saved_approved_count,
                    "savedPaymentAccrued": w.saved_payment_accrued,
                }
                for w in CompletedWork.objects.filter(opportunity_access=access).order_by(
                    "entity_id", "payment_unit__name"
                )
            ],
            "assignedTasks": [
                {"slug": t.task_type.slug, "status": t.status, "xform": t.xform_id}
                for t in AssignedTask.objects.filter(opportunity_access=access).order_by("task_type__slug", "pk")
            ],
            "queued": queued_tasks(),
        }


def _instant(value):
    return value.isoformat() if value is not None else None


def queued_tasks():
    """The names of the tasks Connect has sent its Celery broker and no worker has taken, in order."""
    import redis
    from django.conf import settings

    client = redis.Redis.from_url(settings.CELERY_BROKER_URL)
    try:
        return [json.loads(message)["headers"]["task"] for message in reversed(client.lrange("celery", 0, -1))]
    finally:
        client.close()


def run(spec):
    scenario = Scenario(spec)
    results = []
    for step in spec["steps"]:
        handler = getattr(scenario, f"{step['do']}_step", None)
        if handler is None:
            raise AssertionError(
                f"The Connect driver has no step named {step['do']!r}; proof/connect/driver.py lists them."
            )
        outcome = handler(step)
        outcome["do"] = step["do"]
        if "name" in step:
            outcome["name"] = step["name"]
        outcome["state"] = scenario.state()
        results.append(outcome)
    return results


def main(argv):
    checkout, scenario_path, result_path = Path(argv[1]), Path(argv[2]), Path(argv[3])
    try:
        boot(checkout)
        result = {"steps": run(json.loads(scenario_path.read_text()))}
    except BaseException:
        result = {"failed": traceback.format_exc()}
    result_path.write_text(json.dumps(result, indent=1, sort_keys=True))
    return 1 if "failed" in result else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
