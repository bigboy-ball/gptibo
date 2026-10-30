import { ApiError, body, cookie, hash, json, randomToken, readCookie, type Env } from './platform.ts'
import type { Partner } from './partner-auth.ts'

const ADMIN_VERSION = 'local-demo-admin-v1'
const PARTNER_VERSION = '00000000-0000-4000-8000-000000000001-v1'
const PARTNER_ID = '00000000-0000-4000-8000-000000000001'
const SESSION_SECONDS = 3600

export function localDemoEnabled(request: Request, env: Env) {
  const url = new URL(request.url)
  return env.LOCAL_DEMO_ENABLED === 'true' && url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    !request.headers.has('CF-Ray') && !request.headers.has('Forwarded') &&
    !request.headers.has('X-Forwarded-Host') &&
    (!request.headers.has('CF-Connecting-IP') || ['127.0.0.1', '::1'].includes(request.headers.get('CF-Connecting-IP')!))
}

export async function demoAdminAuthenticated(request: Request, env: Env) {
  const token = readCookie(request, 'admin_demo')
  if (!token || !localDemoEnabled(request, env)) return false
  return Boolean(await env.INTEREST_DB.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND credential_version=? AND expires_at>?').bind(await hash(token), ADMIN_VERSION, Date.now()).first())
}

export async function demoPartnerSession(request: Request, env: Env): Promise<Partner | null> {
  const token = readCookie(request, 'partner_demo')
  if (!token || !localDemoEnabled(request, env)) return null
  return env.INTEREST_DB.prepare('SELECT p.* FROM partner_sessions s JOIN partners p ON p.id=s.partner_id WHERE s.token_hash=? AND s.credential_version=? AND s.expires_at>? AND s.auth_version=p.auth_version AND p.active=1 AND p.id=?').bind(await hash(token), PARTNER_VERSION, Date.now(), PARTNER_ID).first<Partner>()
}

export async function localDemoRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  const admin = path === '/api/admin/demo-login'
  const partner = path === '/api/partner/auth/demo-login'
  if (!admin && !partner) return null
  if (!localDemoEnabled(request, env)) throw new ApiError('演示登录仅在本机开发环境启用。', 404)
  if (request.method !== 'POST') throw new ApiError('请使用登录按钮。', 405)
  await body(request)
  const db = env.INTEREST_DB, now = Date.now(), token = randomToken(), tokenHash = await hash(token)
  if (admin) {
    await db.batch([
      db.prepare('DELETE FROM admin_sessions WHERE credential_version=? AND expires_at<=?').bind(ADMIN_VERSION, now),
      db.prepare('INSERT INTO admin_sessions(token_hash,credential_version,expires_at) VALUES (?,?,?)').bind(tokenHash, ADMIN_VERSION, now + SESSION_SECONDS * 1000),
    ])
  } else {
    await db.batch([
      db.prepare("INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,'本地演示商店','demo@example.invalid',?,?) ON CONFLICT(id) DO NOTHING").bind(PARTNER_ID, 'DEMO01', now, now),
      db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) SELECT ?,c.id,COALESCE(d.cost_cents,c.price_cents),MAX(c.price_cents,COALESCE(d.cost_cents,c.price_cents)) FROM catalog_plans c LEFT JOIN partner_default_prices d ON d.plan=c.id WHERE 1=1 ON CONFLICT(partner_id,plan) DO NOTHING').bind(PARTNER_ID),
      db.prepare('DELETE FROM partner_sessions WHERE credential_version=? AND expires_at<=?').bind(PARTNER_VERSION, now),
      db.prepare('INSERT INTO partner_sessions(token_hash,partner_id,auth_version,credential_version,expires_at) SELECT ?,id,auth_version,?,? FROM partners WHERE id=? AND active=1').bind(tokenHash, PARTNER_VERSION, now + SESSION_SECONDS * 1000, PARTNER_ID),
    ])
    if (!await db.prepare('SELECT token_hash FROM partner_sessions WHERE token_hash=? AND credential_version=?').bind(tokenHash, PARTNER_VERSION).first()) throw new ApiError('演示代理已停用，请在管理后台启用。', 403)
  }
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, admin ? 'admin_demo' : 'partner_demo', token, SESSION_SECONDS) })
}

export async function demoLogout(request: Request, env: Env, kind: 'admin' | 'partner') {
  const token = readCookie(request, kind + '_demo')
  if (!token) return null
  await body(request)
  await env.INTEREST_DB.prepare(`DELETE FROM ${kind}_sessions WHERE token_hash=? AND credential_version=?`).bind(await hash(token), kind === 'admin' ? ADMIN_VERSION : PARTNER_VERSION).run()
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, kind + '_demo', '', 0) })
}
