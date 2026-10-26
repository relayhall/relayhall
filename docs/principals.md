# Principals

Principals are identities RelayHall can attribute work to: people, agents, and
services. They are separate from personalities, which are reusable instruction
templates.

## The first administrator

A fresh deployment has no administrator account. Creating identities and
assigning roles both require one, so the very first administrator cannot be
created by any ordinary act — that is what the **first-run step** is for.

While no active, parentless, human account holds the `admin` or `operator` role,
the login page offers to create one. It asks for an account name, a display name
and a password; it creates that person with the `admin` role and their own
password credential, signs them in, and records `first_run.administrator_created`
in the audit ledger. The account, its password and that ledger entry are written
in a single transaction, so the step can never leave a deployment holding an
administrator nobody can sign in as. A second attempt is refused: the step exists
exactly while the state does.

The deployment password (`DASHBOARD_PASSWORD_HASH`) is **break-glass** and stays
that way. It is permanent by design — no identity-provider configuration can
disable it — and it is there for lockouts, not for daily work. Using it while an
administrator account exists is audited and announced on the dashboard.

The server **refuses to start without its deployment identity**. Before the API
opens its listener it resolves the named local administrator, the account the
break-glass password signs in: the handle `RELAYHALL_LOCAL_ADMIN_HANDLE` names,
or the seeded `dashboard_user` when that variable is unset or empty. It requires
the handle to be well formed, an account to hold it, and that account to be
active, a human account with no parent, and to carry the root sentinel through
the role sign-in derives for it (`admin` or `orchestrator`). If any of these fails, the process exits
with status 1 after one log line, `[DeploymentIdentity] refusing to serve`,
naming the failed condition by code — for example
`LOCAL_ADMINISTRATOR_ACCOUNT_MISSING` — and never a password hash, a secret or
the raw configured value. Boot-check mode, which has no database, checks only
that the handle is well formed. Once the identity resolves nothing about sign-in
changes: the break-glass login, its fallback to the seeded account and the role
and password rules below behave as before.

### With single sign-on

Two paths, and both start with an administrator that exists before anyone
federates:

1. **First-run, then SSO.** Complete the first-run step, then configure the
   Identity provider from the Access manager. People signing in through it are
   created as `user`; an administrator raises anyone who needs more with the role
   act below.
2. **Invited mode.** Complete the first-run step, pre-create the accounts you
   expect, and issue each an invitation bound to its account. The invitation
   binds the federated identity to the account you already made, so the role you
   set survives their first sign-in.

There is no supported path that edits the database directly, and none is needed.

## Create an identity

There is one flow, and it is the **Create identity** button on the Identities
page. It asks four things in order:

1. **What are you creating?** A *Human* who signs in, a *Service* that acts on
   its own, or an *Agent* — an agent, editor or script connected to the board.
2. **Name it.** A handle, a display name and a role. The role selector offers
   the roles meant for the kind you chose that your session may assign, and
   under it shows the chosen role's entry from the role catalogue: its purpose,
   what it may reach, what it never reaches and who it is meant for (the same
   text as [roles.md](roles.md)). A Service must also declare a **purpose**: what the
   service is for. That is a rule of the substrate, not of the form — a service
   Account with no purpose is refused with `422 PURPOSE_REQUIRED` (A17.1).
3. **Access.** Optionally mint a credential in the same act. What that means
   differs by kind, because the three kinds are different shapes:
   - a **Human** gets no key at all. Accounts are keyless: people sign in with a
     password or an invitation (see *Give somebody a password* below);
   - a **Service** Account is keyless too, and acts through a *connection*
     registered under it. Ticking *Mint a credential now* registers that
     connection and issues its credential, pinned to REST/CLI or to MCP;
   - an **Agent** *is* a connection — the same act as **Connect an agent** on
     My connections, and the same wizard. `POST /principals` refuses
     `kind=agent` outright (`422 AGENT_MINT_ONLY`): agent identities arrive
     through the delegation machinery, never through a directory form.
4. **Done.** A credential, when one was minted, is shown **once** — on this
   screen and nowhere else, in a tab per harness (Claude Code, Codex, generic
   MCP, CLI). It is not stored on the board and cannot be re-read.

### Create identity or My connections?

Neither is legacy; they answer different questions.

- **My connections** is for *your own* agents. It is the same wizard with the
  kind preset to Agent: the connection belongs to you, acts inside your own
  authority, and its credential is minted in the same act. It is also your own
  filtered view of the identities you own and their credentials.
