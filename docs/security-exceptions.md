# Security Exception Register

`security/trivy-exceptions.json` is the executable exception configuration.
This register is its mandatory, human-readable mirror. The validator rejects a
change when either record is malformed, expired, broad, or divergent.

No Trivy exceptions are approved initially. Do not add a speculative exception
for a low/medium finding or for a finding that has not been captured in scanner
evidence.

## Exception lifecycle

1. Capture the unmodified Trivy JSON evidence and identify the exact finding,
   scanner target, package, installed version, and (for image findings) Docker
   image content digest.
2. Obtain accountable approval. Add one scoped object to the machine file and
   exactly one matching row below. Every scope is exact: wildcards, directories,
   package families, mutable tags, and broad image references are rejected.
3. Supply an owner, risk rationale, concrete compensating control, approval
   evidence, and renewal authority/evidence. `renewalBy` must be at or before
   `expiresAt`; both are future UTC instants.
4. Run `npm run security:exceptions`. CI reruns it before scanning and compares
   each high/critical finding against the same exact scope. Remove the records
   when remediation is complete. Expiry blocks the scan; renewal must be a new,
   documented approval before expiry.

A CI-built image has no registry manifest because this repository does not
publish images. For image exceptions, `Image digest` is the immutable
`docker image inspect .Id` content digest captured by the workflow, not a
mutable tag or a claim that registry publishing is active.

<!-- EXCEPTION-REGISTER-START -->
| Exception ID | Finding ID | Scanner | Target | Package | Installed version | Image digest | Owner | Rationale | Compensating control | Expires at (UTC) | Renewal authority | Renewal by (UTC) | Renewal evidence | Approval evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
<!-- EXCEPTION-REGISTER-END -->
