#include <vpi_user.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

static const char *names[]={"clock","switches","buttons","resetN","leds","anodes","segments","dp"};
static vpiHandle signals[8];static unsigned cycles,advanced,changes,dropped;
static int high=0;static char inputs[3][32],previous[160];static uint64_t sample_count,ticks_per_ps=1;
static vpiHandle alu_signals[17];static unsigned alu_offsets[17],alu_widths[17],alu_start,alu_count,alu_pos;
static int alu_configured=0,alu_active=0;static char alu_switches[32][17];
static int emit(const char *row){size_t size=strlen(row);if(write(3,row,size)!=(ssize_t)size){vpi_control(vpiFinish,1);return 0;}return 1;}
static int number(const char *text,unsigned max,unsigned *out){
  if(!text||!*text||strspn(text,"0123456789")!=strlen(text))return 0;
  char *end;unsigned long value=strtoul(text,&end,10);if(*end||value>max)return 0;*out=(unsigned)value;return 1;
}
static void later(PLI_INT32 (*callback)(p_cb_data),unsigned delay){
  uint64_t ticks=(uint64_t)delay*ticks_per_ps;
  s_vpi_time time={.type=vpiSimTime,.high=(PLI_UINT32)(ticks>>32),.low=(PLI_UINT32)ticks};
  s_cb_data cb={.reason=cbAfterDelay,.cb_rtn=callback,.time=&time};vpi_register_cb(&cb);
}
static void readonly(PLI_INT32 (*callback)(p_cb_data)){
  s_vpi_time time={.type=vpiSimTime};s_cb_data cb={.reason=cbReadOnlySynch,.cb_rtn=callback,.time=&time};vpi_register_cb(&cb);
}
static void put(unsigned index,const char *bits){s_vpi_value value={.format=vpiIntVal};value.value.integer=(PLI_INT32)strtoul(bits,NULL,2);vpi_put_value(signals[index],&value,NULL,vpiNoDelay);}
static uint64_t now(void){s_vpi_time time={.type=vpiSimTime};vpi_get_time(NULL,&time);return (((uint64_t)time.high<<32)|time.low)/ticks_per_ps;}
static void frame(int force){
  char body[160]="",row[256];
  for(unsigned i=1;i<8;i++){s_vpi_value value={.format=vpiBinStrVal};vpi_get_value(signals[i],&value);strcat(body,"\t");strcat(body,value.value.str);}
  sample_count++;
  if(force||strcmp(previous,body)){
    if(changes<190||force){int size=snprintf(row,sizeof(row),"F\t%llu%s\n",(unsigned long long)now(),body);if(write(3,row,(size_t)size)!=size)vpi_control(vpiFinish,1);changes++;}
    else dropped++;
    strcpy(previous,body);
  }
}
static PLI_INT32 edge(p_cb_data unused);
static PLI_INT32 apply(p_cb_data unused){(void)unused;put(1,inputs[0]);put(2,inputs[1]);put(3,inputs[2]);later(edge,4999);return 0;}
static int read_command(void){
  char line[32768];
  while(fgets(line,sizeof(line),stdin)){
    if(line[0]=='B'&&line[1]==' '){
      if(alu_configured)return 0;
      char *save=NULL,*token=strtok_r(line," \r\n",&save);unsigned count;
      (void)token;if(!number(strtok_r(NULL," \r\n",&save),17,&count)||count!=17)return 0;
      for(unsigned i=0;i<17;i++){
        char *path=strtok_r(NULL," \r\n",&save);unsigned offset,width;
        if(!path||strlen(path)>1024||strncmp(path,"xunjie_board.dut.",17)
          ||strspn(path,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.")!=strlen(path)
          ||!number(strtok_r(NULL," \r\n",&save),127,&offset)||!number(strtok_r(NULL," \r\n",&save),128,&width)||!width||offset>=width)return 0;
        alu_signals[i]=vpi_handle_by_name(path,NULL);
        if(!alu_signals[i]||vpi_get(vpiSize,alu_signals[i])!=(PLI_INT32)width)return 0;
        alu_offsets[i]=offset;alu_widths[i]=width;
      }
      if(strtok_r(NULL," \r\n",&save))return 0;
      alu_configured=1;if(!emit("C\t17\n"))return 0;continue;
    }
    if(line[0]=='P'&&line[1]==' '){
      char *save=NULL;strtok_r(line," \r\n",&save);
      if(!alu_configured||!number(strtok_r(NULL," \r\n",&save),2799,&alu_start)
        ||!number(strtok_r(NULL," \r\n",&save),32,&alu_count)||!alu_count||alu_start+alu_count>2800)return 0;
      for(unsigned i=0;i<alu_count;i++){char *bits=strtok_r(NULL," \r\n",&save);
        if(!bits||strlen(bits)!=16||strspn(bits,"01")!=16)return 0;
        memcpy(alu_switches[i],bits,17);}
      if(strtok_r(NULL," \r\n",&save))return 0;
      alu_pos=0;alu_active=1;cycles=4;advanced=0;strcpy(inputs[0],alu_switches[0]);strcpy(inputs[1],"00000");strcpy(inputs[2],"1");later(apply,1);return 1;
    }
    if(alu_configured)return 0;
    char tail;unsigned count;
    if(sscanf(line,"%u %16[01] %5[01] %1[01] %c",&count,inputs[0],inputs[1],inputs[2],&tail)!=4
      ||strlen(inputs[0])!=16||strlen(inputs[1])!=5||strlen(inputs[2])!=1||count<1||count>5000000)return 0;
    cycles=count;advanced=0;changes=0;dropped=0;sample_count=0;later(apply,1);return 1;
  }return 0;
}
static int alu_sample(void){
  char bits[18],row[96];
  for(unsigned i=0;i<17;i++){s_vpi_value value={.format=vpiBinStrVal};vpi_get_value(alu_signals[i],&value);
    if(!value.value.str||strlen(value.value.str)!=alu_widths[i])return 0;
    bits[i]=value.value.str[alu_widths[i]-1-alu_offsets[i]];if(!strchr("01xz",bits[i]))return 0;}
  bits[17]='\0';snprintf(row,sizeof(row),"A\t%u\t%llu\t%s\n",alu_start+alu_pos,(unsigned long long)now(),bits);return emit(row);
}
static PLI_INT32 sample(p_cb_data unused){
  (void)unused;
  if(alu_active){
    if(advanced>=2&&!alu_sample()){vpi_control(vpiFinish,1);return 0;}
    if(advanced<4)return 0;
    if(++alu_pos<alu_count){advanced=0;strcpy(inputs[0],alu_switches[alu_pos]);later(apply,1);return 0;}
    char end[96];snprintf(end,sizeof(end),"E\t%u\t%llu\n",alu_count*3,(unsigned long long)now());alu_active=0;
    if(!emit(end)||!read_command())vpi_control(vpiFinish,0);
    return 0;
  }
  frame(advanced==cycles);
  if(advanced==cycles){char end[128];int size=snprintf(end,sizeof(end),"D\t%llu\t%u\t%u\n",(unsigned long long)sample_count,changes,dropped);
    if(write(3,end,(size_t)size)!=size){vpi_control(vpiFinish,1);return 0;}
    if(!read_command())vpi_control(vpiFinish,0);
  }
  return 0;
}
static PLI_INT32 edge(p_cb_data unused){(void)unused;high=!high;put(0,high?"1":"0");
  if(!high){advanced++;readonly(sample);}
  if(high||advanced<cycles)later(edge,5000);
  return 0;
}
static PLI_INT32 initialize(p_cb_data unused){(void)unused;
  put(0,"0");put(1,"0000000000000000");put(2,"00000");put(3,"1");readonly(sample);return 0;
}
static PLI_INT32 start(p_cb_data unused){(void)unused;
  /* SimTime callbacks use the design's global precision, which student RTL may make finer than the board's 1ps. */
  int precision=vpi_get(vpiTimePrecision,NULL);
  if(precision> -12||precision< -15){vpi_printf("Unsupported platform time precision\n");vpi_control(vpiFinish,1);return 0;}
  for(int exponent=precision;exponent< -12;exponent++)ticks_per_ps*=10;
  for(unsigned i=0;i<8;i++){char path[80];snprintf(path,sizeof(path),"xunjie_board.%s",names[i]);signals[i]=vpi_handle_by_name(path,NULL);if(!signals[i]){vpi_printf("Platform signal unavailable: %s\n",names[i]);vpi_control(vpiFinish,1);return 0;}}
  /* Icarus's initialization queue has already drained at StartOfSim; drive only in the running RW phase. */
  s_vpi_time time={.type=vpiSimTime};s_cb_data cb={.reason=cbReadWriteSynch,.cb_rtn=initialize,.time=&time};vpi_register_cb(&cb);return 0;
}
static void register_bridge(void){s_cb_data cb={.reason=cbStartOfSimulation,.cb_rtn=start};vpi_register_cb(&cb);}
void (*vlog_startup_routines[])(void)={register_bridge,NULL};
