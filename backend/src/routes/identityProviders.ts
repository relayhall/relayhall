/**
 * routes/identityProviders — the owner-plane surface for the Identity provider
 * (vocabulary A23.1, A23.8; design `d95136d7` §3.2, §4.1; SS-3; owner ruling D4).
 *
 * ── ROOT, AND NO SCOPE FAMILY ──
 *
 * SS-3: this router is gated at `root` and MINTS NO SCOPE, exactly as
 * `/notification-endpoints` is (`scopeMap.ts`) and as `/groups` mutation is.
 * A17.8 ruled that family "permanently root... that IS its ratified home, not a
 * parking"; this follows the same precedent rather than minting an
 * `identity-providers:admin` family nobody asked for. A23.6 says the same thing
 * from the vocabulary side: no new scope family and no new wire event — SSO acts
 * are recorded in the AUDIT LEDGER, which is their ratified home.
 *
 * ── WHAT THIS SURFACE WILL NOT DO ──
 *
 * It never returns a client secret or a client private key. Not redacted, not
 * once, not to `root`. SS-7: "Reveal is never offered — an operator who loses
 * the client secret rotates it at the Identity provider, not by reading it back
 * from the board." The service's return type has no field for either, so this
 * router could not leak one by serialising the whole object.
 */
import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import type { AuthRequest } from '../middleware/auth';
import { logCaughtFailure } from '../utils/secretSafeLog';
import {
  IdentityProviderError,
  identityProviderService,
  type ClientAuthMethod,
  type GroupBindingMode,
  type ProviderStatus,
  type ProvisioningMode,
} from '../services/identity/IdentityProviderService';
import { ssoInvitationService } from '../services/identity/SsoInvitationService';
import { identityLinkService } from '../services/identity/IdentityLinkService';
import { ssoDiscoveryService } from '../services/identity/SsoDiscoveryService';
import { SsoDiscoveryError } from '../services/identity/SsoDiscoveryService';
import { SsoOutboundError } from '../services/identity/ssoOutbound';

const router = Router();

/** SS-2's sibling: the owner-plane surface enumerated for the same reason. */
export const IDENTITY_PROVIDER_ROUTE_CENSUS = [
  'GET /',
  'POST /',
  'GET /:id',
  'PATCH /:id',
  'DELETE /:id',
  'POST /:id/test-connection',
  'GET /:id/invitations',
  'POST /:id/invitations',
  'GET /:id/links',
  'DELETE /links/:linkId',
  // RH-P5.SSO.W4 (A24): naming the Identity provider's SCIM client is the owner-plane
  // act that enables inbound provisioning for it. PUT rather than PATCH
  // because the binding is a whole value that is set or cleared, never
  // partially amended.
  'PUT /:id/scim-client',
  'DELETE /:id/scim-client',
] as const;

function auditActorFor(req: Request) {
  const authReq = req as AuthRequest;
  return {
    principalId: authReq.principal?.id ?? null,
    handle: authReq.userId || 'user',
    authMethod: authReq.authMethod ?? 'unknown',
  };
}

/**
 * Forward a TYPED in-house refusal; anything else rides `logCaughtFailure` and
 * the generic 500 envelope.
 *
 * The same shape as `sendOAuthError` and the AZ-S4 senders, for the same
 * reason: the caught value is read only inside instanceof-guarded arms, the
 * codes are developer-authored enums, and the messages are the service's own
 * sentences — an operator who hits SS-21 or SS-14a needs to be told WHICH rule
 * refused them, which is the whole point of those errors being named.
 */
