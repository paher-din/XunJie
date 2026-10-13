import type { FailureReason } from '../../bridge/types'

/** 失败卡动作。 */
export type FailureAction = 'retry' | 'switchModel' | 'dismiss'

/**
 * 失败分型文案（docs/agent-page-design.md 已确认 2026-10-09；2026-10-10 精简）：
 * 只说事实与动作，不道歉，不拟人；说明行能省则省——断网 / 模型报错只有标题与错误码，
 * 仅额度用尽带一句重置时间。
 */
export const FAILURE_COPY: Record<
  FailureReason,
  { title: string; desc?: string; actions: FailureAction[] }
> = {
  network: {
    title: '网络已断开',
    actions: ['retry', 'dismiss'],
  },
  model: {
    title: '模型服务出错',
    actions: ['retry', 'switchModel'],
  },
  quota: {
    title: '今日模型额度已用完',
    desc: '每日 0 点重置。',
    actions: ['dismiss'],
  },
}

export const FAILURE_ACTION_LABEL: Record<FailureAction, string> = {
  retry: '重试',
  switchModel: '换个模型',
  dismiss: '知道了',
}

/** 等待期三档递进（已确认 2026-10-09）：0–4 秒只有呼吸点；4 秒起文案；12 秒起追加走动秒数。 */
export const WAIT_TEXT_AT_MS = 4000
export const WAIT_SECONDS_AT_MS = 12000
export const WAIT_TEXT = '等待模型响应'

export const QUEUE_TIP = '已加入队列，当前回答完成后发送'
export const STOP_WITH_CONTENT = '已停止生成'
export const STOP_EMPTY = '已停止生成'
