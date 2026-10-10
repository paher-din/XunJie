FROM scratch
WORKDIR /work
USER 65534:65534
ENTRYPOINT ["/work/textscope"]
