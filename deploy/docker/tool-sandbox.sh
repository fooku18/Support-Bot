#!/bin/bash
set -eu
# Credentialed CLI sandbox. Each CLI has private PID/mount/IPC/UTS
# namespaces and only its own credential. Egress: the container sits on
# internal networks only; the CLI reaches its provider through the
# instance's egress proxy (HTTPS_PROXY/HTTP_PROXY/NO_PROXY from the runtime,
# forwarded below), which admits the GITLAB_HOSTS for the tools network.
#
# Secret transport: the runtime writes the SELECTED provider's environment
# (credential included) to a root-owned mode-0600 file at "$staging/env"
# before invoking this launcher. The file is bound read-only into the mount
# namespace at /run/support-agent-env and sourced by tool-sandbox-inner.sh while
# still root, before setpriv drops to the CLI uid. Secret values NEVER
# appear in this launcher's argv (no `bwrap --setenv KEY value` for
# credential data), and the unprivileged uid inside the namespace cannot
# read the env file back (root-owned 0400).
staging=$1
file_blocks=$2
shift 2
cli_uid=${CLI_SANDBOX_UID:-1000}
cwd=/workspace
case "${1-}" in
  --cwd=*) cwd="${1#--cwd=}"; shift ;;
esac
# Credential/environment whitelist: only non-secret behavior flags pass via
# argv; provider credentials arrive exclusively through the env file.
# SSL_CERT_FILE/SSL_CERT_DIR forward the operator's corporate trust
# configuration (TLS verification is never disabled); the proxy variables
# are non-secret (the proxy URL and the direct service names).
environment=( \
  --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv HOME /home/node --setenv TMPDIR /tmp --setenv CI 1 --setenv LANG C.UTF-8 \
  --setenv TERM dumb --setenv NO_COLOR 1 --setenv EDITOR true --setenv PAGER cat \
  --setenv GIT_PAGER cat --setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_NOGLOBAL 1 \
  --setenv GIT_TERMINAL_PROMPT 0 --setenv GIT_OPTIONAL_LOCKS 0 \
  --setenv XDG_CONFIG_HOME /home/node/.config \
  --setenv XDG_DATA_HOME /home/node/.local/share \
  --setenv CLI_SANDBOX_ENV_FILE /run/support-agent-env \
  ${SSL_CERT_FILE:+--setenv SSL_CERT_FILE "$SSL_CERT_FILE"} \
  ${SSL_CERT_DIR:+--setenv SSL_CERT_DIR "$SSL_CERT_DIR"} \
  ${HTTPS_PROXY:+--setenv HTTPS_PROXY "$HTTPS_PROXY" --setenv https_proxy "$HTTPS_PROXY"} \
  ${HTTP_PROXY:+--setenv HTTP_PROXY "$HTTP_PROXY" --setenv http_proxy "$HTTP_PROXY"} \
  ${NO_PROXY:+--setenv NO_PROXY "$NO_PROXY" --setenv no_proxy "$NO_PROXY"} \
)
exec bwrap --die-with-parent --unshare-pid --unshare-ipc --unshare-uts --new-session --cap-add ALL \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc /etc --proc /proc --dev /dev --remount-ro /dev \
  --bind "$staging/checkout" /workspace --dir /task --bind "$staging/reports" /task/reports --bind "$staging/tmp" /tmp \
  --dir /home --bind "$staging/home" /home/node \
  --ro-bind "$staging/env" /run/support-agent-env \
  --chdir "$cwd" \
  "${environment[@]}" \
  /bin/bash /usr/local/bin/tool-sandbox-inner "$cli_uid" "$file_blocks" "$@"
