# OAuth 2.1 — the Tier B front door

RelayHall runs an OAuth 2.1 authorization server so interactive board clients
that cannot carry a static bearer credential — ChatGPT developer mode,
Antigravity and their kin — can reach the MCP surface as a real person, with
that person's authority and no more.

If your client *can* carry a header, you do not want this page. Use a principal
credential and [mcp.md](mcp.md); that is Tier A, and it is simpler.

## What this server is

| | |
|---|---|
| Grant | `authorization_code` — and only that one |
| PKCE | **required**, `S256` only |
| Client identity | a **Client ID Metadata Document**: an https URL your client controls |
| Client registration | none — there is no DCR endpoint, and none is planned |
| Client secrets | none — every client here is a public client |
| Refresh tokens | none in this release (see [Lifetime](#lifetime)) |
| Access token | an opaque RelayHall reference credential, looked up on every call |
| Revocation | RFC 7009, and it takes effect on the **very next call** |

## Discovery

Start where every MCP client starts: call the MCP endpoint without a
credential. It answers `401` with a challenge that names its
protected-resource metadata:

```
WWW-Authenticate: Bearer realm="relayhall-mcp", error="invalid_token",
  resource_metadata="https://<your-board>/api/.well-known/oauth-protected-resource"
```

Fetch that document. It names the resource and its authorization server:

```json
{
  "resource": "https://<your-board>/api/mcp",
  "authorization_servers": ["https://<your-board>/api"],
  "scopes_supported": ["tasks:read", "..."],
  "bearer_methods_supported": ["header"]
}
```

Then fetch `https://<your-board>/api/.well-known/oauth-authorization-server`
for the endpoints.

Both documents live under the board's API prefix rather than at the origin
root, because the deployment's ingress owns the origin root and strips the
prefix before the board sees a request. Nothing in the chain infers a path:
every step follows an absolute URL published by the step before it, which is
what RFC 9728 §5.1 and RFC 8414 both provide for.

## Registering — you do not

Your `client_id` **is** an https URL you control, and that URL serves your
client's metadata document:

```json
{
  "client_id": "https://your-app.example.com/.well-known/oauth-client",
  "client_name": "Your App",
  "client_uri": "https://your-app.example.com",
  "redirect_uris": ["https://your-app.example.com/oauth/callback"]
}
```

The document must name **its own URL** as `client_id` — that self-reference is
what makes the URL an identity — and must list at least one usable
`redirect_uris` entry.

RelayHall re-fetches and re-validates this document on **every** authorization
request. It is never cached for a decision: a cached redirect list is a stale
allowlist, and a stale allowlist is an open redirector.

### What the board will and will not fetch

The document fetch is an outbound request to a URL an unauthenticated caller
named, so it is bounded hard. Your document must be served:

- over **https**, on **port 443**, from a **host name** (never an IP literal);
- from a name that resolves only to **public** addresses — loopback, private,
  link-local (including `169.254.169.254`), CGNAT, multicast and reserved
  ranges are all refused, in IPv4 and IPv6, including IPv4-mapped forms;
- **directly**, with no redirect — a `3xx` is a refusal, not a hop;
- as `application/json`, in at most **64 KiB**, within **5 seconds**.

The connection is pinned to the address that was validated, so a name that
answers differently a moment later cannot move the fetch.

### Redirect URIs

`https` anywhere, or `http` on the loopback **literals** `127.0.0.1` / `[::1]`
for a native client on an ephemeral port. Not `http://localhost` — a name can
be made to resolve elsewhere. No fragments, no userinfo.

The match at `/authorize` is an **exact string comparison** against the
document you just served. OAuth 2.1 removed prefix and substring matching, and
so has this server.

## The flow

**1 — send the person to `/oauth/authorize`:**

```
GET https://<your-board>/api/oauth/authorize
  ?response_type=code
  &client_id=https%3A%2F%2Fyour-app.example.com%2F.well-known%2Foauth-client
  &redirect_uri=https%3A%2F%2Fyour-app.example.com%2Foauth%2Fcallback
  &scope=principals%3Aread%20tasks%3Aread%20tasks%3Awrite%20reports%3Awrite
  &state=<your opaque value>
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
  &resource=https%3A%2F%2F<your-board>%2Fapi%2Fmcp
```

`scope` is required: an access token with no authority is never issued. The
`resource` indicator is optional; if you send one it must be this board's MCP
endpoint, because that is the only resource this server issues tokens for.

**Ask for `principals:read`.** The bootstrap call compiles your SESSION brief,
which is a principals-plane read — and until a credential has bootstrapped,
every tool that changes board state is refused. A token without
`principals:read` can read, but it can never bootstrap and therefore can never
write.

The board validates the request, then sends the browser to its own consent
page. The person signs in if they are not signed in already, reads what your
client is asking for, and approves — possibly approving **less** than you
asked for.

**2 — the browser comes back to your `redirect_uri`** with `code` and your
`state`, or with `error` and `error_description`.

**3 — exchange the code:**

```
POST https://<your-board>/api/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<the code>
&client_id=<your client_id URL>
&redirect_uri=<the same redirect_uri>
&code_verifier=<the verifier>
```

```json
{
  "access_token": "rh_live_<keyId>.<secret>",
  "token_type": "Bearer",
  "expires_in": 43200,
  "scope": "tasks:read tasks:write reports:write"
}
```

The code lives about a minute and is **consumed by the first exchange attempt,
whether or not that attempt succeeds**. A wrong verifier does not leave the
code available to try again — so there is no online guessing of the verifier,
and a legitimate client, which sends the right one the first time, never
notices. A replay, a mismatched `redirect_uri`, a mismatched `client_id`, a
wrong verifier and an already-spent code all answer the same `invalid_grant`:
telling them apart would confirm which codes exist.

**4 — call the MCP endpoint** with `Authorization: Bearer <access_token>`, and
bootstrap exactly as any other client does — `relayhall_brief_compile` with
`session: true`. See [mcp.md](mcp.md).

Two things will surprise you if nobody says them:

- **Scope is not object authority.** A freshly authorized client is a new
  Connector under the person's Account. It holds the scopes they approved,
  which get it to the right routes — and no grants on anybody's existing
  Tasks, Projects or Reports, so listings come back empty until someone grants
  it something, or until it creates objects of its own.
- **Its authority is intersected with the person's on every call.** If they
  are later demoted or disabled, the token narrows or dies with them, with
  nothing to revoke.

## What the token is

Not a JWT. The access token is an ordinary RelayHall reference credential, and
that is the point:

- **Revocation is real.** The board looks the token up on every single call, so
  `POST /oauth/revoke` refuses the very next one. There is no cache to wait out
  and no epoch to propagate.
- **It only works on MCP.** The token is pinned to the MCP transport class and
  is refused with `TRANSPORT_MISMATCH` on every REST route — audience
  restriction as a behaviour, not as a claim inside a token.
- **It can never outrank the person.** The token belongs to a Connector held
  under the consenting person's Account, and its authority is intersected with
  that person's own on every call. Demote or disable the person and the token
  narrows or dies with them, immediately, with nothing to revoke.
- **It carries only ratified scopes**, never `root`.

## Lifetime

An access token lasts 12 hours by default; a deployment may set
`RELAYHALL_OAUTH_ACCESS_TOKEN_TTL_HOURS` to anything from 1 hour to 30 days,
and an out-of-range value falls back to the default.

There is **no refresh-token grant** in this release. A Tier-B client is
human-driven by definition — the tier exists for clients with no shell and no
scheduler — so re-authorizing is a click by someone who is already there,
rather than a long-lived credential sitting in a client that cannot be
revoked one grant at a time.

## Revoking

```
POST https://<your-board>/api/oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=<the access token>
```

Always `200`, whether or not the token existed (RFC 7009 §2.2) — so this
endpoint cannot be used to discover which tokens are real. A person can also
disable the Connector the token belongs to, which kills every token issued to
that client for them.

## Errors

Refusals use the RFC 6749 §5.2 shape:

```json
{ "error": "invalid_grant", "error_description": "the authorization code is not valid" }
```

An error is only reported by redirecting to your `redirect_uri` **after** that
URI has been matched against your metadata document. Anything that fails before
that — an unfetchable `client_id`, a redirect URI the document does not
declare — is answered to the browser directly. A server that redirected before
validating would be an open redirector.
