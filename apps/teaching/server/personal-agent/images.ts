import {z} from 'zod';
import {ApiError} from '../app/errors.ts';
import type {CompatibleMessage, ModelSelection} from './types.ts';

// Official Vision inline limits, independent of thinking time.
export const IMAGE_REQUEST_BYTES=48*1024*1024;
export const imageSchema=z.strictObject({name:z.string().min(1).max(255),dataUrl:z.string().max(Math.ceil(32*1024*1024/3)*4+32)});
export type ChatImage=z.infer<typeof imageSchema>;

function dimensions(bytes:Buffer,mime:string):[number,number] {
  if(mime==='image/png'&&bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(8)===13){
    let offset=8,hasPixels=false;
    while(offset+12<=bytes.length){
      const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
      if(offset+12+length>bytes.length)break;
      if(type==='IDAT'&&length)hasPixels=true;
      offset+=length+12;
      if(type==='IEND'&&length===0&&offset===bytes.length&&hasPixels)return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
    }
  }
  if(mime==='image/gif'&&bytes.length>=14&&bytes.at(-1)===59&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return [bytes.readUInt16LE(6),bytes.readUInt16LE(8)];
  if(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217){
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===217||marker===218)break;
      if(marker===1||marker!==undefined&&marker>=208&&marker<=215)continue;
      if(offset+2>bytes.length)break;
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
      if(marker!==undefined&&[192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)
        return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
      offset+=length;
    }
  }
  if(mime==='image/webp'&&bytes.length>=25&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length){
    const kind=bytes.toString('ascii',12,16);
    if(kind==='VP8X'&&bytes.length>=30)return [1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3)];
    if(kind==='VP8 '&&bytes.length>=30&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42)return [bytes.readUInt16LE(26)&16383,bytes.readUInt16LE(28)&16383];
    if(kind==='VP8L'&&bytes[20]===47){const packed=bytes.readUInt32LE(21);return [(packed&16383)+1,((packed>>>14)&16383)+1];}
  }
  throw new ApiError('INVALID_REQUEST');
}

export function validateImages(images:ChatImage[],selection:ModelSelection):void {
  if(!images.length)return;
  if(!selection.inputTypes?.includes('image'))throw new ApiError('INVALID_CONFIGURATION');
  const deepseek=new URL(selection.baseUrl).hostname==='api.deepseek.com';
  if(deepseek&&(selection.model!=='deepseek-flash'||images.length>600))throw new ApiError('INVALID_CONFIGURATION');
  let total=0;
  for(const image of images){
    const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if(!match)throw new ApiError('INVALID_REQUEST');
    const bytes=Buffer.from(match[2]!, 'base64');
    if(!bytes.length||bytes.length>32*1024*1024||bytes.toString('base64')!==match[2])throw new ApiError('CONTENT_LIMIT');
    const [width,height]=dimensions(bytes,match[1]!);
    if(!width||!height)throw new ApiError('INVALID_REQUEST');
    if(deepseek&&Math.max(width,height)>(images.length>=15?4096:8192))throw new ApiError('CONTENT_LIMIT');
    total+=image.dataUrl.length;
  }
  if(total>IMAGE_REQUEST_BYTES)throw new ApiError('CONTENT_LIMIT');
}

/** Encoded pixel bytes are not text tokens. Other providers own their image-token calculation. */
export function inputTokenUpper(messages:CompatibleMessage[],selection:ModelSelection):number {
  let imageCount=0;
  const textOnly=messages.map(message=>({...message,content:typeof message.content==='string'?message.content:message.content.flatMap(part=>{
    if(part.type==='text')return [part];imageCount++;return [];
  })}));
  return Buffer.byteLength(JSON.stringify(textOnly),'utf8')+256+(new URL(selection.baseUrl).hostname==='api.deepseek.com'?imageCount*1024:0);
}
