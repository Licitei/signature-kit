#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "${1:-$source_dir}"
fixtures=$(cd -- "${1:-$source_dir}" && pwd)
validity=(-not_before 20250101000000Z -not_after 20400101000000Z)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 "${validity[@]}" \
  -subj '/CN=SignatureKit Test Root' -set_serial 1 \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout root.key -out root.pem
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=SignatureKit Test Intermediate' \
  -keyout intermediate.key -out intermediate.csr
cat > intermediate.ext <<'EXT'
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EXT
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -set_serial 2 \
  "${validity[@]}" -sha256 -extfile intermediate.ext -out intermediate.pem
openssl x509 -in root.pem -outform DER -out "$fixtures/root.der"
openssl x509 -in intermediate.pem -outform DER -out "$fixtures/intermediate.der"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 "${validity[@]}" \
  -subj '/CN=Unrelated SignatureKit Test Root' -set_serial 10 \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout unrelated.key -outform DER -out "$fixtures/unrelated-root.der"

leaf() {
  local name=$1 serial=$2 common_name=$3 other_name=$4
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$common_name" \
    -keyout "$name.key" -out "$name.csr"
  cat > "$name.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,nonRepudiation
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
subjectAltName=otherName:$other_name
EXT
  openssl x509 -req -in "$name.csr" -CA intermediate.pem -CAkey intermediate.key \
    -set_serial "$serial" "${validity[@]}" -sha256 -extfile "$name.ext" -out "$name.pem"
  openssl pkcs12 -export -inkey "$name.key" -in "$name.pem" -certfile intermediate.pem \
    -passout pass:changeit -out "$fixtures/$name.p12"
}

leaf ecpf 3 'SignatureKit Test Person' '2.16.76.1.3.1;UTF8:0101199000000000001'
leaf ecnpj 4 'SignatureKit Test Company' '2.16.76.1.3.3;UTF8:00000000000002'

bun "$source_dir/../../generate-cosign-fixtures.ts" "$fixtures"
cp "$fixtures/cosigned.pdf" "$fixtures/external.pdf"
uv run --no-project --with pymupdf==1.26.7 python - "$fixtures/external.pdf" <<'PY'
import sys
import pymupdf

with pymupdf.open(sys.argv[1]) as pdf:
    pdf.set_metadata({**pdf.metadata, "producer": "PyMuPDF incremental save"})
    pdf.saveIncr()
PY
