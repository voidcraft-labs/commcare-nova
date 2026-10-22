package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Hashtable;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionInstanceBuilder;
import org.commcare.suite.model.ComputedDatum;
import org.commcare.suite.model.EntityDatum;
import org.commcare.suite.model.SessionDatum;
import org.commcare.suite.model.Suite;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xform.util.XFormUtils;
import static org.junit.Assert.*;

/** Shared assertions over targeted corpus archives and HQ-regenerated forms. */
final class SessionReadAssertions {
    private SessionReadAssertions() {}

    static Path targeted(String family, String documentId) {
        Path directory = NativeProof.familyDirectory(family).resolve("targeted").resolve(documentId);
        assertTrue("The HQ step must load the targeted corpus document " + documentId, Files.isDirectory(directory));
        return directory;
    }

    private static byte[] resource(Path directory, boolean hq, String member, String hqFile) throws IOException {
        if (hq) return Files.readAllBytes(directory.resolve(hqFile));
        Path archivePath = directory.resolve("local.ccz");
        try (ZipFile archive = new ZipFile(archivePath.toFile())) {
            ZipEntry entry = archive.getEntry(member);
            assertNotNull(archivePath + " must contain " + member, entry);
            try (InputStream input = archive.getInputStream(entry)) {
                return input.readAllBytes();
            }
        }
    }

    private static final class Parser extends SuiteParser {
        Parser(InputStream input) throws IOException {
            super(input, null, "session-reads", null, true, true, false);
        }
    }

    private static final class Runtime extends TestInstanceInitializer {
        final CommCareSession session;

        Runtime(CommCareSession session) {
            this(MockDataUtils.getStaticStorage(), session);
        }

        private Runtime(MockUserDataSandbox sandbox, CommCareSession session) {
            super(sandbox);
            this.session = session;
            Case household = new Case("Household", "household");
            household.setCaseId("selected-household");
            sandbox.getCaseStorage().write(household);
            Case visit = new Case("Visit", "visit");
            visit.setCaseId("selected-visit");
            visit.setIndex(new CaseIndex("parent", "household", "selected-household"));
            sandbox.getCaseStorage().write(visit);
            Case worker = new Case("Worker", "commcare-user");
            worker.setCaseId("worker-record");
            worker.setProperty("hq_user_id", "worker-id");
            sandbox.getCaseStorage().write(worker);
        }

        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
            TreeElement root = SessionInstanceBuilder.getSessionInstance(session.getFrame(), "device", "1", 0L,
                    "worker", "worker-id", new Hashtable<>(), "400", "en");
            InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), instance.getBase());
            return new ConcreteInstanceRoot(root);
        }
    }

    private static CommCareSession session(Path base, boolean hq, String command) throws Exception {
        Suite suite;
        try (InputStream input = new ByteArrayInputStream(resource(base, hq, "suite.xml", "hq.suite.xml"))) {
            suite = new Parser(input).parse();
        }
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand(command);
        return session;
    }

    private static void supply(CommCareSession session, Runtime runtime, boolean nested) throws Exception {
        int count = 0;
        while (session.getNeededDatum() != null) {
            if (++count > 8) throw new AssertionError("The finite session fixture did not finish its datums");
            SessionDatum datum = session.getNeededDatum();
            if (datum instanceof ComputedDatum) session.setComputedDatum(session.getEvaluationContext(runtime));
            else {
                assertTrue("An authored session read needs a scalar case selection", datum instanceof EntityDatum);
                session.setEntityDatum(datum, nested && "case_id".equals(datum.getDataId())
                        ? "selected-household" : "selected-visit");
            }
        }
    }

    private static FormDef form(Path base, boolean hq, int index, Runtime runtime) throws Exception {
        FormDef form;
        try (InputStream input = new ByteArrayInputStream(resource(
                base, hq, "modules-1/forms-" + index + ".xml", "hq." + index + ".xml"))) {
            form = XFormUtils.getFormFromInputStream(input);
        }
        assertNotNull("Core must parse the emitted session-read form", form);
        form.initialize(true, runtime);
        return form;
    }

    private static Object read(FormDef form, String expression) throws Exception {
        return ExprEvalUtils.xpathEval(form.getEvaluationContext(), expression);
    }

    static void createdAndWorker(Path base, boolean hq, boolean nested, boolean followLink) throws Exception {
        CommCareSession session = session(base, hq, "m1-f1");
        Runtime runtime = new Runtime(session);
        supply(session, runtime, nested);
        FormDef form = form(base, hq, 1, runtime);
        String own = (String) read(form, "string(/data/new_id)");
        String child = (String) read(form, "string(/data/child_id)");
        assertFalse(base + " new case hq=" + hq, own.isEmpty());
        assertFalse(base + " child case hq=" + hq, child.isEmpty());
        assertNotEquals("The primary and child get distinct session identities", own, child);
        assertEquals(own, read(form, "string(/data/case/@case_id)"));
        assertEquals(child, read(form, "string(/data/subcase_0/case/@case_id)"));
        assertEquals("worker-record", read(form, "string(/data/worker_id)"));
        assertEquals("worker-record", read(form, "string(/data/commcare_usercase/case/@case_id)"));
        if (followLink) {
            assertTrue(session.finishExecuteAndPop(session.getEvaluationContext(runtime)));
            assertEquals("m1-f0", session.getCommand());
            assertEquals(own, session.getData().get("case_id"));
            supply(session, runtime, false);
            assertEquals(own, read(form(base, hq, 0, runtime), "string(/data/selected_id)"));
        }
    }

    static void selectedAndGroup(Path base, boolean hq) throws Exception {
        CommCareSession session = session(base, hq, "m1-f0");
        Runtime runtime = new Runtime(session);
        supply(session, runtime, false);
        FormDef form = form(base, hq, 0, runtime);
        assertEquals(base + " selected case hq=" + hq, "selected-visit", read(form, "string(/data/selected_id)"));
        assertEquals(base + " group parents hq=" + hq, "selected-household", read(form, "string(/data/group_parent_ids)"));
    }

    static void selectedAndParent(Path base, boolean hq) throws Exception {
        CommCareSession session = session(base, hq, "m1-f0");
        Runtime runtime = new Runtime(session);
        supply(session, runtime, true);
        FormDef form = form(base, hq, 0, runtime);
        assertEquals(base + " selected child hq=" + hq, "selected-visit", read(form, "string(/data/selected_id)"));
        assertEquals(base + " selected parent hq=" + hq, "selected-household", read(form, "string(/data/parent_selected_id)"));
        assertEquals("selected-household", session.getData().get("case_id"));
        assertEquals("selected-visit", session.getData().get("case_id_visit"));
    }
}
