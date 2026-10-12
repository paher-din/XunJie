#include <vpi_user.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

static const char *names[]={"clock","switches","buttons","resetN","leds","anodes","segments","dp"};
static vpiHandle signals[8];static unsigned cycles,advanced,changes,dropped;
static int high=0;static char inputs[3][32],previous[160];static uint64_t sample_count;
static void later(PLI_INT32 (*callback)(p_cb_data),unsigned delay){
  s_vpi_time time={.type=vpiSimTime,.high=0,.low=delay};
  s_cb_data cb={.reason=cbAfterDelay,.cb_rtn=callback,.time=&time};vpi_register_cb(&cb);
}
static void readonly(PLI_INT32 (*callback)(p_cb_data)){
  s_vpi_time time={.type=vpiSimTime};s_cb_data cb={.reason=cbReadOnlySynch,.cb_rtn=callback,.time=&time};vpi_register_cb(&cb);
}
static void put(unsigned index,const char *bits){s_vpi_value value={.format=vpiIntVal};value.value.integer=(PLI_INT32)strtoul(bits,NULL,2);vpi_put_value(signals[index],&value,NULL,vpiNoDelay);}
static uint64_t now(void){s_vpi_time time={.type=vpiSimTime};vpi_get_time(NULL,&time);return ((uint64_t)time.high<<32)|time.low;}
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
static PLI_INT32 sample(p_cb_data unused){
  (void)unused;frame(advanced==cycles);
  if(advanced==cycles){char end[128];int size=snprintf(end,sizeof(end),"D\t%llu\t%u\t%u\n",(unsigned long long)sample_count,changes,dropped);
    if(write(3,end,(size_t)size)!=size){vpi_control(vpiFinish,1);return 0;}
    char line[128],tail;unsigned count;
    if(!fgets(line,sizeof(line),stdin)){vpi_control(vpiFinish,0);return 0;}
    if(sscanf(line,"%u %16[01] %5[01] %1[01] %c",&count,inputs[0],inputs[1],inputs[2],&tail)!=4
      ||strlen(inputs[0])!=16||strlen(inputs[1])!=5||strlen(inputs[2])!=1||count<1||count>5000000){vpi_control(vpiFinish,1);return 0;}
    cycles=count;advanced=0;changes=0;dropped=0;sample_count=0;later(apply,1);
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
  for(unsigned i=0;i<8;i++){char path[80];snprintf(path,sizeof(path),"xunjie_board.%s",names[i]);signals[i]=vpi_handle_by_name(path,NULL);if(!signals[i]){vpi_printf("Platform signal unavailable: %s\n",names[i]);vpi_control(vpiFinish,1);return 0;}}
  /* Icarus's initialization queue has already drained at StartOfSim; drive only in the running RW phase. */
  s_vpi_time time={.type=vpiSimTime};s_cb_data cb={.reason=cbReadWriteSynch,.cb_rtn=initialize,.time=&time};vpi_register_cb(&cb);return 0;
}
static void register_bridge(void){s_cb_data cb={.reason=cbStartOfSimulation,.cb_rtn=start};vpi_register_cb(&cb);}
void (*vlog_startup_routines[])(void)={register_bridge,NULL};
