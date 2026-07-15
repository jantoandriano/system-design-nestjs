#!/usr/bin/env bash
# Generates a self-signed TLS cert for local development, so nginx can
# terminate HTTPS out of the box. Browsers/curl will flag it as
# untrusted - that's expected for a self-signed cert.
#
# Before real traffic hits this: swap for a cert-manager-issued
# (Let's Encrypt) or ACM/managed-load-balancer certificate instead.
set -euo pipefail

cd "$(dirname "$0")"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout privkey.pem \
  -out fullchain.pem \
  -subj "/CN=localhost"

echo "Generated nginx/certs/fullchain.pem and nginx/certs/privkey.pem"
