package nova.proof.core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The proof harness's CommCare Core runner: one long-lived JVM answering JSON-line
 * requests on stdin with one JSON line each on stdout.
 *
 * Core writes to System.out and System.err itself (installers, parsers, the
 * localization setup), so the protocol keeps the process's real stdout for
 * itself and points both System streams at a per-request capture that each
 * response returns as "log". Requests run one at a time on a single worker
 * thread, because Core's localizer, reference roots and archive roots are
 * process-wide. Every request carries a deadline; XPath evaluation cannot be
 * interrupted, so a request that outlives its deadline is answered with an
 * error of kind "deadline" and the process halts, leaving the client to start
 * a fresh one.
 */
public final class Runner {
    /** Exit status of a process that halted because a request outlived its deadline. */
    static final int DEADLINE_EXIT = 75;
    private static final int LOG_LIMIT = 256 * 1024;

    private final PrintStream protocol;
    private final ByteArrayOutputStream captured;
    private final ExecutorService worker;
    private final Apps apps = new Apps();

    private Runner(PrintStream protocol, ByteArrayOutputStream captured) {
        this.protocol = protocol;
        this.captured = captured;
        this.worker = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "proof-core-worker");
            thread.setDaemon(true);
            return thread;
        });
    }

    public static void main(String[] args) throws Exception {
        PrintStream protocol = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        PrintStream capture = new PrintStream(captured, true, StandardCharsets.UTF_8);
        System.setOut(capture);
        System.setErr(capture);
        try {
            ProofClock.requireInstalled();
        } catch (IllegalStateException e) {
            System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8));
            System.err.println(e.getMessage());
            System.exit(2);
        }
        Runner runner = new Runner(protocol, captured);
        runner.announce();
        runner.serve();
    }

    private void announce() {
        JSONObject core = new JSONObject();
        core.put("commit", coreCommit());
        core.put("platform", Admission.PLATFORM_VERSION);
        JSONObject ready = new JSONObject();
        ready.put("ready", true);
        ready.put("core", core);
        ready.put("java", System.getProperty("java.version"));
        JSONArray clockReaders = new JSONArray();
        ProofClock.READERS.forEach(reader -> clockReaders.put(reader.getSimpleName()));
        ready.put("clockReaders", clockReaders);
        protocol.println(ready.toString());
        protocol.flush();
    }

    /**
     * The commit of the Core checkout this JVM runs, read from the checkout's
     * git metadata. The client names the checkout with -Dnova.proof.core.
     */
    private static String coreCommit() {
        String dir = System.getProperty("nova.proof.core");
        if (dir == null) {
            return null;
        }
        try {
            Path git = Path.of(dir, ".git");
            String head = Files.readString(git.resolve("HEAD"), StandardCharsets.UTF_8).trim();
            if (head.startsWith("ref: ")) {
                return Files.readString(git.resolve(head.substring(5)), StandardCharsets.UTF_8).trim();
            }
            return head;
        } catch (IOException e) {
            return null;
        }
    }

    private void serve() throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            handle(line);
        }
        protocol.flush();
        System.exit(0);
    }

    private void handle(String line) {
        JSONObject request;
        try {
            request = new JSONObject(line);
        } catch (RuntimeException e) {
            respond(failure(null, "request", e.getClass().getName(),
                    "The runner could not read this request line as a JSON object: " + e.getMessage(), null));
            return;
        }
        Object id = request.opt("id");
        String op = request.optString("op", null);
        if (op == null) {
            respond(failure(id, "request", null, "The request names no op. Send one of: "
                    + String.join(", ", Ops.NAMES) + ".", null));
            return;
        }
        if (!request.has("deadlineMs") || request.optLong("deadlineMs", -1) <= 0) {
            respond(failure(id, "request", null, "The " + op + " request carries no positive deadlineMs;"
                    + " every request needs one, since the runner cannot interrupt a runaway evaluation.", null));
            return;
        }
        long deadline = request.getLong("deadlineMs");
        if (op.equals("shutdown")) {
            JSONObject ok = new JSONObject();
            ok.put("id", id);
            ok.put("ok", true);
            ok.put("result", new JSONObject());
            respond(ok);
            apps.releaseAll();
            System.exit(0);
            return;
        }
        synchronized (captured) {
            captured.reset();
        }
        Future<JSONObject> future = worker.submit(() -> Ops.dispatch(op, request, apps));
        JSONObject response;
        try {
            JSONObject result = future.get(deadline, TimeUnit.MILLISECONDS);
            response = new JSONObject();
            response.put("id", id);
            response.put("ok", true);
            response.put("result", result);
        } catch (TimeoutException e) {
            respond(failure(id, "deadline", null, "The " + op + " request did not finish within its deadline of "
                    + deadline + " ms. Core cannot interrupt an evaluation, so this runner halts; the client"
                    + " starts a fresh one for later requests.", null));
            protocol.flush();
            Runtime.getRuntime().halt(DEADLINE_EXIT);
            return;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            response = failure(id, "internal", e.getClass().getName(), "The runner was interrupted while waiting"
                    + " for the " + op + " request.", null);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof RequestException) {
                response = failure(id, "request", null, cause.getMessage(), null);
            } else {
                response = failure(id, "internal", cause.getClass().getName(),
                        "The " + op + " request raised " + cause.getClass().getSimpleName() + ": "
                                + cause.getMessage(), stackTrace(cause));
            }
        }
        respond(response);
    }

    private JSONObject failure(Object id, String kind, String errorClass, String message, String trace) {
        JSONObject error = new JSONObject();
        error.put("kind", kind);
        if (errorClass != null) {
            error.put("class", errorClass);
        }
        error.put("message", message);
        if (trace != null) {
            error.put("trace", trace);
        }
        JSONObject response = new JSONObject();
        response.put("id", id == null ? JSONObject.NULL : id);
        response.put("ok", false);
        response.put("error", error);
        return response;
    }

    private void respond(JSONObject response) {
        String log;
        synchronized (captured) {
            log = captured.toString(StandardCharsets.UTF_8);
        }
        if (log.length() > LOG_LIMIT) {
            log = log.substring(0, LOG_LIMIT) + "\n[the runner kept the first " + LOG_LIMIT
                    + " characters of this request's output]";
        }
        response.put("log", log);
        protocol.println(response.toString());
        protocol.flush();
    }

    static String stackTrace(Throwable error) {
        StringWriter out = new StringWriter();
        error.printStackTrace(new PrintWriter(out));
        return out.toString();
    }
}
