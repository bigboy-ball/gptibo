import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'

export function LocalDemoLogin({ kind, onLogin }: { kind: 'admin' | 'partner'; onLogin: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function login() {
    setBusy(true); setError('')
    try {
      await api(kind === 'admin' ? '/api/admin/demo-login' : '/api/partner/auth/demo-login', {})
      await onLogin()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="admin-setup">
    <h2>本地开发演示</h2>
    <p>无需邮箱或验证器，体验{kind === 'admin' ? '管理后台' : '代理工作台'}。操作会保存到本地数据库，会话一小时后过期。</p>
    <Button onClick={() => void login()} disabled={busy}>{busy ? '正在进入…' : kind === 'admin' ? '演示登录管理后台' : '演示登录代理工作台'}</Button>
    {error && <p role="alert">{error}</p>}
  </div>
}
