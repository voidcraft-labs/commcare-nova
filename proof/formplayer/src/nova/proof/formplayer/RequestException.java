package nova.proof.formplayer;

/** A request the runner refuses because of what it asks, with a message for the person who sent it. */
final class RequestException extends RuntimeException {
    RequestException(String message) {
        super(message);
    }
}
