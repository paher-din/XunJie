import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RuntimeStatus, RuntimeService } from '@xunjie/contracts/product-runtime'
import { readStatus } from './status'
import { useTheme } from '../lib/theme'
import '../styles/tokens.css'
import './runtime.css'

const labels: Record<RuntimeStatus['state'], string> = {
  installed: '已安装', starting: '启动中', ready: '就绪', degraded: '降级运行',
  maintenance: '维护中', stopped: '已停止', failed: '运行失败', uninstalled: '已卸载',
}
const units: Record<RuntimeService['unit'], string> = {
  client: '网页客户端', 'space-course': '空间与课程', 'learning-data': '学习数据',
  'teaching-agent': '教学 Agent', 'model-connection': '模型连接', 'tool-execution': '工具执行',
}
const profiles = { local: '本地环境', school: '学校环境', remote: '远程环境' }

function RuntimePage() {
  useTheme()
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const refresh = useRef<() => void>(() => {})

  useEffect(() => {
    let disposed = false
    let pending = false
    let controller: AbortController | undefined
    let nextPoll: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      if (disposed || pending) return
      clearTimeout(nextPoll)
      pending = true
      controller = new AbortController()
      const request = controller
      const timeout = setTimeout(() => request.abort(), 8000)
      setChecking(true)
      try {
        const result = await readStatus(request.signal)
        if (!disposed) {
          setStatus(result)
          setError('')
        }
      } catch (cause) {
        if (!disposed) {
          setStatus(null)
          setError(request.signal.aborted ? '读取运行状态超时'
            : cause instanceof TypeError ? '无法连接运行服务'
              : cause instanceof Error ? cause.message : '读取运行状态失败')
        }
      } finally {
        clearTimeout(timeout)
        pending = false
        if (!disposed) {
          setChecking(false)
          setCheckedAt(new Date())
          nextPoll = setTimeout(() => void check(), 5000)
        }
      }
    }
    refresh.current = () => { void check() }
    const reconnect = () => { void check() }
    const offline = () => {
      controller?.abort()
      setStatus(null)
      setError('浏览器已断线，无法确认运行状态')
    }
    window.addEventListener('online', reconnect)
    window.addEventListener('offline', offline)
    void check()
    return () => {
      disposed = true
      controller?.abort()
      clearTimeout(nextPoll)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('offline', offline)
    }
  }, [])

  return <main>
    <header>
      <h1>循阶 · 运行状态</h1>
      <button type="button" onClick={() => refresh.current()} disabled={checking}>
        {checking ? '检查中…' : '重新检查'}
      </button>
    </header>
    <section className="runtime-summary" aria-live="polite" aria-atomic="true">
      {status ? <>
        <span className={`badge ${status.state}`}>{labels[status.state]} · {status.state}</span>
        {status.reason && <p>{status.reason}</p>}
      </> : <>
        <span className={`badge ${error ? 'failed' : 'starting'}`}>{error ? '状态不可确认' : '正在连接'}</span>
        {error && <p role="alert">{error}</p>}
      </>}
    </section>
    {status && <>
      <section aria-labelledby="dependencies-heading">
        <h2 id="dependencies-heading">依赖</h2>
        {status.dependencies.length ? <ul>{status.dependencies.map((dependency, index) =>
          <li key={`${dependency.name}-${index}`}>
            <div className="row"><span>{dependency.name}{!dependency.required && '（可选）'}</span>
              <span className={`badge ${dependency.state === 'ready' ? 'ready' : 'failed'}`}>
                {dependency.state === 'ready' ? '就绪' : '不可用'}
              </span>
            </div>
            {dependency.detail && <p className="detail">{dependency.detail}</p>}
          </li>)}</ul> : <p className="detail">未报告依赖</p>}
      </section>
      <section aria-labelledby="services-heading">
        <h2 id="services-heading">服务与连接能力</h2>
        {status.environment.services.length ? <ul>{status.environment.services.map((service, index) =>
          <li key={`${service.serviceId}-${index}`}>
            <div className="row"><span>{units[service.unit]}</span></div>
            <p className="detail">{service.capabilities.length ? service.capabilities.join(' · ') : '未声明能力'}</p>
            <details className="service-identity"><summary>服务身份与连接地址</summary><dl>
              <dt>服务 ID</dt><dd>{service.serviceId}</dd>
              <dt>连接地址</dt><dd>{service.endpoint}</dd>
              <dt>协议版本</dt><dd>{service.protocolVersion}</dd>
            </dl></details>
          </li>)}</ul> : <p className="detail">未注册服务或连接能力</p>}
      </section>
      <details className="environment">
        <summary>{profiles[status.environment.profile]} · 环境身份</summary>
        <dl>
          <dt>环境 ID</dt><dd>{status.environment.environmentId}</dd>
          <dt>安装 ID</dt><dd>{status.environment.installationId}</dd>
          <dt>客户端命名空间</dt><dd>{status.environment.clientNamespace}</dd>
          {status.endpoint && <><dt>运行入口</dt><dd>{status.endpoint}</dd></>}
        </dl>
      </details>
    </>}
    {checkedAt && <footer>最近检查 <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleTimeString('zh-CN')}</time></footer>}
  </main>
}

createRoot(document.getElementById('root')!).render(<RuntimePage />)
