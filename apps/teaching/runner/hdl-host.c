#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>
#include <stdlib.h>
int main(void){
  int channel[2];if(pipe(channel))return 120;
  pid_t child=fork();if(child<0)return 120;
  if(!child){close(channel[0]);if(dup2(channel[1],3)<0||dup2(2,1)<0)return 120;if(channel[1]!=3)close(channel[1]);
    execl("/usr/bin/vvp","vvp","-n","-M/trusted","-mxunjie","/build/design.vvp",(char*)NULL);return 121;}
  close(channel[1]);char bytes[4096];ssize_t size;
  while((size=read(channel[0],bytes,sizeof(bytes)))>0){ssize_t offset=0;while(offset<size){ssize_t n=write(1,bytes+offset,(size_t)(size-offset));if(n<0){if(errno==EINTR)continue;return 122;}offset+=n;}}
  close(channel[0]);int status;if(waitpid(child,&status,0)<0)return 123;
  return WIFEXITED(status)?WEXITSTATUS(status):124;
}
