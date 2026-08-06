# Security Exception Register

No security exceptions are approved in Phase 0.

This register is a non-invasive record format for a later, explicitly approved
exception. It does not configure a scanner, suppress a finding, or change
runtime behavior. Do not create an entry until an accountable owner approves
it.

## Required fields for each exception

| Field | Required content |
| --- | --- |
| Identifier | Stable tracking identifier. |
| Scope | Exact affected image digest, lockfile finding, repository path, environment, or control. |
| Owner | Named accountable team or role responsible for remediation and renewal. |
| Rationale | Why the exception is necessary and why remediation cannot happen immediately. |
| Compensating control | Concrete temporary safeguard and the person or system that operates it. |
| Expiry | Date and time when the exception stops applying. |
| Renewal | Approval authority, renewal deadline, and evidence required to renew. |
| Evidence | Link or immutable reference to the finding, risk review, and approval record. |
| Status | Proposed, approved, expired, revoked, or remediated. |

An expired exception is not approval for continued operation. The owner must
remediate the scope or obtain a documented renewal before expiry.
