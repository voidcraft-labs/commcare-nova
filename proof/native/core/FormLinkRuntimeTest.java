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
 * over the ten admitted Nova apps of the form link corpus
 * ({@code lib/commcare/__tests__/formLinkWireFixture.ts}) and independently
 * regenerated HQ entries. Core pushes a frame for every {@code <create>} whose
 * condition holds and runs the frame pushed last first
 * ({@code CommCareSession.finishExecuteAndPop}, {@code finishAndPop}), and Nova
 * emits a form's destinations in reverse, so the frames run in the author's
 * order; the otherwise is pushed last and so runs first. */
public class FormLinkRuntimeTest {
    @Test public void authoredSessionReadsMatchCreatedCasesAndTheLinkedSelection() throws Exception {
        var document = SessionReadAssertions.targeted("form-link", "targeted-form-link-session-reads");
        for (boolean hq : new boolean[]{false, true}) {
            SessionReadAssertions.createdAndWorker(document, hq, false, true);
            SessionReadAssertions.selectedAndGroup(document, hq);
        }
    }
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-links", null, true, true, false); }
    }
    private Suite suite(String scenario, boolean hq) throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/form-link/" + scenario + (hq ? ".hq-suite.xml" : ".suite.xml"))) {
            assertNotNull(scenario, input);
            return new Parser(input).parse();
        }
    }
    /** The session's evaluation context after the source form's submission landed: the worker's record and the
     *  frog the registration created, under the id its entry made ({@code created-frog}). */
    private EvaluationContext context(Entry entry, CommCareSession session, String username) {
        var sandbox = MockDataUtils.getStaticStorage();
        Case worker = new Case("Worker", "commcare-user");
        worker.setCaseId("worker-case");
        worker.setProperty("hq_user_id", "worker-7");
        worker.setProperty("username", username);
        sandbox.getCaseStorage().write(worker);
        Case created = new Case("Created frog", "frog");
        created.setCaseId("created-frog");
        sandbox.getCaseStorage().write(created);
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
    /** The command a frame opens: its last command step's, or "" for a frame with none (the app's first screen). */
    private static String command(SessionFrame frame) {
        String command = "";
        for (StackFrameStep step : frame.getSteps()) if (SessionFrame.STATE_COMMAND_ID.equals(step.getType())) command = step.getId();
        return command;
    }
    /** Completes the source form and reads, in the order Core runs them, the command of every frame its completion
     *  pushed: the frame it popped into the session first, then each pending frame from the top of the stack down.
     *  Empty where no frame was pushed and the session is over. */
    private List<String> completedCommands(CommCareSession session, EvaluationContext context) {
        List<String> commands = new ArrayList<>();
        if (!session.finishExecuteAndPop(context)) return commands;
        commands.add(command(session.getFrame()));
        Stack<SessionFrame> pending = session.getFrameStack();
        for (int i = pending.size() - 1; i >= 0; i--) commands.add(command(pending.get(i)));
        return commands;
    }
    /** The commands each scenario's completion runs, in order, for {@code username}: the author's first
     *  destination that holds first; an otherwise that runs before an every-time destination, since it is pushed
     *  last; and nothing for a destination whose carried case the device does not hold. */
    private static List<String> expectedCommands(String scenario, String username) {
        boolean alice = username.equals("alice");
        switch (scenario) {
            case "else": return List.of(alice ? "m1-f0" : "m1");
            case "module": case "previous": case "carried-held": return List.of(alice ? "m1-f0" : "m0");
            case "home": return alice ? List.of("m1-f0") : List.of();
            case "unconditional": return List.of("m1");
            case "overlap": return List.of(alice ? "m1-f0" : username.equals("bea") ? "m1" : "m0");
            case "manual": return List.of();
            case "chain": return alice ? List.of("m1-f0", "m1") : List.of("", "m1");
            case "this-form": return List.of("m0-f0");
            default: throw new IllegalArgumentException(scenario);
        }
    }
    private static final String[] SCENARIOS = {"else", "module", "home", "previous", "unconditional", "overlap", "manual", "chain", "this-form", "carried-held"};
    private CommCareSession session(Suite suite) {
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand("m0-f0");
        session.setDatum(SessionFrame.STATE_DATUM_COMPUTED, "case_id_new_frog_0", "created-frog");
        return session;
    }
    @Test public void completionRunsEveryDestinationThatHoldsInTheAuthorsOrder() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String scenario : SCENARIOS) for (String username : new String[]{"alice", "bea", "other"}) {
            String at = scenario + " / " + username + " hq=" + hq;
            Suite suite = suite(scenario, hq);
            Entry source = suite.getEntry("m0-f0");
            CommCareSession session = session(suite);
            EvaluationContext context = context(source, session, username);
            List<String> expected = expectedCommands(scenario, username);
            int triggered = 0;
            for (StackOperation operation : source.getPostEntrySessionOperations()) if (operation.isOperationTriggered(context)) triggered++;
            assertEquals(at, expected.size(), triggered);
            assertEquals(at, expected, completedCommands(session, context));
            if (expected.isEmpty()) continue;
            if (expected.get(0).equals("m1-f0")) {
                // Visit opens on the frog the registration created, matched or carried.
                assertEquals(at, "created-frog", session.getData().get("case_id"));
                assertNull(at, session.getNeededDatum());
            }
            if (scenario.equals("previous") && !username.equals("alice")) {
                String nextId = session.getData().get("case_id_new_frog_0");
                assertNotNull(at, nextId);
                assertTrue(at, nextId.matches("[0-9a-f-]{36}"));
                assertNotEquals(at, "created-frog", nextId);
            }
        }
    }

    @Test public void aSelfLinkStartsTheFormAgain() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String username : new String[]{"alice", "other"}) {
            String at = "this-form / " + username + " hq=" + hq;
            Suite suite = suite("this-form", hq);
            Entry source = suite.getEntry("m0-f0");
            CommCareSession session = session(suite);
            assertTrue(at, session.finishExecuteAndPop(context(source, session, username)));
            // The source form's own entry, with a new registration's id of its own and nothing left to choose.
            assertEquals(at, source.getCommandId(), session.getCommand());
            assertTrue(at, session.getFrameStack().isEmpty());
            String nextId = session.getData().get("case_id_new_frog_0");
            assertNotNull(at, nextId);
            assertTrue(at, nextId.matches("[0-9a-f-]{36}"));
            assertNotEquals(at, "created-frog", nextId);
            assertNull(at, session.getNeededDatum());
        }
    }

    @Test public void aCarriedCaseNotOnTheDevicePushesNoFrame() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            // The destination carrying 'no-such-frog' never runs; as alice the destination carrying the created
            // frog does, and as anyone else the otherwise, this menu, runs in its place.
            for (String username : new String[]{"alice", "other"}) {
                String at = "carried-held / " + username + " hq=" + hq;
                Suite suite = suite("carried-held", hq);
                Entry source = suite.getEntry("m0-f0");
                CommCareSession session = session(suite);
                EvaluationContext context = context(source, session, username);
                int triggered = 0;
                for (StackOperation operation : source.getPostEntrySessionOperations()) if (operation.isOperationTriggered(context)) triggered++;
                assertEquals(at, 1, triggered);
                assertEquals(at, List.of(username.equals("alice") ? "m1-f0" : "m0"), completedCommands(session, context));
                if (username.equals("alice")) assertEquals(at, "created-frog", session.getData().get("case_id"));
            }
            // A literal case id the device does not hold: no frame, and with no otherwise the session is over.
            Suite manual = suite("manual", hq);
            CommCareSession session = session(manual);
            EvaluationContext context = context(manual.getEntry("m0-f0"), session, "alice");
            for (StackOperation operation : manual.getEntry("m0-f0").getPostEntrySessionOperations())
                assertFalse("manual hq=" + hq, operation.isOperationTriggered(context));
            assertFalse("manual hq=" + hq, session.finishExecuteAndPop(context));
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
            // A carried value that is blank names no case on the device, so the guard leaves no frame for it: as
            // alice the destination carrying the created frog would open Visit, and with its value blank the
            // otherwise opens instead.
            Suite carried = suite("carried-held", hq);
            CommCareSession blank = session(carried);
            blank.setDatum(SessionFrame.STATE_DATUM_COMPUTED, "case_id_new_frog_0", "");
            EvaluationContext context = context(carried.getEntry("m0-f0"), blank, "alice");
            assertEquals(List.of("m0"), completedCommands(blank, context));
        }
    }
}
