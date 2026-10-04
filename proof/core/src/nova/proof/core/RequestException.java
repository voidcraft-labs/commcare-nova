package nova.proof.core;

/**
 * A request the runner cannot carry out as sent: a missing argument, an unknown
 * app handle, an unreadable file. Its message tells the caller what to change.
 */
final class RequestException extends RuntimeException {
    RequestException(String message) {
        super(message);
    }
}
