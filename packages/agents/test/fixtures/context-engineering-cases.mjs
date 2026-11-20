/** Fixed first-batch cases. Values are deliberately stable so input and quality checks are comparable. */
export const digitalLogicCase = Object.freeze({
  releaseId: '11111111-1111-4111-8111-111111111111',
  contentDigest: 'a'.repeat(64),
  taskTitle: 'ALU 操作与进位',
  workV7: { objectId: '22222222-2222-4222-8222-222222222222', contentId: 'b'.repeat(64),
    name: 'alu.sv', kind: 'code', encoding: 'utf8', mediaType: 'text/plain',
    value: 'module alu(input [3:0] A, B, input M, S, Cin, output [3:0] F, output Cout); endmodule' },
  workV8: { objectId: '33333333-3333-4333-8333-333333333333', contentId: 'c'.repeat(64),
    name: 'alu.sv', kind: 'code', encoding: 'utf8', mediaType: 'text/plain',
    value: 'module alu(input [3:0] A, B, input M, S, Cin, output [3:0] F, output Cout); assign F=A; endmodule' },
  questionV7: '这版 alu.sv 在 A=15、B=1、M=1、S=0、Cin=1 时，进位应该从哪里检查？',
  correction: '我改的是 v8；上面问的是 v7，请按 v7 回答。',
  prediction: { predictedF: '0000', predictedCout: '1', reason: 'A+B 溢出，低四位为 0' },
  execution: { requestId: '44444444-4444-4444-8444-444444444444', executionRef: '55555555-5555-4555-8555-555555555555',
    inputDigest: 'd'.repeat(64), input: { A: 15, B: 1, M: 1, S: 0, Cin: 1 }, output: { f: '0001', cout: '1', observationState: 'complete' } },
});

export const cLanguageCase = Object.freeze({
  workV3: { objectId: '66666666-6666-4666-8666-666666666666', contentId: 'e'.repeat(64), name: 'loop.c',
    value: 'int main(void){ int sum=0; for(int i=0;i<3;i++) sum+=i; return sum; }' },
  workV4: { objectId: '77777777-7777-4777-8777-777777777777', contentId: 'f'.repeat(64), name: 'loop.c',
    value: 'int main(void){ int sum=0; for(int i=1;i<=3;i++) sum+=i; return sum; }' },
  prediction: 'sum 最终是 3，因为只累加 0、1、2',
  testOutput: 'expected sum=3, observed 6 for inputs 1..3',
  correction: '上面的预测对应 v3；我现在问 v4 的测试输出。',
});