function sendIdentityProviderError(res: Response, error: unknown, action: string): void {
  if (error instanceof IdentityProviderError) {
    const status = error.code === 'PROVIDER_NOT_FOUND'
      || error.code === 'LOGIN_GROUP_NOT_FOUND'
      || error.code === 'LOGIN_GROUP_NOT_LISTED'
      || error.code === 'PROVIDER_SCIM_CLIENT_NOT_FOUND'
      ? 404
      : error.code === 'PROVIDER_SCIM_CLIENT_TAKEN'
        ? 409
        : 400;
    res.status(status).json({ error: 'Identity provider refused', code: error.code, message: error.message });
    return;
  }
  if (error instanceof SsoDiscoveryError || error instanceof SsoOutboundError) {
    res.status(502).json({
      error: 'Identity provider unreachable',
      code: 'IDENTITY_PROVIDER_UNREACHABLE',
      message: 'the Identity provider could not be reached or its discovery document could not be validated',
    });
    return;
  }
  const errorId = logCaughtFailure(`[Identity providers] ${action} failed:`, error);
  res.status(500).json({
    error: 'Internal Server Error',
    code: 'IDENTITY_PROVIDER_FAILED',
    message: 'the Identity provider request could not be completed',
    errorId,
  });
}

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ identityProviders: await identityProviderService.list() });
  } catch (error) {
    sendIdentityProviderError(res, error, 'list');
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // SS-21: `subjectImmutable` has no default here either. An operator who
    // omits it has not made the declaration, and the declaration is the point.
    if (typeof body.subjectImmutable !== 'boolean') {
      res.status(400).json({
        error: 'Bad Request',
        code: 'PROVIDER_SUBJECT_DECLARATION_REQUIRED',
        message: 'subjectImmutable must be declared explicitly: an Identity provider that cannot guarantee immutable, never-recycled subjects cannot be enabled (SS-21)',
      });
      return;
    }
    const created = await identityProviderService.create(
      {
        name: String(body.name ?? ''),
        issuer: String(body.issuer ?? ''),
        discoveryUrl: typeof body.discoveryUrl === 'string' ? body.discoveryUrl : undefined,
        clientId: String(body.clientId ?? ''),
        clientAuthMethod: body.clientAuthMethod as ClientAuthMethod | undefined,
        clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret : null,
        clientPrivateKey: typeof body.clientPrivateKey === 'string' ? body.clientPrivateKey : null,
        subjectImmutable: body.subjectImmutable,
        status: body.status as ProviderStatus | undefined,
        scopesRequested: typeof body.scopesRequested === 'string' ? body.scopesRequested : undefined,
        extraAuthorizeParams: body.extraAuthorizeParams as Record<string, string> | undefined,
        additionalEndpointOrigins: body.additionalEndpointOrigins as string[] | undefined,
        handleClaim: typeof body.handleClaim === 'string' ? body.handleClaim : undefined,
        displayNameClaim: typeof body.displayNameClaim === 'string' ? body.displayNameClaim : undefined,
        emailClaim: typeof body.emailClaim === 'string' ? body.emailClaim : undefined,
        groupsClaim: typeof body.groupsClaim === 'string' ? body.groupsClaim : undefined,
        requiredClaims: body.requiredClaims as Record<string, string | string[]> | undefined,
        provisioningMode: body.provisioningMode as ProvisioningMode | undefined,
        groupBindingMode: body.groupBindingMode as GroupBindingMode | undefined,
        loginGroupWhitelistEnabled: typeof body.loginGroupWhitelistEnabled === 'boolean' ? body.loginGroupWhitelistEnabled : undefined,
        allowPrivateIssuerAddress: typeof body.allowPrivateIssuerAddress === 'boolean' ? body.allowPrivateIssuerAddress : undefined,
        allowClaimMatching: typeof body.allowClaimMatching === 'boolean' ? body.allowClaimMatching : undefined,
        retainIdToken: typeof body.retainIdToken === 'boolean' ? body.retainIdToken : undefined,
        providerOwnsProfile: typeof body.providerOwnsProfile === 'boolean' ? body.providerOwnsProfile : undefined,
        clockSkewSeconds: typeof body.clockSkewSeconds === 'number' ? body.clockSkewSeconds : undefined,
        sessionTtlSeconds: typeof body.sessionTtlSeconds === 'number' ? body.sessionTtlSeconds : undefined,
        backchannelLogoutEnabled: typeof body.backchannelLogoutEnabled === 'boolean' ? body.backchannelLogoutEnabled : undefined,
        // SSO-R8: null is a meaningful value here (claim-sync semantics), so it
        // is passed through rather than folded into "unset". The service
        // validates the shape and refuses anything else by name.
        scimHeartbeatIntervalHours: body.scimHeartbeatIntervalHours === null || typeof body.scimHeartbeatIntervalHours === 'number'
          ? body.scimHeartbeatIntervalHours
          : undefined,
      },
      auditActorFor(req),
    );
    res.status(201).json({ identityProvider: created });
  } catch (error) {
    sendIdentityProviderError(res, error, 'create');
  }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await identityProviderService.require(req.params.id);
    res.json({ identityProvider: provider, health: ssoDiscoveryService.health(provider.id) });
  } catch (error) {
    sendIdentityProviderError(res, error, 'get');
  }
});

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await identityProviderService.update(req.params.id, body, auditActorFor(req));
    res.json({ identityProvider: updated });
  } catch (error) {
    sendIdentityProviderError(res, error, 'update');
  }
});

