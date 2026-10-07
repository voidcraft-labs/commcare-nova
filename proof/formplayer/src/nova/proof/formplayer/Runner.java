package nova.proof.formplayer;

import org.javarosa.core.util.MathUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializer;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Field;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The proof harness's Formplayer runner: Formplayer's whole Spring application,
 * started by its own main, in one long-lived JVM that answers JSON-line
 * requests on stdin with one JSON line each on stdout.
 *
 * What runs is Formplayer's boot jar's classes and libraries in the order its
 * launcher loads them (proof/image/formplayer/build.sh), with its real web
 * server on a loopback port, its real filters, security chain, aspects,
 * controllers and services, its real Postgres (the lane's, migrated by
 * Formplayer's own Flyway migrations) and its real Redis. The one address it
 * is given in place of production's is CommCare HQ's (commcarehq.host): the
 * runner's HqPeer, which hands every request Formplayer makes of HQ back to
 * the client.
 *
 * The protocol: the client sends {"id", "op", "deadlineMs", ...}; the runner
 * answers {"id", "ok", "result" | "error", "log"}. While a request runs, each
 * request Formplayer makes of HQ is written as {"id", "hq": n, "request"}, and
 * the client answers it with {"hq": n, "status", "headers", "bodyBase64"}
 * before the request's own answer comes. Formplayer and its libraries write to
 * System.out and System.err, so the protocol keeps the process's real stdout
 * and both streams go to a capture each response returns as "log".
 *
 * Requests run one at a time. A request that outlives its deadline is answered
 * with an error of kind "deadline" and the process halts, leaving the client
 * to start a fresh one, as the Core runner does.
 */
public final class Runner {
    /** Exit status of a process that halted because a request outlived its deadline. */
    static final int DEADLINE_EXIT = 75;
    private static final int LOG_LIMIT = 256 * 1024;
    static final List<String> OPS = List.of("http", "clock", "syncTimes", "ageSync");

    private final PrintStream protocol;
    private final Capture captured;
    private final ExecutorService worker;
    private final HttpClient http;
    private HqPeer peer;
    private volatile Object current;

    private Runner(PrintStream protocol, Capture captured) {
        this.protocol = protocol;
        this.captured = captured;
        this.worker = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "proof-formplayer-worker");
            thread.setDaemon(true);
            return thread;
        });
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    public static void main(String[] args) throws Exception {
        PrintStream protocol = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        PrintStream realErr = new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8);
        Capture captured = new Capture();
        PrintStream capture = new PrintStream(captured, true, StandardCharsets.UTF_8);
        System.setOut(capture);
        System.setErr(capture);
        Runner runner = new Runner(protocol, captured);
        try {
            ProofClock.requireInstalled();
            runner.boot(args);
        } catch (Throwable e) {
            realErr.println(captured.take());
            e.printStackTrace(realErr);
            realErr.flush();
            Runtime.getRuntime().halt(2);
        }
        runner.announce();
        runner.serve();
    }

    /**
     * Starts the peer, names it as HQ, and runs Formplayer's own main. Everything
     * else Formplayer is configured with is its own application.properties, read
     * through the environment names its Dockerfile sets, which the client passes
     * as system properties.
     */
    private void boot(String[] args) throws Exception {
        long wait = Long.parseLong(System.getProperty("nova.proof.formplayer.hqWaitMs", "120000"));
        peer = new HqPeer(this, wait);
        peer.start();
        System.setProperty("COMMCARE_HOST", peer.origin());
        // Formplayer binds whatever port is free; Started reads which.
        System.setProperty("SERVER_PORT", "0");
        org.commcare.formplayer.Application.main(args);
        if (Started.port() <= 0 || Started.context() == null) {
            throw new IllegalStateException("Formplayer's main returned without its web server's port or its"
                    + " application context reaching the runner's listener (port " + Started.port() + "). The"
                    + " listener is named in META-INF/spring.factories beside the runner's classes; check that the"
                    + " client wrote it.");
        }
    }

    private void announce() {
        JSONObject formplayer = new JSONObject();
        formplayer.put("commit", commit(System.getProperty("nova.proof.formplayer")));
        formplayer.put("core", commit(System.getProperty("nova.proof.formplayer") + "/libs/commcare"));
        JSONObject ready = new JSONObject();
        ready.put("ready", true);
        ready.put("formplayer", formplayer);
        ready.put("java", System.getProperty("java.version"));
        ready.put("port", Started.port());
        ready.put("hq", peer.origin());
        JSONArray clockReaders = new JSONArray();
        ProofClock.READERS.forEach(reader -> clockReaders.put(reader.getSimpleName()));
        ready.put("clockReaders", clockReaders);
        ready.put("log", captured.take());
        write(ready);
    }

    /** The commit of a checkout, from its git metadata (a submodule's .git is a file naming its directory). */
    private static String commit(String dir) {
        if (dir == null) {
            return null;
        }
        try {
            Path git = Path.of(dir, ".git");
            if (Files.isRegularFile(git)) {
                String pointer = Files.readString(git, StandardCharsets.UTF_8).trim();
                if (!pointer.startsWith("gitdir: ")) {
                    return null;
                }
                git = Path.of(dir).resolve(pointer.substring(8)).normalize();
            }
            String head = Files.readString(git.resolve("HEAD"), StandardCharsets.UTF_8).trim();
            if (head.startsWith("ref: ")) {
                return Files.readString(git.resolve(head.substring(5)), StandardCharsets.UTF_8).trim();
            }
            return head;
        } catch (IOException e) {
            return null;
        }
    }

    private synchronized void write(JSONObject line) {
        protocol.println(line.toString());
        protocol.flush();
    }

    /** One request Formplayer makes of HQ, written to the client; HqPeer holds it until the client answers. */
    void askHq(long call, JSONObject request) {
        JSONObject line = new JSONObject();
        line.put("id", current == null ? JSONObject.NULL : current);
        line.put("hq", call);
        line.put("request", request);
        write(line);
    }

    private void serve() throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            JSONObject message;
            try {
                message = new JSONObject(line);
            } catch (RuntimeException e) {
                write(failure(null, "request", e.getClass().getName(),
                        "The runner could not read this line as a JSON object: " + e.getMessage(), null));
                continue;
            }
            if (message.has("hq")) {
                try {
                    peer.answer(message.getLong("hq"), message);
                } catch (RuntimeException e) {
                    write(failure(current, "request", e.getClass().getName(), e.getMessage(), null));
                }
                continue;
            }
            // The reader goes on reading while the request runs, since the request's HQ calls are answered here.
            worker.submit(() -> handle(message));
        }
        protocol.flush();
        Runtime.getRuntime().halt(0);
    }

    private void handle(JSONObject request) {
        Object id = request.opt("id");
        current = id;
        JSONObject response;
        try {
            String op = request.optString("op", null);
            if (op == null || !OPS.contains(op)) {
                throw new RequestException("The request names " + (op == null ? "no op" : "the op \"" + op + "\"")
                        + ". Send one of: " + String.join(", ", OPS) + ".");
            }
            long deadline = request.optLong("deadlineMs", 60_000);
            Object result;
            switch (op) {
                case "http":
                    result = http(request, deadline);
                    break;
                case "clock":
                    ProofClock.set(request.getString("instant"));
                    result = new JSONObject().put("instant", request.getString("instant"));
                    break;
                case "syncTimes":
                    result = syncTimes();
                    break;
                default:
                    result = ageSync(request);
                    break;
            }
            response = new JSONObject().put("id", id == null ? JSONObject.NULL : id).put("ok", true)
                    .put("result", result);
        } catch (HttpTimeoutException e) {
            response = failure(id, "deadline", e.getClass().getName(),
                    "Formplayer did not answer within the request's deadline, so the runner halts; the next request"
                            + " starts a fresh one.", threads());
            response.put("log", captured.take());
            write(response);
            Runtime.getRuntime().halt(DEADLINE_EXIT);
            return;
        } catch (RequestException e) {
            response = failure(id, "request", null, e.getMessage(), null);
        } catch (Throwable e) {
            StringWriter trace = new StringWriter();
            e.printStackTrace(new PrintWriter(trace));
            response = failure(id, "internal", e.getClass().getName(), String.valueOf(e.getMessage()),
                    trace.toString());
        }
        response.put("log", captured.take());
        current = null;
        write(response);
    }

    /**
     * Where every thread of the JVM that is running Formplayer's, Core's or the
     * web server's code stands, for a request that met its deadline: the one
     * thing that says what Formplayer was waiting for.
     */
    private static String threads() {
        StringBuilder found = new StringBuilder();
        for (Map.Entry<Thread, StackTraceElement[]> held : Thread.getAllStackTraces().entrySet()) {
            StackTraceElement[] frames = held.getValue();
            boolean ours = false;
            for (StackTraceElement frame : frames) {
                String name = frame.getClassName();
                if (name.startsWith("org.commcare.") || name.startsWith("org.javarosa.")) {
                    ours = true;
                    break;
                }
            }
            if (!ours) {
                continue;
            }
            found.append(held.getKey().getName()).append(" (").append(held.getKey().getState()).append(")\n");
            int shown = 0;
            for (StackTraceElement frame : frames) {
                if (shown++ == 40) {
                    break;
                }
                found.append("    at ").append(frame).append("\n");
            }
        }
        return found.length() == 0 ? "No thread was in Formplayer's or Core's code." : found.toString();
    }

    private static JSONObject failure(Object id, String kind, String type, String message, String trace) {
        JSONObject error = new JSONObject();
        error.put("kind", kind);
        error.put("message", message);
        if (type != null) {
            error.put("class", type);
        }
        if (trace != null) {
            error.put("trace", trace);
        }
        return new JSONObject().put("id", id == null ? JSONObject.NULL : id).put("ok", false).put("error", error);
    }

    /**
     * One HTTP request to Formplayer's own web server, as a browser or HQ sends
     * it: the method, the path, the headers (the cookies among them) and the
     * body are the client's, and the answer's status, headers and body are
     * Formplayer's. Core's random source is seeded first where the request
     * names a seed, so the ids an app's logic draws while the request runs
     * (uuid(), random()) are the same on every run.
     */
    private JSONObject http(JSONObject request, long deadlineMillis) throws Exception {
        if (request.has("seed")) {
            seedCoreRandomness(request.getLong("seed"));
        }
        byte[] body = request.has("bodyBase64")
                ? Base64.getDecoder().decode(request.getString("bodyBase64"))
                : request.optString("body", "").getBytes(StandardCharsets.UTF_8);
        String method = request.optString("method", "POST");
        HttpRequest.Builder builder = HttpRequest
                .newBuilder(URI.create("http://127.0.0.1:" + Started.port() + request.getString("path")))
                .timeout(Duration.ofMillis(deadlineMillis))
                .method(method, "GET".equals(method) && body.length == 0
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofByteArray(body));
        JSONArray headers = request.optJSONArray("headers");
        if (headers != null) {
            for (int i = 0; i < headers.length(); i++) {
                JSONArray pair = headers.getJSONArray(i);
                builder.header(pair.getString(0), pair.getString(1));
            }
        }
        HttpResponse<byte[]> answer = http.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray());
        JSONObject result = new JSONObject();
        result.put("status", answer.statusCode());
        JSONArray answerHeaders = new JSONArray();
        for (Map.Entry<String, List<String>> header : new TreeMap<>(answer.headers().map()).entrySet()) {
            for (String value : header.getValue()) {
                answerHeaders.put(new JSONArray().put(header.getKey()).put(value));
            }
        }
        result.put("headers", answerHeaders);
        result.put("bodyBase64", Base64.getEncoder().encodeToString(answer.body()));
        return result;
    }

    /** Core's lazily created SecureRandom (MathUtils.getRand) replaced by a seeded Random, as the Core runner does. */
    private static void seedCoreRandomness(long seed) {
        try {
            Field field = MathUtils.class.getDeclaredField("r");
            field.setAccessible(true);
            field.set(null, new Random(seed));
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("The runner could not seed Core's MathUtils random source, so"
                    + " generated ids would differ between runs: " + e, e);
        }
    }

    /**
     * Formplayer's record of when each user last synced: the keys RestoreFactory
     * writes ("last-sync-time:<domain>:<user>:<as user>", setLastSyncTime), read
     * through the same Redis template bean RestoreFactory reads them with.
     */
    private JSONObject syncTimes() {
        RedisTemplate<Object, Object> template = lastSyncTemplate();
        JSONObject times = new JSONObject();
        for (String key : lastSyncKeys(template)) {
            Object value = template.opsForValue().get(key);
            times.put(key, value == null ? JSONObject.NULL : ((Number)value).longValue());
        }
        return times;
    }

    /**
     * Moves one user's last sync back by a number of milliseconds, written as
     * RestoreFactory.setLastSyncTime writes it (the same template, the same
     * ten-day expiry): what a returning user's record holds after that long
     * away, which no run can wait for.
     */
    private JSONObject ageSync(JSONObject request) {
        RedisTemplate<Object, Object> template = lastSyncTemplate();
        String key = request.getString("key");
        Object value = template.opsForValue().get(key);
        if (value == null) {
            throw new RequestException("Formplayer holds no last sync time under \"" + key + "\". It holds: "
                    + lastSyncKeys(template) + ". A user has one after their first restore.");
        }
        long aged = ((Number)value).longValue() - request.getLong("millis");
        template.opsForValue().set(key, aged, 10, TimeUnit.DAYS);
        return new JSONObject().put("key", key).put("was", ((Number)value).longValue()).put("is", aged);
    }

    @SuppressWarnings("unchecked")
    private static RedisTemplate<Object, Object> lastSyncTemplate() {
        ConfigurableApplicationContext context = Started.context();
        return (RedisTemplate<Object, Object>)context.getBean("redisTemplateLong", RedisTemplate.class);
    }

    private static List<String> lastSyncKeys(RedisTemplate<Object, Object> template) {
        RedisSerializer<Object> keys = (RedisSerializer<Object>)template.getKeySerializer();
        Set<byte[]> raw = template.execute((RedisCallback<Set<byte[]>>)connection ->
                connection.keyCommands().keys("*".getBytes(StandardCharsets.UTF_8)));
        List<String> found = new ArrayList<>();
        if (raw != null) {
            for (byte[] key : raw) {
                Object read;
                try {
                    read = keys.deserialize(key);
                } catch (RuntimeException notThisTemplates) {
                    continue;
                }
                if (read instanceof String && ((String)read).startsWith("last-sync-time:")) {
                    found.add((String)read);
                }
            }
        }
        found.sort(String::compareTo);
        return found;
    }

    /** What Formplayer and its libraries wrote since the last response, bounded. */
    private static final class Capture extends OutputStream {
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        private long dropped;

        @Override
        public synchronized void write(int b) {
            if (buffer.size() < LOG_LIMIT) {
                buffer.write(b);
            } else {
                dropped++;
            }
        }

        @Override
        public synchronized void write(byte[] bytes, int offset, int length) {
            int room = Math.max(0, LOG_LIMIT - buffer.size());
            int kept = Math.min(room, length);
            buffer.write(bytes, offset, kept);
            dropped += length - kept;
        }

        synchronized String take() {
            String text = buffer.toString(StandardCharsets.UTF_8);
            if (dropped > 0) {
                text += "\n[" + dropped + " more bytes of output dropped]";
            }
            buffer.reset();
            dropped = 0;
            return text;
        }
    }
}
