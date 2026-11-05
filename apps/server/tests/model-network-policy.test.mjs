import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { modelAddressAllowed, resolveModelTarget, validateModelTarget, modelTargetFetch } from '../../../packages/learning-space/src/model-connections/network-policy.ts';

const configuration = baseUrl => ({ baseUrl, path: '/chat/completions' });
const denied = action => assert.rejects(action, error => error.code === 'forbidden');

test('ordinary school connections exclude private, special and encoded IP targets', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '192.0.2.1', '198.18.0.1', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1',
    '2002:7f00:1::', '2001:db8::1']) assert.equal(modelAddressAllowed(address, 'public'), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.equal(modelAddressAllowed(address, 'public'), true, address);
  for (const baseUrl of ['http://localhost/v1', 'https://127.1/v1', 'https://2130706433/v1', 'https://0x7f000001/v1',
    'https://[::ffff:127.0.0.1]/v1', 'https://10.0.0.1/v1', 'https://metadata.internal/v1'])
    await denied(() => validateModelTarget(configuration(baseUrl), 'public'));
});

test('DNS validation rejects every private answer, including mixed records and rebinding', async () => {
  const config = configuration('https://models.example/v1');
  let addresses = [{ address: '8.8.8.8', family: 4 }];
  const resolve = async () => addresses;
  await validateModelTarget(config, 'public', resolve);
  addresses = [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await denied(() => resolveModelTarget(config, 'public', resolve));
  addresses = [{ address: '::ffff:7f00:1', family: 6 }];
  await denied(() => modelTargetFetch(config, 'public', resolve));
});

test('authorized holders pin DNS to the checked address and never follow redirects', async () => {
  let requests = 0, resolutions = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, '/v1/chat/completions');
    if (requests === 1) response.end('allowed');
    else { response.writeHead(302, { location: '/internal' }); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = configuration(`http://localhost:${server.address().port}/v1`);
    for (const holder of ['device', 'school-approved']) {
      const pinned = await modelTargetFetch(config, holder, async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; });
      if (holder === 'device') assert.equal(await (await pinned(config.baseUrl + config.path)).text(), 'allowed');
      else await assert.rejects(pinned(config.baseUrl + config.path));
      await denied(() => pinned(config.baseUrl + '/other'));
    }
    assert.equal(requests, 2);
    assert.equal(resolutions, 2);
    await denied(() => modelTargetFetch(config, 'public'));
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