/**
 * RH-P5.SSO.W4 (A24, AZ-A4 clause 3) — name this Identity provider's SCIM
 * client.
 *
 * This is the switch that enables inbound provisioning for an Identity
 * provider, and
 * it is deliberately an OWNER-PLANE act on the root-gated family rather than
 * a field on the SCIM surface itself: a directory that could name its own
 * client could name a second one.
 */
router.put('/:id/scim-client', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.principalId !== 'string' || body.principalId.trim() === '') {
      res.status(400).json({
        error: 'Bad Request',
        code: 'PROVIDER_SCIM_CLIENT_REQUIRED',
        message: 'principalId must name the parentless service Account whose Connector is this Identity provider\u2019s SCIM client (A17.2/A24)',
      });
      return;
    }
    const updated = await identityProviderService.setScimClient(
      req.params.id,
      body.principalId.trim(),
      auditActorFor(req),
    );
    res.json({ identityProvider: updated });
  } catch (error) {
    sendIdentityProviderError(res, error, 'set scim client');
  }
});

router.delete('/:id/scim-client', async (req: Request, res: Response): Promise<void> => {
  try {
    const updated = await identityProviderService.setScimClient(req.params.id, null, auditActorFor(req));
    res.json({ identityProvider: updated });
  } catch (error) {
    sendIdentityProviderError(res, error, 'clear scim client');
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    await identityProviderService.remove(req.params.id, auditActorFor(req));
    res.status(204).end();
  } catch (error) {
    sendIdentityProviderError(res, error, 'delete');
  }
});

/**
 * Read the discovery document NOW, and say what it says.
 *
 * This is the one place `force` is passed, and it is an owner-plane act — the
 * hot path never forces a refresh, so a hostile caller cannot drive fetches
 * (which is the other half of the T-SS9 argument).
 */
router.post('/:id/test-connection', async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = await identityProviderService.require(req.params.id);
    const metadata = await ssoDiscoveryService.metadata(
      {
        id: provider.id,
        issuer: provider.issuer,
        discoveryUrl: provider.discoveryUrl,
        additionalEndpointOrigins: provider.additionalEndpointOrigins,
        allowPrivateIssuerAddress: provider.allowPrivateIssuerAddress,
      },
      true,
    );
    await identityProviderService.recordDiscoveryHealth(provider.id, true, false);
    res.json({
      ok: true,
      // Endpoints are shown because an operator needs to see WHICH endpoints
      // the document actually resolved to — that is the whole point of "never
      // templated from the issuer" being visible rather than asserted.
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorizationEndpoint.toString(),
      tokenEndpoint: metadata.tokenEndpoint.toString(),
      jwksUri: metadata.jwksUri.toString(),
      endSessionEndpoint: metadata.endSessionEndpoint?.toString() ?? null,
      backchannelLogoutSupported: metadata.backchannelLogoutSupported,
      idTokenSigningAlgValuesSupported: metadata.idTokenSigningAlgValuesSupported,
    });
  } catch (error) {
    await identityProviderService.recordDiscoveryHealth(req.params.id, false, false).catch(() => undefined);
    sendIdentityProviderError(res, error, 'test-connection');
  }
});

/**
 * Owner ruling D4: invitation minting is a ROOT-GATED SUB-ROUTE on this router
 * — not a new family, not a new scope (A23.6), audited by the service.
 */
router.get('/:id/invitations', async (req: Request, res: Response): Promise<void> => {
  try {
    await identityProviderService.require(req.params.id);
    res.json({ invitations: await ssoInvitationService.listForProvider(req.params.id) });
  } catch (error) {
    sendIdentityProviderError(res, error, 'list invitations');
  }
});

