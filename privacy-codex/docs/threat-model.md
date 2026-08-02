# POC threat model

## Protected assets

- Original query and document text.
- Detected values and normalized forms.
- Reversible token mappings.
- Restored model output.
- Private-gateway access credentials.

## Trust boundary

The local process, its approved local classifier, and the optional encrypted
artifact vault are trusted. Codex and the configured private
OpenAI-compatible gateway receive only the final prompt selected by policy. In
explicitly authorized synthetic baseline evaluation, Codex receives the
synthetic original by design.

## Defenses

- Prompt values travel over stdin and never appear in Codex argv.
- The Codex child receives a narrowly constructed environment and an
  invocation-scoped credential.
- An explicit private-gateway model provider reads the token from the child
  environment; user authentication state is not mounted or copied.
- Direct vendor endpoints are rejected.
- User configuration/rules are ignored; all capabilities enabled by pinned
  Codex CLI 0.131.0, web search, MCP servers, hooks, apps, and update checks are
  explicitly disabled.
- Codex runs in a fresh, private, read-only, ephemeral workspace.
- Original files are not staged or named in the prompt.
- Documents are delimited as untrusted data and embedded instructions are
  explicitly ignored.
- Critical classes block before process creation.
- Classifier absence, error, or timeout fails closed in live mode.
- Every detector executes in its own persistent local process. Detection is
  concurrent; a failed or timed-out worker is terminated, forcibly killed when
  necessary, reaped, and restarted only on a later request.
- Token IDs use secure randomness and contain no original-derived hash.
- Only exact current-run tokens are restored; mutation or unknown tokens are
  flagged and left redacted.
- Newly generated sensitive-looking output is masked before restoration.
- Semantic escape encodings, Unicode format controls, and NFKC confusables that
  can conceal sensitive text fail closed.
- Safe artifacts reject labelled originals, normalized forms, credential
  shapes, and valid card candidates.
- Codex streams, final output, JSONL line count, and JSONL line size are bounded.
- Raw artifacts require opt-in AES-256-GCM and a 32-byte external key.
- Process-group termination covers timed-out Codex descendants.

## Residual risks

- Any detector can miss out-of-distribution or adversarial PII.
- A host process with sufficient privileges can inspect local memory.
- A read-only sandbox is not a complete container boundary.
- V1 process-tree containment and timeout guarantees are POSIX-only.
- Dependency or model supply-chain compromise remains possible without a
  privately audited artifact mirror and digest governance.
- Model output can mutate tokens or infer facts from residual context, reducing
  utility or privacy.
- Synthetic accuracy can substantially overstate production performance.
- The optional rules-only mode does not provide the required contextual model.

Before production, run the wrapper in a network-denied detector container or
same-pod sidecar, allow outbound traffic for Codex only to the configured
private OpenAI-compatible gateway, use an approved secret provider, disable
crash dumps/telemetry, and validate against an independently labelled
travel-support corpus for a fictional travel company.
