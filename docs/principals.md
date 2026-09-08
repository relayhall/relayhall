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
2. **Name it.** A handle, a display name and a role, each role carrying one line
   of what it is for. A Service must also declare a **purpose**: what the
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

My connections is the same wizard with the kind preset to Agent: it is your own
filtered view of the identities you own and their credentials. Use Identities
when the identity is not your own connection — a service account, a colleague,
an agent that belongs to somebody else — and to disable identities.

Both acts are audited separately: the identity is created, and the credential is
minted, exactly as they were before they shared a screen.

## Change a role

Roles are assigned at creation and changed afterwards with one act:

```bash
relayhall principal role casey editor
```

The same act is on the Access manager's **Roles** section. It is bounded in four
ways, and the same bounds apply on every surface:

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
