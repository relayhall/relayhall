import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { SsoLogoutService } from '../services/identity/SsoLogoutService';
import { SsoAuthenticationService } from '../services/identity/SsoAuthenticationService';
import { identityProviderService, type IdentityProvider } from '../services/identity/IdentityProviderService';
import type { SsoDiscoveryService } from '../services/identity/SsoDiscoveryService';
import { principalService } from '../services/PrincipalService';

const db = new URL(process.env.RELAYHALL_TEST_DB_URL ?? '');
if (db.hostname !== '127.0.0.1' || db.pathname !== '/relayhall_sso_retry_test') throw new Error('OWNED_TEST_DB_REQUIRED');
const rawQuery = pool.query.bind(pool);
const rawConnect = pool.connect.bind(pool);
let fault: RegExp | null = null;
let injected = 0;
const ids: string[] = [];
const accounts: string[] = [];
let provider: IdentityProvider;
let other: IdentityProvider;
let principal: string;
let subject: string;
let sid: string;
let link: string;
let handle: string;
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const discovery = {
  metadata: async () => ({ idTokenSigningAlgValuesSupported: ['RS256'] }),
  signingKey: async () => keys.publicKey.export({ format: 'jwk' }),
} as unknown as SsoDiscoveryService;
const logout = new SsoLogoutService(discovery);
const auth = new SsoAuthenticationService();
type Provisioner = { resolveOrProvisionLink(p: IdentityProvider, s: string, c: Record<string, unknown>, r: string | null): Promise<{ id: string; accountPrincipalId: string }> };
const provision = (p = provider, ref: string | null = null) => (auth as unknown as Provisioner).resolveOrProvisionLink(p, subject, { preferred_username: handle, name: 'Synthetic retry fixture', email: `${handle}@example.invalid` }, ref);
function beforeSQL(sql: unknown): void {
  if (fault?.test(String(sql))) { fault = null; injected++; throw Object.assign(new Error('INJECTED_BEFORE_SQL'), { code: 'XX001' }); }
}
function token(extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' })).toString('base64url');
  const c = Buffer.from(JSON.stringify({ iss: provider.issuer, aud: provider.clientId, iat: now, exp: now + 120, jti: crypto.randomUUID(), events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, sid, ...extra })).toString('base64url');
  const input = `${h}.${c}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}
async function session(providerId = provider.id, identityLink = link, sessionSid = sid, account = principal): Promise<string> {
  const r = await rawQuery(`INSERT INTO auth_sessions(principal_id,token_hash,expires_at,identity_provider_id,identity_link_id,oidc_sid)
    VALUES($1,$2,now()+interval '1 hour',$3,$4,$5) RETURNING id`, [account,crypto.randomUUID(),providerId,identityLink,sessionSid]);
  return r.rows[0].id;
}
async function fixtureAccount(): Promise<string> {
  const r=await rawQuery("INSERT INTO principals(kind,handle,role) VALUES('human',$1,'agent') RETURNING id",[`fixture_${crypto.randomUUID().replace(/-/g,'')}`]);
  accounts.push(r.rows[0].id);return r.rows[0].id;
}
async function uses(): Promise<number> { return Number((await rawQuery('SELECT count(*) AS n FROM sso_logout_token_uses WHERE identity_provider_id=$1',[provider.id])).rows[0].n); }
async function live(): Promise<number> { return Number((await rawQuery('SELECT count(*) AS n FROM auth_sessions WHERE identity_provider_id=$1 AND revoked_at IS NULL',[provider.id])).rows[0].n); }
async function accountCount(): Promise<number> { return Number((await rawQuery('SELECT count(*) AS n FROM principals WHERE handle=$1',[handle])).rows[0].n); }
async function links(): Promise<number> { return Number((await rawQuery('SELECT count(*) AS n FROM identity_links WHERE identity_provider_id=$1 AND subject=$2',[provider.id,subject])).rows[0].n); }
async function invitation(existing?: string): Promise<string> {
  const r = await rawQuery(`INSERT INTO sso_invitations(identity_provider_id,account_principal_id,new_account_intent,secret_hash,intended_handle,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour') RETURNING id`,[provider.id,existing ?? null,!existing,crypto.randomUUID(),existing ? null : handle]);
  return `invitation:${r.rows[0].id}`;
}
async function unconsumed(ref: string): Promise<void> { const r=await rawQuery('SELECT consumed_at,consumed_link_id FROM sso_invitations WHERE id=$1',[ref.split(':')[1]]); expect(r.rows[0]).toEqual({consumed_at:null,consumed_link_id:null}); }
function wrapClient(c: PoolClient): typeof c {
  return new Proxy(c,{get(target,key) {
    if(key==='query') return (...args: unknown[]) => { beforeSQL(args[0]); return (target.query as Function).apply(target,args); };
    const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
  }});
}
beforeAll(async () => {
  jest.spyOn(pool,'query').mockImplementation(((...args: unknown[]) => { beforeSQL(args[0]); return (rawQuery as Function)(...args); }) as typeof pool.query);
  jest.spyOn(pool,'connect').mockImplementation(((...args: unknown[]) => {
    const callback=args[args.length-1];
    if(typeof callback==='function') {
      const forwarded=args.slice(0,-1);
      forwarded.push((error: Error | undefined, client: PoolClient, release: () => void) => callback(error,client?wrapClient(client):client,release));
      return (rawConnect as Function).apply(pool,forwarded);
    }
    return ((rawConnect as Function).apply(pool,args) as Promise<PoolClient>).then(wrapClient);
  }) as typeof pool.connect);
  // Actual-pool forwarding control runs before any failure injection/case.
  // pool.query exercises the callback connection path; connect() exercises Promise.
  expect((await rawQuery('SELECT 17 AS forwarding')).rows[0].forwarding).toBe(17);
  const client=await pool.connect();
  try { expect((await client.query('SELECT 19 AS forwarding')).rows[0].forwarding).toBe(19); }
  finally { client.release(); }
});
beforeEach(async () => {
  fault=null;injected=0;const suffix=crypto.randomUUID().replace(/-/g,'');
  handle=`sso_retry_${suffix}`;subject=`sub_${suffix}`;sid=`sid_${suffix}`;
  await rawQuery("UPDATE identity_providers SET status='disabled' WHERE status='active'");
  async function providerRow(active: boolean) {
    const r=await rawQuery(`INSERT INTO identity_providers(name,status,issuer,discovery_url,client_id,client_auth_method,subject_immutable,provisioning_mode,backchannel_logout_enabled)
      VALUES($1,$2,$3,$4,'fixture','none',true,'jit',true) RETURNING id`,['Synthetic retry',active?'active':'disabled',`https://fixture.example.invalid/${crypto.randomUUID()}`,'https://fixture.example.invalid/discovery']);
    ids.push(r.rows[0].id);return (await identityProviderService.get(r.rows[0].id))!;
  }
  provider=await providerRow(true);other=await providerRow(false);
  principal=await fixtureAccount();
  link=(await rawQuery("INSERT INTO identity_links(account_principal_id,link_kind,state,identity_provider_id,subject,promoted_at) VALUES($1,'sso','proven',$2,$3,now()) RETURNING id",[principal,provider.id,`session_${subject}`])).rows[0].id;
});
afterEach(async () => {
  fault=null;
  // Respect provider RESTRICT and one Account/provider link uniqueness.
  // Keep owned IDs until cleanup and absence assertions have succeeded.
  await rawQuery('DELETE FROM auth_sessions WHERE identity_provider_id=ANY($1::uuid[])',[ids]);
  await rawQuery('DELETE FROM sso_invitations WHERE identity_provider_id=ANY($1::uuid[])',[ids]);
  await rawQuery('DELETE FROM sso_logout_token_uses WHERE identity_provider_id=ANY($1::uuid[])',[ids]);
  await rawQuery('DELETE FROM identity_links WHERE identity_provider_id=ANY($1::uuid[])',[ids]);
  await rawQuery('DELETE FROM identity_providers WHERE id=ANY($1::uuid[])',[ids]);
  await rawQuery('DELETE FROM principals WHERE id=ANY($1::uuid[]) OR handle=$2',[accounts,handle]);
  expect(Number((await rawQuery('SELECT count(*) AS n FROM identity_providers WHERE id=ANY($1::uuid[])',[ids])).rows[0].n)).toBe(0);
  expect(Number((await rawQuery('SELECT count(*) AS n FROM principals WHERE id=ANY($1::uuid[]) OR handle=$2',[accounts,handle])).rows[0].n)).toBe(0);
  ids.length=0;accounts.length=0;principalService.invalidateHandles([handle]);
});
afterAll(async () => { jest.restoreAllMocks();await pool.end(); });

test('sid logout failure rolls back replay and plain retry revokes',async()=> {
  await session();const t=token();fault=/UPDATE auth_sessions/;
  await expect(logout.backchannelLogout(t)).rejects.toThrow('INJECTED');expect(injected).toBe(1);
  expect(await uses()).toBe(0);expect(await live()).toBe(1);
  expect((await logout.backchannelLogout(t)).sessionsRevoked).toBe(1);expect(await uses()).toBe(1);expect(await live()).toBe(0);
});
test('subject logout retry remains provider and subject scoped',async()=> {
  await rawQuery('UPDATE identity_links SET subject=$2 WHERE id=$1',[link,subject]);await session();const otherAccount=await fixtureAccount();const ul=(await rawQuery("INSERT INTO identity_links(account_principal_id,link_kind,state,identity_provider_id,subject,promoted_at) VALUES($1,'sso','proven',$2,$3,now()) RETURNING id",[otherAccount,provider.id,'other-subject'])).rows[0].id;const untouched=await session(provider.id,ul,'other-sid',otherAccount);
  const ol=(await rawQuery("INSERT INTO identity_links(account_principal_id,link_kind,state,identity_provider_id,subject,promoted_at) VALUES($1,'sso','proven',$2,$3,now()) RETURNING id",[principal,other.id,subject])).rows[0].id;const otherSession=await session(other.id,ol);
  const t=token({sid:undefined,sub:subject});fault=/UPDATE auth_sessions/;
  await expect(logout.backchannelLogout(t)).rejects.toThrow('INJECTED');expect(await uses()).toBe(0);expect(await live()).toBe(2);
  expect((await logout.backchannelLogout(t)).sessionsRevoked).toBe(1);
  expect((await rawQuery('SELECT revoked_at FROM auth_sessions WHERE id=$1',[otherSession])).rows[0].revoked_at).toBeNull();
  expect((await rawQuery('SELECT revoked_at FROM auth_sessions WHERE id=$1',[untouched])).rows[0].revoked_at).toBeNull();
});
test('audit failure rolls back completed revocation and replay use',async()=> {
  await session();const t=token();fault=/INSERT INTO audit_events/;await expect(logout.backchannelLogout(t)).rejects.toThrow('INJECTED');
  expect(await uses()).toBe(0);expect(await live()).toBe(1);expect((await logout.backchannelLogout(t)).sessionsRevoked).toBe(1);
});
test('successful logout replay refuses without touching new session',async()=> {
  await session();const t=token();await logout.backchannelLogout(t);await session();await expect(logout.backchannelLogout(t)).rejects.toMatchObject({code:'LOGOUT_TOKEN_REPLAYED'});expect(await live()).toBe(1);expect(await uses()).toBe(1);
});
test('disabled provider refuses with no logout mutations',async()=> {
  await session();const t=token();await rawQuery("UPDATE identity_providers SET status='disabled' WHERE id=$1",[provider.id]);await expect(logout.backchannelLogout(t)).rejects.toMatchObject({code:'LOGOUT_ISSUER_UNKNOWN'});expect(await live()).toBe(1);expect(await uses()).toBe(0);
});
for(const [name,pattern] of [['email',/UPDATE principals/],['link',/INSERT INTO identity_links/],['recordLink',/UPDATE sso_invitations SET consumed_link_id/]] as const) {
  test(`invited ${name} failure leaves no orphan and retry converges`,async()=> {
    const ref=await invitation();provider={...provider,provisioningMode:'invited'};fault=pattern;
    await expect(provision(provider,ref)).rejects.toThrow('INJECTED');expect(injected).toBe(1);expect(await accountCount()).toBe(0);expect(await links()).toBe(0);await unconsumed(ref);
    expect(await principalService.getPrincipalByHandle(handle)).toBeUndefined();const l=await provision(provider,ref);expect(l.accountPrincipalId).toBeTruthy();expect(await accountCount()).toBe(1);expect(await links()).toBe(1);
  });
}
test('existing invited Account survives rollback and exact retry links it',async()=> {
  const invitedAccount=await fixtureAccount();const ref=await invitation(invitedAccount);provider={...provider,provisioningMode:'invited'};fault=/INSERT INTO identity_links/;await expect(provision(provider,ref)).rejects.toThrow('INJECTED');await unconsumed(ref);expect(await links()).toBe(0);
  expect((await provision(provider,ref)).accountPrincipalId).toBe(invitedAccount);expect(await accountCount()).toBe(0);
});
for(const [name,pattern] of [['email',/UPDATE principals/],['link',/INSERT INTO identity_links/]] as const) {
  test(`JIT ${name} failure leaves no orphan or cached Account`,async()=> {
    fault=pattern;await expect(provision()).rejects.toThrow('INJECTED');expect(injected).toBe(1);expect(await accountCount()).toBe(0);expect(await links()).toBe(0);expect(await principalService.getPrincipalByHandle(handle)).toBeUndefined();
    await provision();expect(await accountCount()).toBe(1);expect(await links()).toBe(1);
  });
}
test('successful provisioning subsequent resolution reuses exact link',async()=> {
  const first=await provision();const again=await provision();expect(again.id).toBe(first.id);expect(again.accountPrincipalId).toBe(first.accountPrincipalId);expect(await accountCount()).toBe(1);expect(await links()).toBe(1);
});
test('independent handle collision remains refused without link',async()=> {
  await rawQuery("INSERT INTO principals(kind,handle,role) VALUES('human',$1,'agent')",[handle]);await expect(provision()).rejects.toMatchObject({code:'SSO_HANDLE_COLLISION'});expect(await accountCount()).toBe(1);expect(await links()).toBe(0);
});
