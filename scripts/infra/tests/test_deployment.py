"""Offline failure-path tests for deployment, infrastructure, and cache handling."""
import argparse
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cache = load("nova_build_cache", "scripts/rollout/build-cache.py")
infra = load("nova_deployment_infra", "scripts/infra/manage-deployment.py")
deploy = load("nova_deploy", "scripts/rollout/deploy-cloud-run.py")
gate = load("nova_migration_gate", "scripts/rollout/migration-gate.py")
image_metadata = load("nova_image_metadata", "scripts/rollout/image-metadata.py")
IMAGE = "us-central1-docker.pkg.dev/commcare-nova/repo/app@sha256:" + "a" * 64
JOB = "projects/commcare-nova/locations/us-central1/jobs/commcare-nova-migrate"


def job_fixture():
    c = deploy.JOB_TEMPLATE_CONTRACTS["commcare-nova-migrate"]
    return {"name": JOB, "generation": "3", "observedGeneration": "3", "reconciling": False,
        "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "etag": "generation-3",
        "template": {"taskCount": 1, "parallelism": 1, "template": {
            "containers": [{"image": IMAGE, "command": ["node"], "args": ["migrate.cjs"],
                "env": [{"name": k, "value": v} for k, v in c.environment],
                "resources": {"limits": {"cpu": c.cpu, "memory": c.memory}}}],
            "serviceAccount": c.service_account, "maxRetries": 0, "timeout": "3000s",
            "vpcAccess": {"egress": "PRIVATE_RANGES_ONLY", "networkInterfaces": [{"network": "default", "subnetwork": "default"}]}}}}


