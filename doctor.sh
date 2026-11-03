#!/usr/bin/env bash
# Sentinel-SLA — diagnostic bundle for remote help.
# Usage: ./doctor.sh   → doctor/sentinel-doctor-<ts>.txt (redacted by construction)
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy/doctor.sh" "$@"