- **Create identity** on the Identities page is the administrator's act for an
  identity that is *not* your own connection: a service account (a CI bot, a
  Connector, an integration), a colleague when no identity provider is
  configured, or an agent that belongs to somebody else. It is also where
  identities are disabled.

Choosing *Agent* in Create identity says so: for your own agent, My connections
is the same act. For somebody else's agent, create their identity and let them
connect it from their own My connections. Credentials stay separately scoped
and revocable whichever door made the identity.

Both acts are audited separately: the identity is created, and the credential is
minted, exactly as they were before they shared a screen.

`POST /principals` commits its `principal.create` audit row with the Account
write, recording only its kind, handle and role. `PATCH /principals/:id`
commits `principal.update` with changed field names and, for a status change,
the previous and resulting status. A disable also revokes the principal's stored
login sessions and lapses the pending requests naming it as grantee, in the same
transaction, and records `sessionsRevoked` and `lapsedApprovalIds`; an approved
`identity.status` change request runs the same seam. Display names and purpose text are omitted.
Both use the request's resolved actor and authentication evidence. Audit-write
failure rolls back the Account change; read caches publish only after commit.
Other identity-provider, first-run and role-management writers keep their
existing behavior and audit contracts.

## Open an identity

Every row on the **Identities** page opens that identity's own page
(`/settings/principals?identity=<id>`, behind the same Identities entry). It
shows, read-only:

- its directory facts: handle, display name, kind, status, the identity it
  belongs to, harness, provenance, when it was last seen, and its id;
- its role, explained by the role catalogue entry ([roles.md](roles.md));
- the identities under it — an Account's Connectors, or a Connector's Agents —
  each with its credentials, their scopes, transport and state;
- its own credentials (an Account holds none: Accounts are keyless);
- the grant rows that name it, the Warrants it holds, and the newest ten audit
  rows about it or by it, with a link into the audit log filtered to it.

Every fact comes from a route that already exists: the directory row from
`GET /principals`, then `GET /principals/{id}/credentials` (for it and for each
identity under it), `GET /principals/{id}/grants`, `GET /warrants` (narrowed to
the Warrants it holds) and `GET /audit` with `resourceType=principal&resourceId`
and with `actorPrincipalId`. The board decides each read for your session, and a
refused one says so in its own section without hiding the others. Some facts
have no read route, so the page does not show them: there is no single-identity
read (`GET /principals/{id}`), a principal's creation time and a service's
declared purpose are not in the public principal shape, and authority that
reaches an identity through a Group or an access profile is on the Access
manager's granted-access inventory rather than in its grant rows.

For an administrator the page also carries the role change (below) as an action
on the identity itself. It is offered on the same identities and bounded by the
same rule as the Access manager's **Roles** section, which stays the bulk view.

## Change a role

Roles are assigned at creation and changed afterwards with one act (a person
without that authority files an `identity.role` change request instead, for its own
role up to an editor-class one, and an administrator decides it on the approvals
hub with step-up; the decision runs the same act, with the decider as the issuer):

```bash
relayhall principal role casey editor
```

The same act is on the Access manager's **Roles** section, which lists every
role's catalogue entry ([roles.md](roles.md)), and on each identity's own page
(**Identities**, open a row). Both show the chosen role's entry under the
selector and ask for confirmation with that entry before they change anything.
The act asks for no step-up today; if the board ever answers it with the
step-up challenge, the dashboard asks you to confirm it is you once for exactly
that identity and repeats the request. It is bounded in four ways, and the same
bounds apply on every surface:

- it is a **login-session act**: it is performed with the credential
  `relayhall login` caches or with a dashboard session, never with an `rh_` API
  key — a bearer credential that could hand out roles would be privilege
  escalation in one hop;
- the caller must be an administrator, and may assign **at most their own
  authority**: only an `admin` assigns `admin` or `orchestrator`;
- it refuses the caller's own row, the internal `system` actor, and the named
  local administrator, whose role is fixed so the deployment always has a way
  back in;
- an elevated role (`admin`, `operator`, `orchestrator`) may only be given to a
  parentless human account — never to a service or agent identity, which hold
  API keys.

Every attempt is audited with the actor, the target and the before and after
roles — refusals included. A role change takes effect on that account's **next
request**; nobody has to sign in again.

## Give somebody a password

A second person needs a way to sign in. With an Identity provider configured they
sign in through it; without one — which is what a fresh installation has — an
administrator sets their password and tells them what it is:

```bash
relayhall principal set-password grace
```

The command prompts twice and never takes the password as an argument, because an
argument reaches shell history and every process listing on the machine. Pipe one
in with `--stdin` when a script has to. The same act is on the Access manager's
**Passwords** section.

