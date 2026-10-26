// Disposable compiled-router/browser proof. Never accepts a deployment DB.
const crypto = require('crypto');
const fs = require('fs');
const input = process.env.RELAYHALL_TEST_DB_URL;
if (!input) throw Error('Explicit disposable database required');
const db = new URL(input);
if (db.hostname !== '127.0.0.1' || !/^relayhall_p2d_test/.test(db.pathname.slice(1))) throw Error('Local P2-D fixture only');
Object.assign(process.env, { DB_HOST: db.hostname, DB_PORT: db.port, DB_NAME: db.pathname.slice(1),
  DB_USER: decodeURIComponent(db.username), DB_PASSWORD: decodeURIComponent(db.password), NODE_ENV: 'test',
  RELAYHALL_SESSIONS: 'on', JWT_SECRET: crypto.randomBytes(32).toString('hex') });
process.env.RELAYHALL_CREDENTIAL_KEYS = JSON.stringify({p2d:crypto.randomBytes(32).toString('base64')});
process.env.RELAYHALL_CREDENTIAL_ACTIVE_KEY = 'p2d';
const express = require('express'), cors = require('cors');
const { pool } = require('../dist/db/connection');
const { principalService } = require('../dist/services/PrincipalService');
const { loginSessionService, SESSION_COOKIE_NAME } = require('../dist/services/LoginSessionService');
const { registerProtectedRoutes } = require('../dist/routeRegistry');
const { authMiddleware } = require('../dist/middleware/auth');
const { sharedAuthorizationMiddleware } = require('../dist/middleware/sharedAuthorization');
const { apiErrorHandler } = require('../dist/utils/apiErrors');
(async () => {
  const tag = crypto.randomBytes(4).toString('hex');
  const root = (await pool.query("INSERT INTO principals(kind,handle,display_name,status,role) VALUES('human',$1,'P2-D browser reviewer','active','admin') RETURNING id", ['000-p2d-browser-root-'+tag])).rows[0].id;
  const parent = (await pool.query("INSERT INTO principals(kind,handle,status,role) VALUES('human',$1,'active','user') RETURNING id", ['000-p2d-browser-parent-'+tag])).rows[0].id;
  const conn = (await pool.query(`INSERT INTO principals(kind,handle,display_name,status,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,'P2-D browser connector','active',$2,'P2-D UI proof','{"scopes":"parent","objects":"parent"}') RETURNING id`, ['000-p2d-browser-connector-'+tag,parent])).rows[0].id;
  const issued = await principalService.issueCredential({ principalId: conn, scopes: ['tasks:read','tasks:write'], transport: 'mcp' }, { handle:'fixture',authMethod:'system' });
  const historyIds=[];
  for(let i=0;i<50;i++) {
    const id=`00000000-0000-4000-8000-${tag}${i.toString(16).padStart(4,'0')}`;
    historyIds.push(id);
    await pool.query(`INSERT INTO principal_credentials(id,principal_id,credential_type,key_id,secret_hash,scopes,transport,revoked_at)
      VALUES($1,$2,'api_key',$3,$4,'["tasks:read"]','mcp',clock_timestamp())`,[id,conn,crypto.randomBytes(12).toString('hex'),'0'.repeat(64)]);
  }
  const other = (await pool.query(`INSERT INTO principals(kind,handle,status,parent_principal_id,purpose,own_expression)
    VALUES('service',$1,'active',$2,'P2-D foreign key fixture','{"scopes":"parent","objects":"parent"}') RETURNING id`, ['000-p2d-foreign-'+tag,parent])).rows[0].id;
  const foreign = await principalService.issueCredential({principalId:other,scopes:['tasks:read'],transport:'mcp'},{handle:'fixture',authMethod:'system'});
  const task = (await pool.query(`INSERT INTO tasks(title,status,visibility,creator_principal_id,account_owner_principal_id,shepherd_principal_id)
    VALUES('P2-D browser evidence','todo','private',$1,$2,$2) RETURNING id`, [conn,parent])).rows[0].id;
  const session = await loginSessionService.mint({ principalId:root });
  const app = express(); app.use(cors({ origin:'http://127.0.0.1:55441', credentials:true })); app.use(express.json());
  app.use('/auth',require('../dist/routes/auth').default);
  app.use('/config',require('../dist/routes/config').default);
  app.get('/fixture-login', (_req,res) => { res.cookie(SESSION_COOKIE_NAME,session.token,{httpOnly:true,sameSite:'lax',secure:false,path:'/'});
    res.send('<a href="http://127.0.0.1:55441/dashboard-dev/settings/access-manager">Open disposable Access manager</a>'); });
  registerProtectedRoutes((mount,...handlers) => app.use(mount,authMiddleware,sharedAuthorizationMiddleware,...handlers)); app.use(apiErrorHandler);
  const receipt = {root,connector:conn,credentialId:issued.credentialId,historyIds,foreignCredentialId:foreign.credentialId,task,port:55440};
  fs.writeFileSync('p2d-browser-fixture.json',JSON.stringify(receipt,null,2));
  const server=app.listen(55440,'127.0.0.1',() => console.log(JSON.stringify({kind:'compiled-router-browser-ready',...receipt})));
  const close=()=>server.close(()=>pool.end().then(()=>process.exit(0)));
  process.once('SIGINT',close); process.once('SIGTERM',close);
})();
