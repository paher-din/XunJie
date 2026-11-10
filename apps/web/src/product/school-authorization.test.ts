// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { rememberSchoolConnection, restoreSchoolConnection, schoolAuthorizationReturnUrl, startSchoolAuthorization } from './school-authorization'

const requestId = '00000000-0000-4000-8000-000000000009'
const pending = { requestId, authorizationUrl: 'https://school.example.edu/?authorize=' + requestId }
const callback = 'http://127.0.0.1:57417/?settings=account&schoolAuthorization=' + requestId
beforeEach(() => { localStorage.clear(); vi.spyOn(window, 'open').mockReturnValue(null) })
afterEach(() => { vi.restoreAllMocks() })

it('keeps returned requests tied to the same client namespace and original request', () => {
  rememberSchoolConnection('client-a', pending)
  expect(restoreSchoolConnection('client-a', requestId)).toEqual({ ...pending, authenticated: true })
  expect(restoreSchoolConnection('client-b', requestId)).toBeNull()
  expect(restoreSchoolConnection('client-a', crypto.randomUUID())).toBeNull()
  rememberSchoolConnection('client-a', null)
  expect(restoreSchoolConnection('client-a', requestId)).toBeNull()
})

it('expires pending authentication while retaining a completed connection for a failed context read', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000000)
  rememberSchoolConnection('client', pending)
  vi.mocked(Date.now).mockReturnValue(1300001)
  expect(restoreSchoolConnection('client', requestId)).toBeNull()
  rememberSchoolConnection('client', { ...pending, connectionId: requestId })
  expect(restoreSchoolConnection('client', requestId)?.connectionId).toBe(requestId)
})

it('accepts the fixed client account return route', () => {
  expect(schoolAuthorizationReturnUrl(requestId, callback)).toBe(callback)
  expect(schoolAuthorizationReturnUrl(requestId, null)).toBeNull()
})

it.each([
  'javascript:alert(1)',
  'http://example.com/?settings=account&schoolAuthorization=' + requestId,
  'http://127.0.0.1:57417/other?settings=account&schoolAuthorization=' + requestId,
  callback + '#redirect', callback + '&other=1',
  callback.replace(requestId, '00000000-0000-4000-8000-000000000008'),
  callback.replace('http://', 'http://name:password@'),
])('rejects a malformed or mismatched callback: %s', value => {
  expect(() => schoolAuthorizationReturnUrl(requestId, value)).toThrow('客户端返回地址无效')
})

it('does not open an authentication response from a different school origin', async () => {
  await expect(startSchoolAuthorization({ schoolEndpoint: 'https://school.example.edu' }, async () => ({
    ...pending, authorizationUrl: 'https://other.example.edu/?authorize=' + requestId,
  }), 'client')).rejects.toThrow('学校认证地址与学校入口不一致')
  expect(window.open).not.toHaveBeenCalled()
  expect(restoreSchoolConnection('client')).toBeNull()
})
