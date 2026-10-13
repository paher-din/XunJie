ARG HDL_BASE=ubuntu@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b
FROM ${HDL_BASE} AS build
RUN apt-get update && apt-get install --no-install-recommends -y iverilog=12.0-2build2 gcc libc6-dev
COPY hdl-ports.c hdl-host.c hdl-bridge.c /trusted/
RUN gcc -Wall -Wextra -Werror -shared -fPIC -I/usr/include/iverilog /trusted/hdl-ports.c -o /usr/lib/x86_64-linux-gnu/ivl/xunjie_ports.tgt \
 && printf 'flag:DLL=/usr/lib/x86_64-linux-gnu/ivl/xunjie_ports.tgt\n' > /usr/lib/x86_64-linux-gnu/ivl/xunjie_ports.conf \
 && cd /trusted && iverilog-vpi hdl-bridge.c && mv hdl-bridge.vpi xunjie.vpi \
 && gcc -Wall -Wextra -Werror /trusted/hdl-host.c -o /trusted/host \
 && mkdir -p /runtime/usr/bin /runtime/trusted /runtime/usr/lib/x86_64-linux-gnu/ivl \
 && cp /usr/bin/vvp /runtime/usr/bin/vvp && cp /trusted/host /trusted/xunjie.vpi /runtime/trusted/ \
 && cp /usr/lib/x86_64-linux-gnu/ivl/*.vpi /runtime/usr/lib/x86_64-linux-gnu/ivl/ \
 && ldd /usr/bin/vvp /trusted/host /trusted/xunjie.vpi /usr/lib/x86_64-linux-gnu/ivl/*.vpi \
    | awk '/=> \// {print $3} /^\s*\/.*ld-linux/ {print $1}' | sort -u | xargs -r -I '{}' cp --parents '{}' /runtime/ \
 && cp --parents /lib64/ld-linux-x86-64.so.2 /runtime/ \
 && dpkg-query -W > /trusted/packages.txt
FROM scratch AS runtime
COPY --from=build /runtime/ /
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/trusted/host"]
