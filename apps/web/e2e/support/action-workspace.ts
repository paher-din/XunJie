import { ReliableWorkspace } from '../../src/reliable-workspace'
import { ReliableQuestionDraft } from '../../src/reliable-workspace/draft'

/** Browser test adapter, all behavior remains in the production public workspace and real service. */
export async function openActionWorkspace({ key, base, activityId, spaceKey = 'personal' }: { key: string; base: string; activityId: string; spaceKey?: string }) {
  const scope = JSON.parse(key) as string[]
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey, 'x-xj-expected-subject': scope.slice(1, 4).join('.') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error })
    return value
  }
  const wp = 'workspaces/' + activityId, dp = 'drafts/' + activityId, ap = 'intents/' + activityId
  const workspace = new ReliableWorkspace(key, { read: () => request(wp),
    receipt: id => request(wp + '/receipts/' + id), sync: body => request(wp, body) })
  const draft = new ReliableQuestionDraft(key, { read: () => request(dp),
    receipt: id => request(dp + '/receipts/' + id), sync: body => request(dp, body) })
  await workspace.open(); await draft.open()
  const actions = workspace.actions(draft, {
    prepare: body => request(ap, body), list: () => request(ap), read: id => request(ap + '/' + id),
    dispatch: id => request(ap + '/' + id + '/dispatch', {}), cancel: id => request(ap + '/' + id + '/cancel', {}),
    capabilities: () => request(ap + '/capabilities'),
  })
  await actions.open()
  return { workspace, draft, actions, request, actionPath: ap,
    dispose() { actions.dispose(); workspace.dispose(); draft.dispose() } }
}
