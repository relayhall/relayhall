# Security policy

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, personal
data, or an unpatched proof of concept.

For the public GitHub repository, use **Security → Report a vulnerability** to
open a private security advisory. Include:

- affected release or exact commit;
- deployment assumptions and required privileges;
- reproducible impact with secrets and personal data removed;
- suggested mitigation, if known;
- whether active exploitation is suspected.

If private advisories are temporarily unavailable, contact a repository owner
through an already trusted private channel and ask for a secure reporting path.
Do not send sensitive details through an unverified address or public chat.

## Scope

Security reports may cover the core backend/frontend, bundled CLI, default
Compose deployment, migration/backup tooling, authentication/authorization,
plugin proxy boundary, and published release pipeline.

Deployment-owned ingress, external harnesses, plugins, model gateways, artifact
stores, and identity providers are separate systems unless the defect is caused
by RelayHall's integration contract.

## Handling

Maintainers will acknowledge receipt, establish impact and affected versions,
coordinate a fix and release, and credit reporters when requested and safe.
No response-time or bounty promise is made by this volunteer project.

Never include live tokens, database dumps, private hostnames, or third-party
personal data in a report. Use minimal synthetic evidence.