router.post('/:id/invitations', async (req: Request, res: Response): Promise<void> => {
  try {
    await identityProviderService.require(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const newAccountIntent = body.newAccountIntent === true;
    const accountPrincipalId = typeof body.accountPrincipalId === 'string' ? body.accountPrincipalId : null;
    // The CHECK in migration 104 refuses both-or-neither; refusing it here too
    // turns a constraint violation into a sentence an operator can act on.
    if (newAccountIntent === (accountPrincipalId !== null)) {
      res.status(400).json({
        error: 'Bad Request',
        code: 'INVITATION_ACCOUNT_XOR_INTENT',
        message: 'an Invitation either names an existing Account or declares an intent to create one — never both, never neither (SS-22)',
      });
      return;
    }
    const { invitation, code } = await ssoInvitationService.mint(
      {
        identityProviderId: req.params.id,
        accountPrincipalId,
        newAccountIntent,
        intendedHandle: typeof body.intendedHandle === 'string' ? body.intendedHandle : null,
        ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
      },
      auditActorFor(req),
    );
    // The ONLY moment the raw code exists outside the recipient. It is not
    // stored, not audited, and not readable back from `GET /:id/invitations`.
    res.status(201).json({ invitation, invitationCode: code });
  } catch (error) {
    sendIdentityProviderError(res, error, 'mint invitation');
  }
});

/** The Access-manager view of who is linked at this Identity provider. */
router.get('/:id/links', async (req: Request, res: Response): Promise<void> => {
  try {
    await identityProviderService.require(req.params.id);
    const result = await pool.query(
      `SELECT l.id, l.account_principal_id, l.state, l.subject, l.established_at,
              l.promoted_at, l.last_seen_at, l.revoked_at, p.handle, p.display_name
         FROM identity_links l JOIN principals p ON p.id = l.account_principal_id
        WHERE l.link_kind = 'sso' AND l.identity_provider_id = $1
        ORDER BY l.established_at DESC LIMIT 500`,
      [req.params.id],
    );
    res.json({ links: result.rows });
  } catch (error) {
    sendIdentityProviderError(res, error, 'list links');
  }
});

// ── SSO-R4 — the login group whitelist (owner plane, root by the /identity-
// Identity-providers prefix rule in scopeMap.ts; no scope family is minted, A23.6).
//
// These routes decide WHO MAY AUTHENTICATE, not what they may then do. An
// admitted Account's authority is unchanged and is resolved by the same
// query-time membership join a password login resolves.

/** The Groups whose membership admits a federated login at this Identity provider. */
router.get('/:id/login-groups', async (req: Request, res: Response): Promise<void> => {
  try {
    await identityProviderService.require(req.params.id);
    const groups = await identityProviderService.listLoginGroups(req.params.id);
    res.json({ loginGroups: groups });
  } catch (error) {
    sendIdentityProviderError(res, error, 'list login groups');
  }
});

router.post('/:id/login-groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const groupId = (req.body ?? {}).groupId;
    if (typeof groupId !== 'string' || groupId === '') {
      res.status(422).json({
        error: 'Identity provider refused',
        code: 'INVALID_LOGIN_GROUP',
        message: 'groupId is required',
      });
      return;
    }
    await identityProviderService.addLoginGroup(req.params.id, groupId, auditActorFor(req));
    const groups = await identityProviderService.listLoginGroups(req.params.id);
    res.json({ success: true, loginGroups: groups });
  } catch (error) {
    sendIdentityProviderError(res, error, 'add login group');
  }
});

router.delete('/:id/login-groups/:groupId', async (req: Request, res: Response): Promise<void> => {
  try {
    await identityProviderService.removeLoginGroup(req.params.id, req.params.groupId, auditActorFor(req));
    const groups = await identityProviderService.listLoginGroups(req.params.id);
    res.json({ success: true, loginGroups: groups });
  } catch (error) {
    sendIdentityProviderError(res, error, 'remove login group');
  }
});

/**
 * Unlink. SS-24: this revokes the link AND every live session it proved, in ONE
 * transaction. The deferred constraint trigger refuses any writer that would
 * leave them, so this route cannot half-succeed.
 */
router.delete('/links/:linkId', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await identityLinkService.unlink(req.params.linkId, 'unlink', auditActorFor(req));
    res.json({ success: true, sessionsRevoked: result.sessionsRevoked });
  } catch (error) {
    sendIdentityProviderError(res, error, 'unlink');
  }
});

export default router;
