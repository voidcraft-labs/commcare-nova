# Data Security & Encryption

## `encrypt-string()` Function Reference

### Signature

```xpath
encrypt-string(message, key, method)
```

| Argument | Type | Description |
|----------|------|-------------|
| `message` | string | Plaintext to encrypt; can be a literal or any XPath expression |
| `key` | string | Base64-encoded 256-bit (32-byte) key (RFC 4648 §4 standard alphabet — not URL-safe variant) |
| `method` | string | Currently only `'AES'` is supported |

**Requires**: CommCare mobile ≥ 2.51. Supported on both Android and Web Apps.

### Usage in a Calculate Expression

```xpath
encrypt-string(/data/case_id, /data/encryption_key, 'AES')
```

The key can be a literal string or referenced from a hidden question. Common pattern: store the key in a lookup table and load it into a hidden question via default value, avoiding hardcoding in the app definition.

Encrypted values can be saved to case properties — they are stored as opaque Base64 strings.

---

## AES-GCM Implementation Details

- **Mode**: AES-GCM (Galois/Counter Mode)
- **Key length**: 256-bit (32 bytes), Base64-encoded for the `key` argument
- **IV**: Randomly generated per encryption call — output is **non-deterministic**
- **Authentication tag**: 16 bytes appended to output

### Output Byte Layout (after Base64 decoding)

```
Byte 0:                IV_LEN (1–255)
Bytes 1..IV_LEN:       Initialization vector
Bytes IV_LEN+1..N-16:  Encrypted message
Bytes N-16..N-1:       16-byte GCM authentication tag
```

Android and Web Apps may produce different IV lengths (typically 12 or 16 bytes). The length-prefix makes the output self-describing and cross-platform compatible.

### Key Generation Requirements

- Must be exactly 256 bits (32 bytes)
- Must be Base64-encoded using standard alphabet (RFC 4648 §4)
- Use a cryptographically secure RNG (e.g., `os.urandom(32)` or `secrets` module) — not `random`
- Wrong key length will fail silently or error — always validate

---

## Security Model

**This is NOT zero-knowledge encryption.** CommCare operates on a shared-secret model — the key exists within the form definition or data accessible to CommCare, so CommCare/Dimagi can decrypt values. `encrypt-string` does not hide data from CommCare itself.

The intended purpose is producing opaque identifiers for **third-party systems** that should not be able to resolve the original value.

---

## Design Patterns

### Valid Use Cases
- Creating a pseudonymous identifier for passing to a third-party system (e.g., analytics/visualization tool) that should not see the original PII
- Cross-system linkage where only your backend holds the decryption key

### Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| Using `encrypt-string` to hide data from CommCare | CommCare holds the key — no privacy benefit against the platform |
| Hardcoding encryption key in app source without access controls | Key exposed to anyone who can download the app definition |
| Expecting identical ciphertext for identical inputs | Output is non-deterministic (random IV each call) — ciphertext differs every time |
| Searching, filtering, or matching on encrypted values | Non-deterministic output means encrypted fields are not queryable, not filterable, and cannot be used for deduplication or case matching |
| Testing on only mobile or only Web Apps | Android and Web Apps use different underlying crypto libraries; output format is compatible but must be validated against both |

---

## Key Constraints Summary

1. **Non-deterministic output**: Same plaintext + same key → different ciphertext each time. Cannot use for dedup, case search, or case matching.
2. **Key format**: Must be Base64 standard alphabet, exactly 256 bits. No URL-safe variant.
3. **Cross-platform**: Android and Web Apps produce structurally identical output but use different crypto implementations — test both before production.
4. **Data export**: Exported encrypted values remain as ciphertext. Exports do not decrypt.
5. **Lookup tables**: Can distribute encryption keys to forms without hardcoding in question defaults.