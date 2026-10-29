#include <stdio.h>
#include <string.h>
#include <ivl_target.h>

static unsigned instances=0,ports_count=0;static int complete=1;
static int safe_name(const char *name){return name&&strlen(name)<=128&&strspn(name,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")==strlen(name);}
static int ports(FILE *out,ivl_scope_t scope){
  unsigned written=0;fputs("[",out);
  for(unsigned i=0;i<ivl_scope_sigs(scope);i++){
    ivl_signal_t signal=ivl_scope_sig(scope,i);ivl_signal_port_t direction=ivl_signal_port(signal);
    if(direction==IVL_SIP_NONE)continue;
    if(ivl_signal_packed_dimensions(signal)>1||!safe_name(ivl_signal_basename(signal))||++ports_count>4096){complete=0;continue;}
    int left=ivl_signal_packed_dimensions(signal)?ivl_signal_packed_msb(signal,0):0;
    int right=ivl_signal_packed_dimensions(signal)?ivl_signal_packed_lsb(signal,0):0;
    fprintf(out,"%s{\"name\":\"%s\",\"direction\":\"%s\",\"width\":%u,\"left\":%d,\"right\":%d}",written++?",":"",ivl_signal_basename(signal),
      direction==IVL_SIP_INPUT?"input":direction==IVL_SIP_OUTPUT?"output":"inout",ivl_signal_width(signal),left,right);
  }fputs("]",out);return 0;
}
static void hierarchy(FILE *out,ivl_scope_t scope,const char **path,unsigned depth){
  if(depth>16||instances>=512){complete=0;return;}
  if(ivl_scope_type(scope)!=IVL_SCT_MODULE){complete=0;return;}
  fputs(instances++?",{\"instanceSegments\":[":"{\"instanceSegments\":[",out);
  for(unsigned i=0;i<depth;i++)fprintf(out,"%s\"%s\"",i?",":"",path[i]);
  fputs("],\"ports\":",out);ports(out,scope);fputs("}",out);
  for(size_t i=0;i<ivl_scope_childs(scope);i++){
    ivl_scope_t child=ivl_scope_child(scope,i);
    if(ivl_scope_type(child)==IVL_SCT_FUNCTION||ivl_scope_type(child)==IVL_SCT_TASK)continue;
    if(depth>=16||!safe_name(ivl_scope_basename(child))){complete=0;continue;}
    path[depth]=ivl_scope_basename(child);hierarchy(out,child,path,depth+1);
  }
}

int target_design(ivl_design_t design) {
  ivl_scope_t *roots; unsigned count;
  ivl_design_roots(design,&roots,&count);
  ivl_scope_t root=NULL;
  for(unsigned i=0;i<count;i++)if(ivl_scope_type(roots[i])==IVL_SCT_MODULE){if(root)return 1;root=roots[i];}
  if(!root)return 1;
  FILE *out=fopen(ivl_design_flag(design,"-o"),"w");
  if(!out)return 1;
  const char *enabled=ivl_design_flag(design,"XUNJIE_HIERARCHY");
  int with_hierarchy=enabled&&strcmp(enabled,"1")==0;
  if(with_hierarchy)fputs("{\"ports\":",out);
  fputs("[",out);unsigned written=0;
  for(unsigned i=0;i<ivl_scope_sigs(root);i++){
    ivl_signal_t signal=ivl_scope_sig(root,i);
    ivl_signal_port_t direction=ivl_signal_port(signal);
    if(direction==IVL_SIP_NONE)continue;
    if(ivl_signal_packed_dimensions(signal)>1){fclose(out);return 1;}
    const char *name=ivl_signal_basename(signal);
    if(strspn(name,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")!=strlen(name)){fclose(out);return 1;}
    int left=ivl_signal_packed_dimensions(signal)?ivl_signal_packed_msb(signal,0):0;
    int right=ivl_signal_packed_dimensions(signal)?ivl_signal_packed_lsb(signal,0):0;
    fprintf(out,"%s{\"name\":\"%s\",\"direction\":\"%s\",\"width\":%u,\"left\":%d,\"right\":%d}",
      written++?",":"",name,direction==IVL_SIP_INPUT?"input":direction==IVL_SIP_OUTPUT?"output":"inout",ivl_signal_width(signal),left,right);
  }
  fputs("]",out);
  if(with_hierarchy){const char *path[17];fputs(",\"elaboration\":{\"instances\":[",out);hierarchy(out,root,path,0);
    fprintf(out,"],\"complete\":%s}}",complete?"true":"false");}
  fputs("\n",out);return fclose(out)!=0;
}
const char *target_query(const char *key){return strcmp(key,"version")==0?"xunjie-ports-v1":NULL;}
