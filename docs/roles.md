# Account roles

<!-- Generated from backend/src/utils/roleCatalogue.ts by `npm --prefix backend run docs:roles`.
     Do not edit by hand: backend/src/__tests__/roleCatalogueDoc.test.ts fails when this page
     and the catalogue differ. -->

Every Account carries one role. The role sets a scope ceiling: the most the
Account may reach. It never grants an object by itself; ownership, grants,
Task assignments, credential scopes and delegation limits still apply. Choose
the least powerful role that fits the work.

This table is the role catalogue the board serves at `GET /principals/roles`
(`principals:read`). The dashboard shows the same text under every role
selector: the Access manager's Roles section, the role-change confirmation and
Create identity.

| Role | Purpose | May reach | Never reaches | Meant for | Assigned by |
| --- | --- | --- | --- | --- | --- |
| `admin` | Administers the whole deployment: settings, identities, credentials and every role. | Everything: it holds root, which satisfies every scope check, owner-plane routes included. | No scope is out of reach; root itself is never put on a bearer credential, so keys stay below it. | Meant for humans. | Assigned by admin. |
| `operator` | Administers product objects and ordinary Accounts, without the owner plane. | Every read, use, write, invoke and admin scope (all 35 scopes below root). | Root, so no owner-plane route. | Meant for humans. | Assigned by admin, operator or orchestrator. |
| `editor` | Creates and changes the objects the Account is permitted to work on. | Every read, use, write and invoke scope (26 of the 35 scopes below root). | Root, so no owner-plane route and no admin scope. | Meant for humans. | Assigned by admin, operator or orchestrator. |
| `user` | Everyday work on the objects the Account is permitted to work on. | Every read, use, write and invoke scope (26 of the 35 scopes below root). | Root, so no owner-plane route and no admin scope. | Meant for humans. | Assigned by admin, operator or orchestrator. |
| `viewer` | Reads permitted objects without changing them: observers and read-only integrations. | Every read scope (12 of the 35 scopes below root). | Root, so no owner-plane route and no use, write, invoke or admin scope. | Meant for humans and services. | Assigned by admin, operator or orchestrator. |
| `orchestrator` | Coordinates the board and its automation from a person’s Account. | Everything: it holds root, which satisfies every scope check, owner-plane routes included. | No scope is out of reach; root itself is never put on a bearer credential, so keys stay below it. | Meant for humans. | Assigned by admin. |
| `reviewer` | Checks other identities’ work and records evidence; the Task’s Verifier assignment still decides who verifies. | Every read, use, write and invoke scope (26 of the 35 scopes below root). | Root, so no owner-plane route and no admin scope. | Meant for humans, services and agents. | Assigned by admin, operator or orchestrator. |
| `qa` | Runs quality checks and records test evidence under the same Task verification rules. | Every read, use, write and invoke scope (26 of the 35 scopes below root). | Root, so no owner-plane route and no admin scope. | Meant for services and agents. | Assigned by admin, operator or orchestrator. |
| `agent` | Automation that performs assigned work inside its credential and delegation limits. | Every read, use, write and invoke scope (26 of the 35 scopes below root). | Root, so no owner-plane route and no admin scope. | Meant for services and agents. | Assigned by admin, operator or orchestrator. |

## Roles that share a ceiling

Roles with the same ceiling differ in intended use, not in reach.

- `admin`, `orchestrator`
- `editor`, `user`, `reviewer`, `qa`, `agent`

## Elevated roles

`admin`, `operator` and `orchestrator` derive administrative authority. They belong only to a
parentless human Account: the role change refuses them on a service or an agent
identity (`ELEVATED_ROLE_REQUIRES_ACCOUNT`).
