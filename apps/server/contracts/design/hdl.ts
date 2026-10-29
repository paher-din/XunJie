import {z} from 'zod';
import {validateBoard} from '../internal/hdl-board.ts';
const id=z.string().min(1).max(128),hash=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const hdlRuntimeSchema=z.strictObject({runtimeProfileVersion:id,engineVersion:id,buildImage:image,runtimeImage:image,sourceHash:hash});
export const boardSchema=z.strictObject({boardProfileVersion:id,mappingVersion:id,topModule:id,bindings:z.array(z.strictObject({
 signal:z.enum(['clock','switches','buttons','resetN','leds','anodes','segments','dp']),offset:z.number().int().nonnegative(),port:id,portOffset:z.number().int().nonnegative(),width:z.number().int().min(1).max(16)}))}).superRefine((board,ctx)=>{
 try{validateBoard(board);}catch{ctx.addIssue({code:'custom',message:'Invalid board bindings.'});}
});
export const definedAluOperations=[
 {mode:'0',code:'00',meaning:'not_a'},{mode:'0',code:'01',meaning:'and'},
 {mode:'0',code:'10',meaning:'or'},{mode:'0',code:'11',meaning:'xor'},
 {mode:'1',code:'00',meaning:'add_with_carry'},{mode:'1',code:'01',meaning:'subtract_with_borrow'},
] as const;
export const hdlConfigurationSchema=z.strictObject({versionId:id,board:boardSchema,runtime:hdlRuntimeSchema,
 signals:z.strictObject({bitOrder:z.literal('msb_first'),clockHz:z.literal(100000000),initialClock:z.literal('0'),initialSwitches:z.literal('0000000000000000'),initialButtons:z.literal('00000'),initialResetN:z.literal('1'),stableSampling:z.literal('low_phase'),
 anodesActive:z.literal('low'),segmentsActive:z.literal('low'),dpActive:z.literal('low')}),
 alu:z.strictObject({operandWidth:z.literal(4),resultWidth:z.literal(4),carryWidth:z.literal(1),signedness:z.literal('unsigned'),
 operations:z.array(z.strictObject({mode:z.enum(['0','1']),code:z.enum(['00','01','10','11']),meaning:z.enum(['not_a','and','or','xor','add_with_carry','subtract_with_borrow'])})).length(6),
 subtractionOperandDomain:z.literal('a_gt_b'),undefinedArithmeticSelectors:z.literal('ungraded'),subtractionOutsideDomain:z.literal('ungraded'),nonAdditionCout:z.literal('ungraded'),
 switchMapping:z.array(z.strictObject({semantic:z.enum(['operand_a','operand_b','mode','select','carry_in']),offset:z.number().int().min(0).max(15),width:z.number().int().min(1).max(4)})).length(5)}).superRefine((alu,ctx)=>{
 const bits=new Set<number>(),semantics=new Set<string>(),widths={operand_a:4,operand_b:4,mode:1,select:2,carry_in:1};
 for(const mapping of alu.switchMapping){if(semantics.has(mapping.semantic))ctx.addIssue({code:'custom',message:'Duplicate semantic.'});semantics.add(mapping.semantic);
 if(mapping.width!==widths[mapping.semantic])ctx.addIssue({code:'custom',message:'Fixed ALU signal width mismatch.'});
 if(mapping.offset+mapping.width>16)ctx.addIssue({code:'custom',message:'SW width exceeded.'});
 for(let n=mapping.offset;n<mapping.offset+mapping.width;n++){if(bits.has(n))ctx.addIssue({code:'custom',message:'SW overlap.'});bits.add(n);}}
 for(const semantic of Object.keys(widths))if(!semantics.has(semantic))ctx.addIssue({code:'custom',message:'Missing ALU semantic.'});
 for(const expected of definedAluOperations)if(alu.operations.filter(op=>op.mode===expected.mode&&op.code===expected.code&&op.meaning===expected.meaning).length!==1)ctx.addIssue({code:'custom',message:'Invalid fixed ALU operation domain.'});
 }),structuralCoverage:z.literal('board_bindings_and_defined_alu_domain')});
export const hdlActivityRuntimeSchema=z.strictObject({kind:z.literal('hdl_board'),runtimeProfileVersion:id,configuration:hdlConfigurationSchema,contentHash:hash}).refine(value=>value.runtimeProfileVersion===value.configuration.runtime.runtimeProfileVersion);
export const hdlCheckRuleSchema=z.strictObject({versionId:z.literal('hdl-board-structure-v1'),validatorVersion:z.literal('hdl-board-structure-v1'),limitedHelp:z.literal(false),description:z.string().min(1)});
export const hdlExecutionStatusSchema=z.strictObject({kind:z.literal('hdl_board'),structural:z.literal('validated'),behavior:z.literal('unverified')});
export type HdlConfiguration=z.infer<typeof hdlConfigurationSchema>;
