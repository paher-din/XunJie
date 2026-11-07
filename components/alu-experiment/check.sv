`timescale 1ns/1ps
// Read-only 4096-input observation scaffold for the full-behaviour check.
//
// For every target index it first applies one fixed precursor for 1 ns, then the target input, then
// records F/Cout after the selected sampling delay. It contains no expected values and compares
// nothing: the host adapter reads these public rows and judges them against the published rule.
//
// ROUND selects the precursor: 0 = P0 (A=0, B=0, M=1, S=00, Cin=0),
//                            1 = P1 (A=15, B=15, M=1, S=00, Cin=1).
// SAMPLE selects the delay after the target is applied: 1 = 1 ns, 2 = 2 ns.
module experiment;
  reg [3:0] A, B;
  reg M, Cin;
  reg [1:0] S;
  wire [3:0] F;
  wire Cout;
  integer fd, i, round, sample, ignored;
  alu dut(.A(A), .B(B), .M(M), .S(S), .Cin(Cin), .F(F), .Cout(Cout));
  initial begin
    round = 0;
    sample = 1;
    ignored = $value$plusargs("ROUND=%d", round);
    ignored = $value$plusargs("SAMPLE=%d", sample);
    if (round != 0 && round != 1) round = 0;
    if (sample != 1 && sample != 2) sample = 1;
    $dumpfile("trace.vcd");
    // Only this wrapper's public ports and controls, not the student's internal signals.
    $dumpvars(1, experiment);
    fd = $fopen("xunjie-observations.txt", "w");
    for (i = 0; i < 4096; i = i + 1) begin
      if (round == 1) begin
        A = 4'd15; B = 4'd15; M = 1'b1; S = 2'b00; Cin = 1'b1;
      end else begin
        A = 4'd0; B = 4'd0; M = 1'b1; S = 2'b00; Cin = 1'b0;
      end
      #1;
      A = (i >> 5) & 4'hf;
      B = (i >> 1) & 4'hf;
      M = (i >> 11) & 1;
      S = (i >> 9) & 2'b11;
      Cin = i & 1;
      if (sample == 2) #2;
      else #1;
      $fdisplay(fd, "ROW %0d %b %b", i, F, Cout);
    end
    $fclose(fd);
    $finish;
  end
endmodule
