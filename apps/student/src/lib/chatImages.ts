import type {ChatImage} from '../bridge/types'
import {getModelSettings} from './modelSettings'

export async function readChatImages(files:File[]):Promise<ChatImage[]> {
  const config=getModelSettings().data
  const model=config?.providers.flatMap(provider=>provider.models.map(model=>({provider,model})))
    .find(({provider,model})=>`custom:${provider.id}:${model.id}`===config.defaultModelId)?.model
  if(files.length&&!model?.inputTypes.includes('image'))throw new Error('当前模型未启用图片能力，请在设置中选择支持图片的模型。')
  if(files.some(file=>file.size>32*1024*1024))throw new Error('内联图片每张最多32 MiB，请缩小图片后发送。')
  if(files.reduce((sum,file)=>sum+Math.ceil(file.size/3)*4,0)>48*1024*1024-65536)throw new Error('图片编码后超过48 MiB请求上限，请减少图片或缩小尺寸。')
  return Promise.all(files.map(async file=>{
    const bytes=new Uint8Array(await file.arrayBuffer())
    const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end))
    const mime=bytes[0]===137&&ascii(1,4)==='PNG'?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':
      /^GIF8[79]a$/.test(ascii(0,6))?'image/gif':ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'?'image/webp':null
    if(!mime)throw new Error('图片格式不支持，请使用PNG、JPEG、GIF或WebP。')
    const blob=new Blob([bytes],{type:mime})
    // Decode once to catch corrupt files; never resize, transcode, or send an object URL.
    let bitmap:ImageBitmap
    try{bitmap=await createImageBitmap(blob)}catch{throw new Error(`图片无法读取：${file.name}，请重新选择有效图片。`)}
    bitmap.close()
    const dataUrl=await new Promise<string>((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error(`图片读取失败：${file.name}`));reader.readAsDataURL(blob)
    })
    return {name:file.name,dataUrl}
  }))
}
