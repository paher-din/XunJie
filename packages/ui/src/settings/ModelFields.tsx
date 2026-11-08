import { useState } from 'react'
import { Icon } from '../icons'
import type { ProviderModel } from './types'
import { Field, HelpTip, TextInput, Toggle } from './controls'
import { smartModelDefaults } from './modelPresentation'


const INPUT_TYPES: Array<{ id: 'image' | 'video' | 'pdf'; label: string }> = [
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'pdf', label: 'PDF' },
]

/**
 * 一个模型的完整表单：智能配置开关、模型 ID、上下文窗口 / 最大输出、输入类型、推理等级。
 * 供应商弹窗的模型卡与卡片上的「添加 / 编辑模型」弹窗共用同一份——两处能力必须对齐，
 * 否则从供应商里接进来的模型就得再进一次弹窗才配得全。
 */
export function ModelFields({
  model, onPatch, onRemove, idError,
}: {
  model: ProviderModel
  onPatch: (patch: Partial<ProviderModel>) => void
  /** 一张卡对应一个模型时给出移除入口；单模型弹窗不传。 */
  onRemove?: () => void
  idError?: string
}) {
  const [smart, setSmart] = useState(true)
  const [addingLevel, setAddingLevel] = useState(false)
  const [levelDraft, setLevelDraft] = useState('')

  /** ID 命中参照表、且窗口与上限还没被填过时才回填，手写过的值不覆盖。 */
  const changeId = (v: string) => {
    const preset = smart ? smartModelDefaults(v) : null
    onPatch(preset && !model.contextWindow && !model.maxOutput ? { id: v, ...preset } : { id: v })
  }

  const addLevel = () => {
    const v = levelDraft.trim()
    if (v && !model.reasoningLevels.includes(v)) {
      onPatch({ reasoningLevels: [...model.reasoningLevels, v] })
    }
    setLevelDraft('')
    setAddingLevel(false)
  }

  return (
    <>
      <div className="st-smart-row">
        <span className="st-field-label">
          智能配置
          <HelpTip tip="按已知精确模型 ID 填写参考值；连接测试可导入供应商返回的实际能力" />
        </span>
        <Toggle checked={smart} onChange={setSmart} label="智能配置" />
      </div>
      <Field label="模型 ID" error={idError}>
        <div className="st-model-row">
          <TextInput
            value={model.id}
            placeholder="模型 ID，例如 deepseek-flash"
            className="st-mono-input"
            onChange={(e) => changeId(e.target.value)}
          />
          {onRemove && (
            <button type="button" className="st-iconbtn" aria-label="移除模型" onClick={onRemove}>
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      </Field>
      <div className="st-model-cols">
        <Field label="上下文窗口" tip="输入与输出共用此容量；发送前保守核算，不自动截断历史。留空使用16384。">
          <TextInput
            type="number"
            min={1}
            value={model.contextWindow}
            placeholder="如 131072"
            onChange={(e) => onPatch({ contextWindow: e.target.value })}
          />
        </Field>
        <Field label="最大输出 Token" tip="实际请求的 max_tokens，包含模型思考与正文；需小于上下文窗口。留空使用4096。">
          <TextInput
            type="number"
            min={1}
            value={model.maxOutput}
            placeholder="如 30000"
            onChange={(e) => onPatch({ maxOutput: e.target.value })}
          />
        </Field>
      </div>
      <div className="st-field">
        <span className="st-field-label">输入类型</span>
        <div className="st-checks">
          <span className="st-check checked locked">
            <Icon name="check" size={13} className="st-check-mark" />文本<Icon name="lock-keyhole" size={12} />
          </span>
          {INPUT_TYPES.map((t) => {
            const on = model.inputTypes.includes(t.id)
            return (
              <button
                key={t.id}
                type="button"
                className={'st-check' + (on ? ' checked' : '')}
                aria-pressed={on}
                onClick={() => onPatch({
                  inputTypes: on ? model.inputTypes.filter((x) => x !== t.id) : [...model.inputTypes, t.id],
                })}
              >
                {on && <Icon name="check" size={13} className="st-check-mark" />}{t.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="st-field">
        <span className="st-field-label">推理等级（从低到高）</span>
        <div className="st-checks">
          {model.reasoningLevels.map((l, i) => (
            <span className="st-check checked" key={l}>
              {l}
              <button
                type="button"
                className="st-check-x"
                aria-label={`移除${l}`}
                onClick={() => onPatch({ reasoningLevels: model.reasoningLevels.filter((_, j) => j !== i) })}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          {addingLevel ? (
            <input
              className="st-input st-level-input"
              value={levelDraft}
              autoFocus
              placeholder="如 low"
              onChange={(e) => setLevelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addLevel()
                if (e.key === 'Escape') { setAddingLevel(false); setLevelDraft('') }
              }}
              onBlur={addLevel}
            />
          ) : (
            <button type="button" className="st-check st-check-add" aria-label="添加推理等级" onClick={() => setAddingLevel(true)}>
              <Icon name="add" size={13} />
            </button>
          )}
        </div>
      </div>
    </>
  )
}

import type { ComponentProps } from 'react'
export type ModelFieldsProps = ComponentProps<typeof ModelFields>
