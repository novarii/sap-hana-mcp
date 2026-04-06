#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROKER_DIR="${BROKER_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
TLS_DIR="${BROKER_DIR}/tls"
TLS_IP="${BROKER_TLS_IP:-204.168.161.38}"

mkdir -p "${TLS_DIR}"

if [[ ! -f "${TLS_DIR}/cert.pem" || ! -f "${TLS_DIR}/key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 \
    -keyout "${TLS_DIR}/key.pem" \
    -out "${TLS_DIR}/cert.pem" \
    -days 3650 \
    -nodes \
    -subj "/CN=${TLS_IP}" \
    -addext "subjectAltName=IP:${TLS_IP}"
fi

export BROKER_TRANSPORT="${BROKER_TRANSPORT:-http}"
export BROKER_TLS="${BROKER_TLS:-true}"
export BROKER_TLS_KEY="${BROKER_TLS_KEY:-${TLS_DIR}/key.pem}"
export BROKER_TLS_CERT="${BROKER_TLS_CERT:-${TLS_DIR}/cert.pem}"

cd "${BROKER_DIR}"
exec node dist/index.js
