"""The temporary maintenance job admits only its fixed bundle and operation."""
import unittest
from deployment_fixtures import deploy


class ProseRepairJobTests(unittest.TestCase):
    def test_only_manifest_scoped_operations_are_allowed(self):
        job = "commcare-nova-prose-reference-repair"
        for args in (
            ["prose-reference-repair.cjs"],
            ["prose-reference-repair.cjs", "--execute"],
            ["prose-reference-repair.cjs", "--execute", "--app", "fixture-app"],
            ["prose-reference-repair.cjs", "--rollback", "--app", "fixture-app"],
        ):
            self.assertEqual(deploy._effective_execution_args(job, args), tuple(args))
        for args in (
            ["other.cjs", "--execute"],
            ["prose-reference-repair.cjs", "--execute", "--prod"],
            ["prose-reference-repair.cjs", "--execute", "--manifest", "/tmp/other"],
            ["prose-reference-repair.cjs", "--execute", "--app", "--rollback"],
            ["prose-reference-repair.cjs", "--execute", "--rollback"],
        ):
            with self.subTest(args=args), self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args(job, args)
