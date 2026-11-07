`timescale 1ns/1ps
module experiment;
  reg [3:0] A, B;
  reg M, Cin;
  reg [1:0] S;
  wire [3:0] F;
  wire Cout;
  integer fd, ignored;
  alu dut(.A(A), .B(B), .M(M), .S(S), .Cin(Cin), .F(F), .Cout(Cout));
  initial begin
    A=0; B=0; M=0; S=0; Cin=0;
    ignored=$value$plusargs("A=%d", A);
    ignored=$value$plusargs("B=%d", B);
    ignored=$value$plusargs("M=%d", M);
    ignored=$value$plusargs("S=%d", S);
    ignored=$value$plusargs("Cin=%d", Cin);
    $dumpfile("trace.vcd"); $dumpvars(0, experiment);
    #1;
    fd=$fopen("xunjie-observations.txt", "w");
    $fdisplay(fd, "ROW 0 %b %b", F, Cout); $fclose(fd);
    #1; $finish;
  end
endmodule
