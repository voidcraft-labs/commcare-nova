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
 *
 * A request can ask the client something while it runs (ask): the runner writes
 * a callback line, {"id": the request's id, "callback": its name, "question"},
 * and reads the client's answer as the next line of its stdin, {"callback": the
 * same name, "answer"}. The main thread reads stdin only between requests, so
 * while a request runs its worker thread reads the answer alone. A session asks
 * for HQ's answer to each case search this way where its request names
 * "searchAnswers" (ProofSessionUtils).
 */
public final class Runner {
    /** Exit status of a process that halted because a request outlived its deadline. */
    static final int DEADLINE_EXIT = 75;
    private static final int LOG_LIMIT = 256 * 1024;

    private final PrintStream protocol;
    private final ByteArrayOutputStream captured;
    private final ExecutorService worker;
    private final Apps apps = new Apps();
    /** The runner serving this process, which ask writes to and reads from. */
    private static volatile Runner serving;
    /** The protocol's input, read by the main thread between requests and by ask during one. */
    private BufferedReader in;
    /** The id of the request running now, which a callback line names. */
    private volatile Object running;

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
        serving = runner;
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
        in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
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
        running = id;
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

    /**
     * The client's answer to a question the running request asks it: the callback line written to the protocol,
     * then the client's next line read as {"callback": name, "answer": {...}}, whose answer is returned. A line
     * that is not that answer, or a stdin that closed, fails the request: the client answers every callback of a
     * request it asked for, so a request can never read the next request's line as an answer.
     */
    static JSONObject ask(String callback, JSONObject question) {
        Runner runner = serving;
        if (runner == null || runner.in == null) {
            throw new IllegalStateException("A request asked the client for its " + callback
                    + " answer outside a runner serving the protocol.");
        }
        return runner.askClient(callback, question);
    }

    private JSONObject askClient(String callback, JSONObject question) {
        JSONObject line = new JSONObject();
        line.put("id", running == null ? JSONObject.NULL : running);
        line.put("callback", callback);
        line.put("question", question);
        protocol.println(line.toString());
        protocol.flush();
        String answered;
        try {
            answered = in.readLine();
        } catch (IOException e) {
            throw new IllegalStateException("The runner could not read the client's " + callback + " answer: "
                    + e.getMessage(), e);
        }
        if (answered == null) {
            throw new IllegalStateException("The client closed the protocol's input while the runner waited for its "
                    + callback + " answer.");
        }
        JSONObject parsed;
        try {
            parsed = new JSONObject(answered);
        } catch (RuntimeException e) {
            throw new IllegalStateException("The client answered the runner's " + callback
                    + " question with a line that is not a JSON object.", e);
        }
        JSONObject answer = parsed.optJSONObject("answer");
        if (!callback.equals(parsed.optString("callback", null)) || answer == null) {
            throw new IllegalStateException("The client answered the runner's " + callback
                    + " question with a line that names no " + callback + " answer; the protocol is out of step.");
        }
        return answer;
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
