#!/usr/bin/env bash
set -eu

ensure_mise() {
  if command -v mise >/dev/null 2>&1; then
    return
  fi

  # arm64 用 musl 变体（静态链接），避免 gnu 版对 GLIBC_2.38+ 的依赖。
  case "$(uname -m)" in
    x86_64)  MISE_ARCH=x64 ;;
    aarch64|arm64) MISE_ARCH=arm64-musl ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac

  curl -fsSL "${MISE_INSTALL_URL:-https://mise.run}" \
    | MISE_INSTALL_PATH=/usr/local/bin/mise MISE_INSTALL_FROM_GITHUB=1 MISE_INSTALL_ARCH="${MISE_ARCH}" sh
}

ensure_opencode() {
  if opencode --version >/dev/null 2>&1; then
    return
  fi

  # 直接从 GitHub Releases 拉 tarball，绕开 opencode.ai/install 脚本对
  # api.github.com 的依赖（共享 IP 易触发限流）。
  case "$(uname -m)" in
    x86_64)  OC_ARCH=x64 ;;
    aarch64|arm64) OC_ARCH=arm64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac

  curl -fsSL -o /tmp/opencode.tar.gz \
    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-${OC_ARCH}.tar.gz"
  tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode
  rm -f /tmp/opencode.tar.gz
  chmod +x /usr/local/bin/opencode
}

ensure_package_mirrors() {
  mkdir -p /root/.config/pip

  if [ ! -f /root/.npmrc ]; then
    cat > /root/.npmrc <<EOF
registry=${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}
fund=false
audit=false
EOF
  fi

  if [ ! -f /root/.config/pip/pip.conf ]; then
    cat > /root/.config/pip/pip.conf <<EOF
[global]
index-url = ${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}
trusted-host = ${PIP_TRUSTED_HOST:-pypi.tuna.tsinghua.edu.cn}
timeout = 120
EOF
  fi
}

ensure_mise
ensure_opencode
ensure_package_mirrors

if [ "$#" -eq 0 ]; then
  set -- opencode serve --port 4096 --hostname 0.0.0.0
fi

exec "$@"
