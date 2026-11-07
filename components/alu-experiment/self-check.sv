`timescale 1ns/1ps
// Toolchain probe only: a constant signal, not a completed student ALU.
module self_check;
  reg [3:0] value;
  integer fd;
  initial begin
    value=4'b0101;
    $dumpfile("trace.vcd"); $dumpvars(0, self_check);
    #1; fd=$fopen("xunjie-observations.txt", "w");
    $fdisplay(fd, "ROW 0 %b %b", value, 1'b0); $fclose(fd);
    #1; $finish;
  end
endmodule
