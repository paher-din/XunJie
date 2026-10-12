import {z} from 'zod';
import {validateBoard} from '../../runner/hdl-profile.ts';
const id=z.string().min(1).max(128),hash=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const hdlRuntimeSchema=z.strictObject({runtimeProfileVersion:id,engineVersion:id,buildImage:image,runtimeImage:image,sourceHash:hash});
export const boardSchema=z.strictObject({boardProfileVersion:id,mappingVersion:id,topModule:id,bindings:z.array(z.strictObject({
 signal:z.enum(['clock','switches','buttons','resetN','leds','anodes','segments','dp']),offset:z.number().int().nonnegative(),port:id,portOffset:z.number().int().nonnegative(),width:z.number().int().min(1).max(16)}))}).superRefine((board,ctx)=>{
 try{validateBoard(board);}catch{ctx.addIssue({code:'custom',message:'Invalid board bindings.'});}
});
export const hdlConfigurationSchema=z.strictObject({versionId:id,board:boardSchema,runtime:hdlRuntimeSchema,
 signals:z.strictObject({bitOrder:z.literal('msb_first'),clockHz:z.literal(100000000),initialClock:z.literal('0'),initialSwitches:z.literal('0000000000000000'),initialButtons:z.literal('00000'),initialResetN:z.literal('1'),stableSampling:z.literal('low_phase'),
 anodesActive:z.enum(['low','high']),segmentsActive:z.enum(['low','high']),dpActive:z.enum(['low','high'])}),
 alu:z.strictObject({operandWidth:z.number().int().min(1).max(16),operations:z.array(z.strictObject({code:z.string().regex(/^[01]{1,16}$/),meaning:z.enum(['add','subtract','and','or','xor','not','shift_left','shift_right','compare'])})).min(1).max(16),
 switchMapping:z.array(z.strictObject({semantic:z.enum(['operand_a','operand_b','operation','enable']),offset:z.number().int().min(0).max(15),width:z.number().int().min(1).max(16)})).min(3).max(4)}).superRefine((alu,ctx)=>{
 const bits=new Set<number>(),semantics=new Set<string>();
 for(const mapping of alu.switchMapping){if(semantics.has(mapping.semantic))ctx.addIssue({code:'custom',message:'Duplicate semantic.'});semantics.add(mapping.semantic);
 if(mapping.offset+mapping.width>16)ctx.addIssue({code:'custom',message:'SW width exceeded.'});
 for(let n=mapping.offset;n<mapping.offset+mapping.width;n++){if(bits.has(n))ctx.addIssue({code:'custom',message:'SW overlap.'});bits.add(n);}
 if(['operand_a','operand_b'].includes(mapping.semantic)&&mapping.width!==alu.operandWidth)ctx.addIssue({code:'custom',message:'Operand width mismatch.'});}
 for(const semantic of ['operand_a','operand_b','operation'])if(!semantics.has(semantic))ctx.addIssue({code:'custom',message:'Missing ALU semantic.'});
 const width=alu.switchMapping.find(mapping=>mapping.semantic==='operation')?.width;
 if(new Set(alu.operations.map(op=>op.code)).size!==alu.operations.length||alu.operations.some(op=>op.code.length!==width))ctx.addIssue({code:'custom',message:'Invalid operation domain.'});
 }),structuralCoverage:z.literal('board_bindings_and_defined_alu_domain')});
export const hdlActivityRuntimeSchema=z.strictObject({kind:z.literal('hdl_board'),runtimeProfileVersion:id,configuration:hdlConfigurationSchema,contentHash:hash}).refine(value=>value.runtimeProfileVersion===value.configuration.runtime.runtimeProfileVersion);
export const hdlCheckRuleSchema=z.strictObject({versionId:z.literal('hdl-board-structure-v1'),validatorVersion:z.literal('hdl-board-structure-v1'),limitedHelp:z.literal(false),description:z.string().min(1)});
export const hdlExecutionStatusSchema=z.strictObject({kind:z.literal('hdl_board'),structural:z.literal('validated'),behavior:z.literal('unverified')});
export type HdlConfiguration=z.infer<typeof hdlConfigurationSchema>;
