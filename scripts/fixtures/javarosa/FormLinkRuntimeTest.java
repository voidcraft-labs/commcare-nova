package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.suite.model.*;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionFrame;
import org.commcare.session.SessionInstanceBuilder;
import org.commcare.util.CommCarePlatform;
import org.commcare.cases.model.Case;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual Core completion, stack operations, session state and next required datum
 * over seven admitted Nova apps and independently regenerated HQ entries. */
public class FormLinkRuntimeTest {
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-links", null, true, true, false); }
    }
    private Suite suite(String scenario, boolean hq) throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/" + scenario + (hq ? ".hq-suite.xml" : ".suite.xml"))) {
            assertNotNull(scenario, input);
            return new Parser(input).parse();
        }
    }
    private EvaluationContext context(Entry entry, CommCareSession session, String username) {
        var sandbox = MockDataUtils.getStaticStorage();
Case worker = new Case("Worker", "commcare-user");
worker.setCaseId("worker-case");
worker.setProperty("hq_user_id", "worker-7");
worker.setProperty("username", username);
sandbox.getCaseStorage().write(worker);
TestInstanceInitializer initializer = new TestInstanceInitializer(sandbox) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                TreeElement root = SessionInstanceBuilder.getSessionInstance(session.getFrame(), "device", "1", 0L, username, "worker-7", new Hashtable<>(), "400", "en");
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), instance.getBase());
                return new ConcreteInstanceRoot(root);
            }
        };
        Hashtable<String, DataInstance> instances = entry.getInstances(null);
        for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(initializer, id));
        return new EvaluationContext(null, instances);
    }
    private CommCareSession session(Suite suite) {
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand("m0-f0");
        session.setDatum(SessionFrame.STATE_DATUM_COMPUTED, "case_id_new_frog_0", "created-frog");
        return session;
    }
    @Test public void completionChoosesFirstTrueLinkAndCarriesTheChosenCase() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String scenario : new String[]{"else", "module", "home", "previous", "unconditional", "overlap", "manual"}) for (String username : new String[]{"alice", "bea", "other"}) {
            Suite suite = suite(scenario, hq);
            Entry source = suite.getEntry("m0-f0");
            CommCareSession session = session(suite);
EvaluationContext context = context(source, session, username);
            boolean form = scenario.equals("manual") || (!scenario.equals("unconditional") && username.equals("alice"));
            boolean home = scenario.equals("home") && !form;
            int triggered = 0;
            for (StackOperation operation : source.getPostEntrySessionOperations()) if (operation.isOperationTriggered(context)) triggered++;
            assertEquals(scenario + " / " + username + " hq=" + hq, home ? 0 : 1, triggered);
            assertEquals(!home, session.finishExecuteAndPop(context));
            if (home) continue;
            String command = form ? "m1-f0" : scenario.equals("unconditional") || scenario.equals("else") || scenario.equals("overlap") && username.equals("bea") ? "m1" : "m0";
            assertEquals(scenario + " / " + username + " hq=" + hq, command, session.getCommand());
            if (form) {
                assertEquals(scenario.equals("manual") ? "explicit-frog" : "created-frog", session.getData().get("case_id"));
                assertNull(session.getNeededDatum());
            }
            if (scenario.equals("previous") && !form) {
                String nextId = session.getData().get("case_id_new_frog_0");
                assertNotNull(nextId);
                assertTrue(nextId.matches("[0-9a-f-]{36}"));
                assertNotEquals("created-frog", nextId);
            }
        }
    }

    @Test public void absentSourceRaisesAndEmptySourceNeverPromptsForTargetCase() throws Exception {
        // Deliberately incomplete native session states explain why Nova refuses
        // unmatched automatic sources; no admitted-app reachability claim.
        for (boolean hq : new boolean[]{false, true}) {
            Suite suite = suite("else", hq);
            CommCareSession absent = session(suite);
            absent.clearAllState();
            absent.setCommand("m0-f0");
            assertThrows(org.javarosa.xpath.XPathTypeMismatchException.class,
                () -> absent.finishExecuteAndPop(context(suite.getEntry("m0-f0"), absent, "alice")));
            CommCareSession empty = session(suite);
            empty.setDatum(SessionFrame.STATE_DATUM_COMPUTED, "case_id_new_frog_0", "");
            assertTrue(empty.finishExecuteAndPop(context(suite.getEntry("m0-f0"), empty, "alice")));
            assertEquals("m1-f0", empty.getCommand());
            assertEquals("", empty.getData().get("case_id"));
            assertNull(empty.getNeededDatum());
        }
    }
}
