// HTTP fault fixture, not the real S3 compatibility acceptance test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

export async function s3HttpFixture(t) {
  const state = { objects: new Map(), requests: [], respond: undefined };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      state.requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      assert.match(request.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/test-region\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[a-f0-9]{64}$/);
      assert.match(request.headers['x-amz-date'] ?? '', /^\d{8}T\d{6}Z$/);
      if (request.method === 'PUT') {
        assert.equal(request.headers['if-none-match'], '*');
        assert.ok(request.headers.authorization.includes('if-none-match'));
      }
      if (await state.respond?.(request, response, body)) return;
      const key = request.url;
      if (request.method === 'PUT') {
        if (state.objects.has(key)) { response.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
        state.objects.set(key, body);
        response.writeHead(200).end();
      } else if (request.method === 'GET') {
        const bytes = state.objects.get(key);
        if (bytes === undefined) response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
        else response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
      } else if (request.method === 'DELETE') {
        state.objects.delete(key);
        response.writeHead(204).end();
      } else response.writeHead(405).end();
    } catch (error) {
      state.error = error;
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    if (state.error) throw state.error;
  });
  return { state, options: { id: 's3', endpoint: `http://127.0.0.1:${server.address().port}`, region: 'test-region',
    bucket: 'test-bucket', accessKeyId: 'test-access', secretAccessKey: 'test-secret', requestTimeoutMs: 500 } };
}
