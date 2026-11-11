import { expect, it } from 'vitest'
import type { ModelProvider } from '@xunjie/contracts/model-connections'
import { captureModelSettingsOrder, compareModelIds, inIdOrder, reconcileModelChoices, reconcileModelSettingsOrder } from './modelOrdering'

const provider = (id: string, models: [string, boolean][], enabled = true): ModelProvider => ({
  providerId: id, enabled, models: models.map(([modelId, modelEnabled]) => ({ connectionId: modelId, modelId,
    enabled: enabled && modelEnabled, modelEnabled })),
} as ModelProvider)
const modelIds = (order: ReturnType<typeof captureModelSettingsOrder>, id: string) => order.models[id]!.map(model => model.id)

it('uses natural IDs while keeping persisted join order and individual switches intact', () => {
  const data = [provider('off', [['model-2', true], ['Model-10', true], ['model-1', false]], false),
    provider('on', [['z', true], ['a', true]])]
  const original = structuredClone(data)
  const order = captureModelSettingsOrder(data)
  expect(order.providers.map(provider => provider.id)).toEqual(['on', 'off'])
  expect(modelIds(order, 'off')).toEqual(['model-2', 'Model-10', 'model-1'])
  expect(modelIds(order, 'on')).toEqual(['a', 'z'])
  expect(data).toEqual(original)
  expect(['model-10', 'Model-2', 'model-1'].sort(compareModelIds)).toEqual(['model-1', 'Model-2', 'model-10'])
})

it('freezes existing positions across saves/polls, places new rows, removes absent rows and recaptures next visit', () => {
  const start = [provider('first', [['model-10', true], ['model-2', true], ['model-20', false]]), provider('second', [['b', true]])]
  const order = captureModelSettingsOrder(start)
  const next = [provider('second', [['b', true]]), provider('new', [['new', true]]),
    provider('first', [['model-20', true], ['model-10', true], ['model-2', false], ['model-3', true], ['model-15', false]], false)]
  const frozen = reconcileModelSettingsOrder(order, next)
  expect(frozen.providers.map(provider => provider.id)).toEqual(['first', 'second', 'new'])
  expect(modelIds(frozen, 'first')).toEqual(['model-2', 'model-3', 'model-10', 'model-15', 'model-20'])
  expect(inIdOrder(next, frozen.providers.map(provider => provider.id), provider => provider.providerId)[0]!.enabled).toBe(false)
  expect(modelIds(captureModelSettingsOrder(next), 'first')).toEqual(['model-3', 'model-10', 'model-20', 'model-2', 'model-15'])
  const removed = reconcileModelSettingsOrder(frozen, [provider('first', [['model-10', true]], false)])
  expect(removed.providers.map(provider => provider.id)).toEqual(['first'])
  expect(modelIds(removed, 'first')).toEqual(['model-10'])
})

it('keeps checked candidate cards in place when discovery refreshes and inserts new candidates naturally', () => {
  const choice = (key: string, candidate = true) => ({ key, modelId: key, candidate })
  const start = reconcileModelChoices(undefined, [choice('selected-b', false), choice('selected-a', false), choice('model-10'), choice('model-2')])
  expect(start.map(row => row.key)).toEqual(['selected-b', 'selected-a', 'model-2', 'model-10'])
  const next = reconcileModelChoices(start, [choice('model-10', false), choice('selected-a', false), choice('selected-b'), choice('model-3'), choice('model-2')])
  expect(next.map(row => row.key)).toEqual(['selected-b', 'selected-a', 'model-2', 'model-3', 'model-10'])
  expect(next[0]!.candidate).toBe(false)
  expect(next[4]!.candidate).toBe(true)
})
