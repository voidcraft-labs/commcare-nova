package nova.proof.android;

import org.junit.runner.JUnitCore;
import org.junit.runner.Result;
import org.junit.runner.notification.Failure;

/**
 * The Android reader's JVM: one request, one device, one process.
 *
 * {@code Runner <request file> <answer file>} hands both to Reader as system properties and runs it through
 * JUnit, so Robolectric builds the device for the request. A JVM answers one request and exits, because
 * commcare-android keeps state in statics a device's process holds for its whole life (Core's ReferenceManager
 * and its archive roots, the localizer, the form controller): a second device in the same JVM would start with
 * the first one's, where a real device starts with none.
 *
 * It exits 0 when the test ran and passed (the answer file then holds what Android read, or what the reader
 * raised), and 1 with JUnit's report on standard error when it did not.
 */
public final class Runner {
    private Runner() {
    }

    public static void main(String[] arguments) {
        if (arguments.length != 2) {
            System.err.println("usage: Runner <request file> <answer file>");
            System.exit(2);
        }
        System.setProperty(Reader.REQUEST, arguments[0]);
        System.setProperty(Reader.RESPONSE, arguments[1]);
        Result result = new JUnitCore().run(Reader.class);
        for (Failure failure : result.getFailures()) {
            System.err.println(failure.getTestHeader() + ": " + failure.getTrace());
        }
        // Android's own threads (its task executors, the looper's) are not daemons.
        System.exit(result.wasSuccessful() && result.getRunCount() == 1 ? 0 : 1);
    }
}
