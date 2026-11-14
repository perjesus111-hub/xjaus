ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG RUST_VERSION
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils build-essential ca-certificates curl dpkg-dev fakeroot file \
    libasound2-dev libgbm-dev libgtk-3-dev libnotify-dev libnss3-dev \
    libsecret-1-dev libssl-dev libwebkit2gtk-4.1-dev libx11-xcb-dev \
    libxdo-dev libxss-dev libxtst-dev libayatana-appindicator3-dev librsvg2-dev \
    patchelf p7zip-full pkg-config rpm ruby ruby-dev squashfs-tools zstd \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
 && sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
 && chmod -R a+rX /opt/rustup /opt/cargo \
 && rm -f /tmp/rustup-init.sh

ENV XJAUS_IN_LINUX_BUILDER=1
WORKDIR /workspace
