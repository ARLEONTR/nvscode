ARG CODE_SERVER_VERSION=4.96.4
FROM codercom/code-server:${CODE_SERVER_VERSION}

ARG TARGETARCH
ARG PANDOC_VERSION=3.9
ARG TYPST_VERSION=0.14.2

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "$TARGETARCH" in \
    arm64) PANDOC_ARCH='arm64' ;; \
    amd64) PANDOC_ARCH='amd64' ;; \
    *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${PANDOC_ARCH}.tar.gz" -o /tmp/pandoc.tar.gz; \
  mkdir -p /tmp/pandoc; \
  tar -xzf /tmp/pandoc.tar.gz -C /tmp/pandoc --strip-components=1; \
  install -m 0755 /tmp/pandoc/bin/pandoc /usr/local/bin/pandoc; \
  rm -rf /tmp/pandoc /tmp/pandoc.tar.gz

RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) TYPST_ARCH='aarch64-unknown-linux-musl' ;; \
      amd64) TYPST_ARCH='x86_64-unknown-linux-musl' ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${TYPST_ARCH}.tar.xz" -o /tmp/typst.tar.xz; \
    mkdir -p /tmp/typst; \
    tar -xJf /tmp/typst.tar.xz -C /tmp/typst --strip-components=1; \
    install -m 0755 /tmp/typst/typst /usr/local/bin/typst; \
    rm -rf /tmp/typst /tmp/typst.tar.xz

USER coder