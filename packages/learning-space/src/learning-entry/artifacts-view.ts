import { teachingArtifactResourceSchema } from '@xunjie/contracts/teaching-artifacts';
import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';

/** A fixed resource runs only after its parent supplies the existing host SDK and one private port. */
export function artifactViewDocument(value: unknown, expectedDigest: string | null) {
  const resource = teachingArtifactResourceSchema.parse(value), bytes = Buffer.from(resource.contentBase64, 'base64');
  if (expectedDigest !== resource.sha256) throw new StorageError('conflict');
  if (bytes.length !== resource.byteLength || createHash('sha256').update(bytes).digest('hex') !== resource.sha256)
    throw new StorageError('corrupt');
  const document = bytes.toString('utf8'), end = '</script></body></html>', start = document.lastIndexOf('<script>');
  if (start < 0 || !document.endsWith(end)) throw new StorageError('corrupt');
  // Read the retained script, never executable source supplied by the iframe or the bootstrap caller.
  const script = JSON.stringify(document.slice(start + '<script>'.length, -end.length)).replace(/</g, '\\u003c');
  const loader = `(function(){let connected=false;addEventListener('message',function(event){
    const p=event.data?.payload,i=p?.initialize;
    if(connected||event.source!==parent||event.data?.method!=='host.bootstrap'||!event.ports[0]
      ||typeof p?.sdk!=='string'||p.sdk.length>100000||i?.hostApiVersion!==1||i.method!=='host.initialize'
      ||typeof i.connectionId!=='string'||typeof i.instanceId!=='string')return;
    connected=true;const sdk=document.createElement('script');sdk.textContent=p.sdk;document.body.append(sdk);
    dispatchEvent(new MessageEvent('message',{source:parent,data:i,ports:[event.ports[0]]}));
    const source=document.createElement('script');source.textContent=${script};document.body.append(source);
  });})();`;
  const defaults = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>'
    + 'body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'
    + 'h1,h2,h3{font-weight:600;font-family:"LXGW WenKai","Kaiti SC",STKaiti,serif}h1{font-size:28px}h2,h3{font-size:17px}h3{font-weight:400}button,input,textarea,select{font:inherit;color:inherit}input,textarea,select{background:var(--canvas);border:1px solid var(--line);border-radius:8px;padding:6px 8px}'
    + 'button{min-height:32px;font-size:13px;background:var(--canvas);border:1px solid var(--line);border-radius:8px;padding:4px 16px;cursor:pointer}'
    + ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}*{box-sizing:border-box}</style>';
  return document.slice(0, start).replace('<head>', '<head>' + defaults) + '<script>' + loader + '</script></body></html>';
}
