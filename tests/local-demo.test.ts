import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { localDemoEnabled } from '../worker/local-demo.ts'
import { type Env, type Statement, type Value } from '../worker/platform.ts'

function setup() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
  const env: Env = {
    LOCAL_DEMO_ENABLED: 'true', ASSETS: { fetch: async () => new Response('asset') },
    INTEREST_LIMITER: { limit: async () => ({ success: true }) },
    API_LIMITER: { limit: async () => ({ success: true }) },
    EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    INTEREST_DB: {
      prepare(sql: string): Statement {
        let values: Value[] = []
        return { bind(...args) { values = args; return this }, async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null }, async all<T>() { return { results: db.prepare(sql).all(...values) as T[] } }, async run() { return db.prepare(sql).run(...values) } }
      },
      async batch(statements) {
        db.exec('BEGIN')
        try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); return result }
        catch (e) { db.exec('ROLLBACK'); throw e }
      },
    },
  }
  const request = (path: string, data?: unknown, cookie = '', origin = 'http://127.0.0.1:8787', headers = {}) => worker.fetch(new Request('http://127.0.0.1:8787' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }), env)
  return { db, env, request }
}

test('demo requires explicit enablement and HTTP loopback without public/proxy headers', () => {
  const env = { LOCAL_DEMO_ENABLED: 'true' } as Env
  for (const host of ['127.0.0.1', 'localhost']) assert.equal(localDemoEnabled(new Request(`http://${host}:8787`), env), true)
  for (const url of ['https://localhost', 'https://shop.example.invalid', 'http://192.168.1.2', 'http://localhost.example.invalid']) assert.equal(localDemoEnabled(new Request(url), env), false)
  for (const value of [undefined, 'false', '1']) assert.equal(localDemoEnabled(new Request('http://localhost'), { LOCAL_DEMO_ENABLED: value } as Env), false)
  for (const headers of [{ 'CF-Ray': 'public' }, { 'CF-Connecting-IP': '203.0.113.1' }, { Forwarded: 'host=localhost' }, { 'X-Forwarded-Host': 'localhost' }]) assert.equal(localDemoEnabled(new Request('http://localhost', { headers }), env), false)
})

for (const kind of ['admin', 'partner'] as const) {
  const loginPath = kind === 'admin' ? '/api/admin/demo-login' : '/api/partner/auth/demo-login'
  const sessionPath = kind === 'admin' ? '/api/admin/session' : '/api/partner/auth/session'
  const logoutPath = kind === 'admin' ? '/api/admin/logout' : '/api/partner/auth/logout'
  const protectedPath = kind === 'admin' ? '/api/admin/partners' : '/api/partner/dashboard'
  test(`${kind} demo login, protected API, expiry, disabled mode and logout`, async t => {
    const s = setup(); t.after(() => s.db.close())
    assert.equal((await (await s.request(sessionPath)).json()).demoAvailable, true)
    assert.equal((await s.request(loginPath)).status, 405)
    assert.equal((await s.request(loginPath, {}, '', 'https://evil.example')).status, 403)
    assert.equal((await s.request(loginPath, {}, '', undefined, { 'CF-Ray': 'public' })).status, 404)
    const response = await s.request(loginPath, {})
    assert.equal(response.status, 200, await response.clone().text())
    const setCookie = response.headers.get('Set-Cookie')!
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=3600/)
    const cookie = setCookie.split(';')[0]
    assert.equal((await (await s.request(sessionPath, undefined, cookie)).json()).authenticated, true)
    // A demo cookie must never authenticate as the other role.
    assert.notEqual((await (await s.request(kind === 'admin' ? '/api/partner/auth/session' : '/api/admin/session', undefined, cookie)).json()).authenticated, true)
    assert.equal((await s.request(protectedPath, undefined, cookie)).status, 200)
    s.env.LOCAL_DEMO_ENABLED = 'false'
    assert.equal((await s.request(loginPath, {})).status, 404)
    assert.equal((await (await s.request(sessionPath, undefined, cookie)).json()).authenticated, false)
    assert.notEqual((await s.request(protectedPath, undefined, cookie)).status, 200)
    s.env.LOCAL_DEMO_ENABLED = 'true'
    s.db.prepare(`UPDATE ${kind}_sessions SET expires_at=0`).run()
    assert.equal((await (await s.request(sessionPath, undefined, cookie)).json()).authenticated, false)
    const again = await s.request(loginPath, {})
    const cookie2 = again.headers.get('Set-Cookie')!.split(';')[0]
    const logout = await s.request(logoutPath, {}, cookie2)
    assert.equal(logout.status, 200)
    assert.match(logout.headers.get('Set-Cookie')!, /Max-Age=0/)
    assert.equal((await (await s.request(sessionPath, undefined, cookie2)).json()).authenticated, false)
  })
}

test('repeat partner demo login keeps prices and never reactivates disabled accounts', async t => {
  const s = setup(); t.after(() => s.db.close())
  assert.equal((await s.request('/api/partner/auth/demo-login', {})).status, 200)
  const admin = await s.request('/api/admin/demo-login', {})
  const adminCookie = admin.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await s.request('/api/admin/partners/00000000-0000-4000-8000-000000000001/preview', undefined, adminCookie)).status, 200)
  assert.equal((await s.request('/api/catalog?partner=DEMO01')).status, 200)
  s.db.prepare("UPDATE partner_prices SET price_cents=price_cents+100 WHERE partner_id='00000000-0000-4000-8000-000000000001'").run()
  const before = s.db.prepare("SELECT * FROM partner_prices WHERE partner_id='00000000-0000-4000-8000-000000000001'").all()
  assert.equal((await s.request('/api/partner/auth/demo-login', {})).status, 200)
  assert.deepEqual(s.db.prepare("SELECT * FROM partner_prices WHERE partner_id='00000000-0000-4000-8000-000000000001'").all(), before)
  s.db.prepare("UPDATE partners SET active=0 WHERE id='00000000-0000-4000-8000-000000000001'").run()
  assert.equal((await s.request('/api/partner/auth/demo-login', {})).status, 403)
})