It is bounded the same way the role act is, and by the same rules:

- it is a **login-session act**: performed with the credential `relayhall login`
  caches or with a dashboard session, never with an `rh_` bearer credential — a
  machine credential that could give a person a password could manufacture a
  human identity for whoever holds it;
- the caller must be an administrator, and may reach only accounts whose role
  they could assign themselves: an operator can give a colleague a way in, and
  cannot give one to an administrator;
- it refuses the internal `system` actor and the named local administrator, whose
  password is the deployment's way back in and is not set from here;
- only human accounts hold a password. Services act through their connectors and
  agents through the delegation machinery; neither has a sign-in page to reach.

The board owns the password policy — a minimum length, and a maximum the hashing
imposes — and refuses a value it will not take by name, so both surfaces report
the board's own reason rather than guessing at one.

Every attempt is audited, refusals included. **Setting a password does not sign
that account out of anywhere it is already signed in**; the reply says so, because
the assumption goes both ways and somebody replacing a password they believe is
known to another person needs to know which way it went. To end those sessions,
disable the account.

The same act clears a password (`DELETE` on the same route), under the same
bounds: taking a way in away is at least as consequential as granting one.

## Clean-install directory

A new installation exposes only its bootstrap dashboard owner. RelayHall keeps
several historical compatibility identities in the database so old attribution
and foreign keys remain valid, but they are disabled and hidden from the normal
directory.

A compatibility identity becomes visible only when its matching legacy
environment credential is configured. Removing that credential disables and
hides the identity again. Administrators can request hidden rows with
`GET /principals?includeHidden=true`; their private metadata is never returned.

The dashboard shows safe provenance labels:

- `bootstrap` — installation owner;
- `managed` — created through RelayHall;
- `environment` — activated by an explicitly configured compatibility credential.

## Manage principals

**Termination and Group roles.** Terminating an Account never removes its
Group roles (`owner` or `manager`, LENSES-c c1-A). The rows stay, **inert**
from the moment of termination — they confer nothing and read
`principal_inactive` in `GET /groups/{id}/stewards` — and they never become live
again. A root login session removes them with
`DELETE /groups/{id}/stewards/{principalId}`; until it does, deleting the Group
is refused `GROUP_HAS_STEWARDS`. Promotion to `admin`, `operator` or
`orchestrator` likewise makes a role row inert (an elevated Account cannot hold
one), and a demotion makes it live again.

Use the **Identities** dashboard page (**Create identity**, above) or the
primary CLI:

> CLI setup (run from the repository, no install step): `./cli/relayhall`,
> `--api`/`RELAYHALL_API_URL` for the endpoint, `relayhall login` once to cache
> a token — see the README's "Using an external harness" section.

```bash
relayhall principals
relayhall principal create service-bot --kind service --display-name "Service Bot" --role agent \
  --purpose "Files nightly build reports."
relayhall principal update service-bot --status disabled
```

`--purpose` is not optional for a service: the board refuses a service
Account that declares none (`422 PURPOSE_REQUIRED`, A17.1), and the verb
refuses it before the request. `--kind agent` is refused for the same
reason the dashboard form does not offer it: agent identities arrive through
the delegation machinery, so connect the agent instead.

**Group principals.** Every Group is also a principal of kind `group` with the
Group's id and the handle `group:<id>` (AZ-A12). It never signs in, holds no
credential and never acts. It is not listed by `relayhall principals`, the
**Identities** page, `GET /principals` or `relayhall_principal_list` unless you
ask for `kind=group` on the REST route, and it is managed only through
`/groups`: every `/principals/{id}` change refuses it with
`GROUP_PRINCIPAL_MANAGED_BY_GROUPS`. Handles starting `group:` are reserved for
it. A Project's owner, or a Task's or Report's account owner, may name a Group:
its members then read and use the object and its live owners and managers edit
it, never with `admin`, Shepherd or Verifier authority ([authorization,
Group ownership](authorization.md)). See [the Groups section of the API
reference](api.md).

MCP provides `relayhall_principal_list` and `relayhall_principal_whoami`, both
read-only. Principal creation and update were removed from the MCP surface at
the Phase-3 re-scope: a credential that can mint identities is privilege
escalation in one hop, so identity mutation stays on the dashboard, CLI and
REST. All four surfaces use the same REST authorization contract. Creating or
changing an identity requires management authority; reading the configured
directory requires ordinary authenticated read access.

Credentials are managed separately. Disabling a principal immediately prevents
its scoped API credentials from authenticating, without deleting attribution
history.
