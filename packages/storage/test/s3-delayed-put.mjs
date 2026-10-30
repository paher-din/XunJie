import { createServer, request } from 'node:http';

/** Lose the request connection, but let the original signed PUT reach real S3 later. */
export async function delayedPut(endpoint) {
  const origin = new URL(endpoint);
  const outgoing = new Set();
  let original;
  const server = createServer((incoming,response) => {
    if(incoming.method==='PUT' && !original) {
      const chunks=[];
      incoming.on('data',chunk=>chunks.push(chunk));
      incoming.on('end',()=>{
        original={path:incoming.url,headers:incoming.headers,body:Buffer.concat(chunks)};
        response.destroy();
      });
      return;
    }
    const upstream=request(new URL(incoming.url,origin),{method:incoming.method,headers:incoming.headers},reply=>{
      response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);
    });
    outgoing.add(upstream);upstream.once('close',()=>outgoing.delete(upstream));
    upstream.on('error',()=>response.destroy());incoming.pipe(upstream);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  return {
    endpoint:`http://127.0.0.1:${server.address().port}`,
    async release() {
      if(!original) throw new Error('Original PUT has not reached the relay');
      return new Promise((resolve,reject)=>{
        const upstream=request(new URL(original.path,origin),{method:'PUT',headers:original.headers},reply=>{
          reply.resume();reply.once('end',()=>resolve(reply.statusCode));reply.on('error',reject);
        });
        outgoing.add(upstream);upstream.once('close',()=>outgoing.delete(upstream));
        upstream.on('error',reject);upstream.end(original.body);
      });
    },
    async close() {
      const stopped=new Promise(done=>server.close(done));server.closeAllConnections();
      for(const upstream of outgoing) upstream.destroy();await stopped;
    },
  };
}
