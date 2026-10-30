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

## Manual bundled-dependency risk acceptance (not a Trivy exception)

This time-limited approval records a manually verified vulnerable copy embedded
inside a published dependency bundle. It is not a Trivy exception, does not
alter scanner configuration or CI policy, and does not apply to any future
scanner finding.

- **Advisories:** [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7)
  and [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr)
- **Affected artifact:** Mermaid 12.2.0's
  `dist/chunks/mermaid.esm.min/chunk-FWWDAFD2.mjs`, which embeds DOMPurify
  3.4.12.
- **Owner and renewal authority:** `mkronvold-wtg`; any renewal requires new,
  explicit approval before expiry. There is no automatic renewal.
- **At expiry:** This approval ends. Replace Mermaid with a bundle embedding
  patched DOMPurify and remove this record, or obtain fresh explicit approval
  before expiry.
- **Approval evidence:** Explicit user approval in coordinator session
  `8e0e7987-6bc7-4e91-bf38-5748de9b156f` at `2026-10-30T16:11:52Z`.
- **Approved at:** `2026-10-30T16:11:52Z`.
- **Expires at:** `2026-11-29T16:11:52Z`.
- **Compensating controls and limitations:** Keep Mermaid's
  `securityLevel: "strict"` and all existing application sanitization
  unchanged. These controls reduce exposure; they do not prove exploitation is
  impossible or remove the underlying vulnerability.

A CI-built image has no registry manifest because this repository does not
publish images. For image exceptions, `Image digest` is the immutable
`docker image inspect .Id` content digest captured by the workflow, not a
mutable tag or a claim that registry publishing is active.

<!-- EXCEPTION-REGISTER-START -->
| Exception ID | Finding ID | Scanner | Target | Package | Installed version | Image digest | Owner | Rationale | Compensating control | Expires at (UTC) | Renewal authority | Renewal by (UTC) | Renewal evidence | Approval evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
<!-- EXCEPTION-REGISTER-END -->
