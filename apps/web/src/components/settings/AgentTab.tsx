import { useState } from 'react'
import { Icon } from '../../icons'
import { MascotSvg } from '../Mascot'
import { updateAgent, useSettings } from '../../lib/settings'
import { Section, Row, Field, TextInput, Slider, RadioCard } from './controls'

/**
 * Agent 个性化 = 「我眼中的 Agent」（CONTEXT.md）：学生直接设定称呼、引导强度、
 * 提示方式与语气，即时生效；右侧实时预览 Agent 说话方式的变化。
 */
export function AgentTab() {
  const { agent, account } = useSettings()
  const [nickname, setNickname] = useState(agent.nickname)
  const nickDirty = nickname.trim() !== agent.nickname

  const preview = previewText(agent.tone, agent.guidance, agent.nickname || account.name)
  const asCard = agent.hintStyle === 'card'

  return (
    <div className="st-agent-cols">
      <div className="st-agent-main">
        <Section title="称呼">
          <div className="st-panel">
            <Field label="称呼">
              <div className="st-inline">
                <TextInput
                  value={nickname}
                  maxLength={12}
                  placeholder={account.name}
                  onChange={(e) => setNickname(e.target.value)}
                />
                <button
                  className="primary st-save"
                  disabled={!nickDirty}
                  onClick={() => updateAgent({ nickname: nickname.trim() })}
                >
                  保存
                </button>
              </div>
            </Field>
          </div>
        </Section>

        <Section title="引导方式">
          <div className="st-panel">
            <Row label="引导强度" stack>
              <Slider
                value={agent.guidance}
                onChange={(v) => updateAgent({ guidance: v })}
                minLabel="启发提问"
                maxLabel="直接解析"
                ariaLabel="引导强度"
              />
            </Row>
            <Row label="提示方式" stack>
              <RadioCard
                ariaLabel="提示方式"
                value={agent.hintStyle}
                onChange={(v) => updateAgent({ hintStyle: v })}
                options={[
                  { value: 'auto', title: '智能选择', desc: '根据当前任务与问题复杂度自动切换' },
                  { value: 'bubble', title: '轻量气泡', desc: '侧边浮层呈现，不打断当前实验与编码' },
                  { value: 'card', title: '教学卡片', desc: '内嵌结构化卡片，适合深度概念剖析' },
                ]}
              />
            </Row>
            <Row label="语气" stack>
              <RadioCard
                ariaLabel="语气"
                value={agent.tone}
                onChange={(v) => updateAgent({ tone: v })}
                options={[
                  { value: 'encouraging', title: '温和鼓励', desc: '循循善诱，提供更多正向反馈与思路引导' },
                  { value: 'concise', title: '精简高效', desc: '直入技术要点，聚焦关键逻辑与结论' },
                ]}
              />
            </Row>
          </div>
        </Section>
      </div>

      <aside className="st-preview">
        <p className="st-preview-title">辅导风格预览</p>
        <div className={'st-preview-stage' + (asCard ? ' as-card' : '')}>
          <div className="st-preview-mascot"><MascotSvg expression="idle" motion="idle" /></div>
          {asCard ? (
            <div className="st-preview-card">
              <p className="st-preview-card-head"><Icon name="lightbulb" size={15} />计数器原理</p>
              <p>{preview}</p>
            </div>
          ) : (
            <div className="st-preview-bubble">{preview}</div>
          )}
        </div>
      </aside>
    </div>
  )
}

function previewText(tone: 'encouraging' | 'concise', guidance: number, nickname: string): string {
  const direct = guidance >= 60
  if (tone === 'encouraging') {
    return direct
      ? `${nickname}，完成得很棒！核心要点是：按钮触发时计数器自增，LED 将按二进制实时显示当前计数值。`
      : `${nickname}，思路方向很准确！想一想：当按键产生电平跳变时，计数器的寄存器状态会如何改变？`
  }
  return direct
    ? `${nickname}，关键逻辑：按键触发计数器自增，LED 同步按二进制输出。`
    : `${nickname}，观察计数器模块：时钟上升沿与使能信号有效时，当前位宽状态如何转移？`
}