class BuildCacheTests(unittest.TestCase):
    def arguments(self, root):
        return argparse.Namespace(root=ROOT, directory=root / "cache", environment=root / "cache.env",
            bucket="private-cache", repository="registry/cache/compiler", profile="benchmark", cold=False,
            build_id="00000000-0000-0000-0000-000000000001")

    def test_cache_key_reuses_source_changes_but_invalidates_dependencies_and_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in (".nvmrc", ".npmrc", "package-lock.json", "Dockerfile", "next.config.ts", "tsconfig.production.json", "scripts/build-app.mjs"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(name)
            initial = cache.cache_key(root)
            (root / "page.tsx").write_text("changed component")
            self.assertEqual(initial, cache.cache_key(root))
            self.assertNotEqual(initial, cache.cache_key(root, "benchmark"))
            (root / "package-lock.json").write_text("changed dependency")
            self.assertNotEqual(initial, cache.cache_key(root))

    def test_unavailable_cache_emits_cold_environment_and_removes_stale_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.arguments(Path(tmp))
            args.directory.mkdir()
            (args.directory / "next-image.json").write_text("stale")
            with patch.object(cache, "gcloud", side_effect=subprocess.CalledProcessError(1, "gcloud")), redirect_stdout(io.StringIO()):
                cache.restore(args)
            self.assertEqual(list((args.directory / "input").iterdir()), [])
            self.assertFalse((args.directory / "next-image.json").exists())
            self.assertNotIn("NOVA_DOCKER_CACHE_FROM", args.environment.read_text())
            self.assertIn("NOVA_NEXT_CACHE_TO", args.environment.read_text())

    def test_restore_reads_only_manifest_and_selects_an_immutable_registry_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.arguments(Path(tmp))
            manifest = {"buildId": args.build_id, "key": cache.cache_key(ROOT, args.profile), "nextDigest": "sha256:" + "a" * 64}
            with patch.object(cache, "gcloud", side_effect=["gs://private-cache/snapshot.json", json.dumps(manifest)]) as cloud, redirect_stdout(io.StringIO()):
                cache.restore(args)
            self.assertEqual([c.args[1] for c in cloud.call_args_list], ["ls", "cat"])
            self.assertIn("registry/cache/next@sha256:" + "a" * 64, args.environment.read_text())
            self.assertEqual(list((args.directory / "input").iterdir()), [])

    def test_invalid_snapshot_identity_falls_back_without_fetching_bytes(self):
        for mutation in ({"nextDigest": "https://foreign/bytes"}, {"key": "other-profile"}, {"buildId": "../other"}):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                args = self.arguments(Path(tmp))
                manifest = {"buildId": args.build_id, "key": cache.cache_key(ROOT, args.profile), "nextDigest": "sha256:" + "a" * 64, **mutation}
                with patch.object(cache, "gcloud", side_effect=["gs://private-cache/snapshot.json", json.dumps(manifest)]), redirect_stdout(io.StringIO()):
                    cache.restore(args)
                self.assertNotIn("NOVA_NEXT_CACHE_FROM", args.environment.read_text())

    def test_publication_is_one_small_create_only_completion_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.arguments(Path(tmp))
            args.directory.mkdir()
            (args.directory / "next-image.json").write_text(json.dumps({"containerimage.digest": "sha256:" + "a" * 64}))
            with patch.object(cache, "gcloud") as cloud, redirect_stdout(io.StringIO()):
                cache.publish(args)
            self.assertEqual(cloud.call_count, 1)
            self.assertIn("--if-generation-match=0", cloud.call_args.args)
            self.assertLess((args.directory / "manifest.json").stat().st_size, 512)
            (args.directory / "next-image.json").unlink()
            with patch.object(cache, "gcloud") as cloud, redirect_stdout(io.StringIO()):
                cache.publish(args)
            cloud.assert_not_called()


class InfrastructureTests(unittest.TestCase):
    def test_media_policy_handles_api_defaults_but_detects_each_retention_failure(self):
        current = copy.deepcopy(infra.MEDIA_POLICY)
        current["metageneration"] = "7"
        self.assertEqual(infra.media_findings(current), [])
        current["softDeletePolicy"]["retentionDurationSeconds"] = 0
        self.assertEqual(infra.media_findings(current), [])
        for mutation in (
            {"lifecycle": {"rule": []}}, {"cors": []},
            {"softDeletePolicy": {"retentionDurationSeconds": "604800"}},
            {"versioning": {"enabled": True}}, {"defaultEventBasedHold": True},
            {"retentionPolicy": {"retentionPeriod": "100"}},
        ):
            self.assertTrue(infra.media_findings({**current, **mutation}))

    def test_media_plan_never_writes_and_apply_uses_generation_fence(self):
        current = {**infra.MEDIA_POLICY, "cors": [], "metageneration": "7"}
        with patch.object(infra, "api", return_value=current) as api, redirect_stdout(io.StringIO()):
            infra.media(False)
            self.assertEqual([call.args[0] for call in api.call_args_list], ["GET"])
        with patch.object(infra, "api", side_effect=[current, {}, infra.MEDIA_POLICY]) as api, redirect_stdout(io.StringIO()):
            infra.media(True)
            self.assertEqual(api.call_args_list[1].args[0], "PATCH")
            self.assertIn("ifMetagenerationMatch=7", api.call_args_list[1].args[1])
        with patch.object(infra, "api", return_value={**current, "retentionPolicy": {}}) as api:
            with self.assertRaises(ValueError):
                infra.media(True)
            self.assertEqual(api.call_count, 1)

    def test_scheduler_drift_check_never_mutates(self):
        with patch.object(infra, "scheduler_facts", return_value={"state": "PAUSED"}), patch.object(infra, "command") as command:
            with self.assertRaises(ValueError):
                infra.scheduler(False, check=True)
            command.assert_not_called()

    def test_job_provisioning_rejects_mutable_images_and_defaults_to_dry_run(self):
        with self.assertRaises(ValueError):
            infra.job_arguments("commcare-nova-migrate", "repo:latest")
        arguments = infra.job_arguments("commcare-nova-legacy-preplan-repair", IMAGE)
        self.assertIn("--args=legacy-preplan-repair.cjs", arguments)
        self.assertNotIn("--execute", " ".join(arguments))
        with patch.object(infra, "command") as command, redirect_stdout(io.StringIO()):
            infra.run_or_plan(arguments, False)
            command.assert_not_called()


class JobExecutionTests(unittest.TestCase):
    def test_completed_execution_can_omit_vpc_after_fenced_job_validation(self):
        job = job_fixture()
        task = copy.deepcopy(job["template"]["template"])
        del task["vpcAccess"]
        execution = {"name": JOB + "/executions/run-1", "template": task,
            "taskCount": 1, "parallelism": 1, "succeededCount": 1,
            "completionTime": "2026-09-05T07:51:20Z"}
        operation = {"name": "projects/commcare-nova/locations/us-central1/operations/run-1"}
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch.object(
            deploy, "_run_api_request", side_effect=[job, operation,
                {"done": True, "response": execution}, execution]) as api:
            result = deploy._execute_job_exact(project="commcare-nova", region="us-central1",
                job="commcare-nova-migrate", expected_image=IMAGE, execution_args=[], wait_seconds=1)
            self.assertEqual(result, execution)
            self.assertEqual(api.call_args_list[1].args[3], {"etag": "generation-3"})
        task["vpcAccess"] = {"egress": "ALL_TRAFFIC"}
        with self.assertRaises(deploy.DeploymentPolicyError):
            deploy._assert_exact_execution_succeeded(execution, JOB, IMAGE, ["migrate.cjs"])
        del job["template"]["template"]["vpcAccess"]
        with self.assertRaises(deploy.DeploymentPolicyError):
            deploy._exact_ready_job_etag(job, JOB, IMAGE)

    def test_configuration_drift_refuses_before_execution(self):
        for variant in ("image", "identity", "environment", "network", "generation", "retries"):
            job = job_fixture()
            task = job["template"]["template"]
            if variant == "image":
                task["containers"][0]["image"] = IMAGE.replace("a" * 64, "b" * 64)
            elif variant == "identity":
                task["serviceAccount"] = "wrong@example.com"
            elif variant == "environment":
                task["containers"][0]["env"][0]["value"] = "wrong-database"
            elif variant == "network":
                task["vpcAccess"]["egress"] = "ALL_TRAFFIC"
            elif variant == "generation":
                job["generation"] = "4"
            else:
                task["maxRetries"] = 1
            with self.subTest(variant=variant), patch.object(deploy, "_access_token", return_value="synthetic"), patch.object(deploy, "_run_api_request", return_value=job) as api:
                with self.assertRaises(deploy.DeploymentPolicyError):
                    deploy._execute_job_exact(project="commcare-nova", region="us-central1", job="commcare-nova-migrate", expected_image=IMAGE, execution_args=[], wait_seconds=1)
                self.assertEqual([call.args[1] for call in api.call_args_list], ["GET"])

    def test_execution_post_is_not_retried_after_transport_failure(self):
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch.object(deploy, "_run_api_request", side_effect=[job_fixture(), OSError("connection lost")]) as api:
            with self.assertRaises(OSError):
                deploy._execute_job_exact(project="commcare-nova", region="us-central1", job="commcare-nova-migrate", expected_image=IMAGE, execution_args=[], wait_seconds=1)
            self.assertEqual([call.args[1] for call in api.call_args_list], ["GET", "POST"])
            self.assertEqual(api.call_args_list[1].args[3], {"etag": "generation-3"})

    def test_retired_migration_overrides_are_not_accepted(self):
        for flag in ("--terminate-runtime-sessions-only", "--finalize-better-auth-17"):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args(JOB, ["migrate.cjs", flag])


class MigrationAdmissionTests(unittest.TestCase):
    def fixtures(self):
        job = job_fixture()
        job["latestCreatedExecution"] = {"name": "run-1", "completionTime": "2026-09-05T08:00:00Z", "completionStatus": "EXECUTION_SUCCEEDED"}
        task = copy.deepcopy(job["template"]["template"])
        del task["vpcAccess"]
        execution = {"name": JOB + "/executions/run-1", "template": task,
            "taskCount": 1, "parallelism": 1, "succeededCount": 1,
            "completionTime": "2026-09-05T08:00:00Z"}
        return job, execution

    def admit(self, image=IMAGE):
        return gate.admit_migration(project="commcare-nova", region="us-central1",
            job="commcare-nova-migrate", image=image, wait_seconds=1)

    def test_identical_successful_artifact_uses_only_read_only_evidence(self):
        job, execution = self.fixtures()
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch.object(gate.policy, "_run_api_request", side_effect=[job, execution, job]) as api, patch.object(gate.policy, "_execute_job_exact") as execute:
            result = self.admit()
        self.assertEqual(result["mode"], "reused")
        self.assertEqual([c.args[1] for c in api.call_args_list], ["GET", "GET", "GET"])
        execute.assert_not_called()

    def test_job_or_latest_execution_change_refuses_cached_success(self):
        for change in ("etag", "latest"):
            job, execution = self.fixtures()
            after = copy.deepcopy(job)
            if change == "etag": after["etag"] = "generation-4"
            else: after["latestCreatedExecution"]["name"] = "run-2"
            with self.subTest(change=change), patch.object(gate.policy, "_access_token", return_value="synthetic"), patch.object(gate.policy, "_run_api_request", side_effect=[job, execution, after]), patch.object(gate.policy, "_execute_job_exact") as execute:
                with self.assertRaises(gate.policy.TerminalDeploymentPolicyError): self.admit()
                execute.assert_not_called()

    def test_changed_artifact_updates_only_image_with_etag_before_execution(self):
        job, execution = self.fixtures()
        job["labels"] = {"team": "nova"}
        job["annotations"] = {"example.com/owner": "deployment"}
        job["binaryAuthorization"] = {"useDefault": True}
        job["startExecutionToken"] = "never-replay-this"
        image = IMAGE.replace("a" * 64, "b" * 64)
        updated = copy.deepcopy(job)
        updated["template"]["template"]["containers"][0]["image"] = image
        updated["etag"] = "generation-4"
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch.object(gate.policy, "_run_api_request", side_effect=[job, {}, updated]) as api, patch.object(gate.policy, "_execute_job_exact", return_value=execution) as execute:
            result = self.admit(image)
        self.assertEqual(result["mode"], "executed")
        self.assertEqual([c.args[1] for c in api.call_args_list], ["GET", "PATCH", "GET"])
        update = api.call_args_list[1]
        self.assertEqual(update.args[2], JOB)
        self.assertEqual(update.args[3]["etag"], "generation-3")
        self.assertEqual(update.args[3]["template"], updated["template"])
        self.assertNotIn("latestCreatedExecution", update.args[3])
        self.assertNotIn("generation", update.args[3])
        self.assertNotIn("startExecutionToken", update.args[3])
        for field in ("labels", "annotations", "binaryAuthorization"):
            self.assertEqual(update.args[3][field], job[field])
        self.assertEqual(execute.call_args.kwargs["expected_image"], image)

    def test_failed_execution_requires_a_new_actual_execution(self):
        job, execution = self.fixtures()
        execution["succeededCount"] = 0
        execution["failedCount"] = 1
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch.object(gate.policy, "_run_api_request", side_effect=[job, execution]), patch.object(gate.policy, "_execute_job_exact", return_value={"name": JOB + "/executions/run-2"}) as execute:
            self.assertEqual(self.admit()["mode"], "executed")
        execute.assert_called_once()

    def test_missing_execution_never_counts_as_success(self):
        import urllib.error
        job, _ = self.fixtures()
        error = gate.policy.TerminalDeploymentPolicyError("missing")
        error.__cause__ = urllib.error.HTTPError("https://run.googleapis.com", 404, "Not Found", {}, None)
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch.object(gate.policy, "_run_api_request", side_effect=[job, error]), patch.object(gate.policy, "_execute_job_exact", return_value={"name": JOB + "/executions/run-2"}) as execute:
            self.assertEqual(self.admit()["mode"], "executed")
        execute.assert_called_once()

    def test_active_different_artifact_is_not_overwritten(self):
        job, execution = self.fixtures()
        del job["latestCreatedExecution"]["completionTime"]
        del execution["completionTime"]
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch.object(gate.policy, "_run_api_request", side_effect=[job, execution]) as api, patch.object(gate.policy, "_execute_job_exact") as execute:
            with self.assertRaises(gate.policy.DeploymentPolicyError):
                self.admit(IMAGE.replace("a" * 64, "b" * 64))
        self.assertEqual([c.args[1] for c in api.call_args_list], ["GET", "GET"])
        execute.assert_not_called()

    def test_immutable_execution_contract_error_fails_without_polling(self):
        _, execution = self.fixtures()
        execution["template"]["serviceAccount"] = "different@example.com"
        with self.assertRaises(gate.policy.TerminalDeploymentPolicyError):
            gate.policy._assert_exact_execution_succeeded(execution, JOB, IMAGE, ["migrate.cjs"])


class ImageMetadataTests(unittest.TestCase):
    def test_emitted_push_digest_is_required_and_cannot_inject_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); metadata = root / "metadata.json"; output = root / "image.env"
            repository = IMAGE.split("@")[0]
            metadata.write_text(json.dumps({"containerimage.digest": "sha256:" + "a" * 64}))
            self.assertEqual(image_metadata.write_image_environment(metadata, repository, output), IMAGE)
            self.assertIn(IMAGE, output.read_text())
            metadata.write_text(json.dumps({"containerimage.digest": "sha256:bad\nINJECTED=true"}))
            with self.assertRaises(ValueError): image_metadata.write_image_environment(metadata, repository, output)
            with self.assertRaises(ValueError): image_metadata.write_image_environment(metadata, "registry; echo wrong", output)


if __name__ == "__main__":
    unittest.main()
