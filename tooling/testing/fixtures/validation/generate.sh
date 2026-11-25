#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "${1:-$source_dir}"
fixtures=$(cd -- "${1:-$source_dir}" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -subj '/CN=Validation Test CA' -set_serial 1 \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign,digitalSignature' \
  -keyout ca.key -out ca.pem
openssl x509 -in ca.pem -outform DER -out "$fixtures/ca.der"

mkdir newcerts
touch index.txt
printf '1000\n' > serial
printf '1000\n' > crlnumber
cat > ca.cnf <<'CONF'
[ca]
default_ca=local
[local]
database=index.txt
new_certs_dir=newcerts
certificate=ca.pem
private_key=ca.key
serial=serial
crlnumber=crlnumber
default_md=sha256
default_days=3650
default_crl_days=30
policy=policy
x509_extensions=leaf
[policy]
commonName=supplied
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
[tsa]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,timeStamping
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
CONF

leaf() {
  local name=$1 extension=$2
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=Validation Test $name" \
    -keyout "$name.key" -out "$name.csr"
  openssl ca -config ca.cnf -batch -notext -extensions "$extension" -in "$name.csr" -out "$name.pem"
}

leaf signer leaf
leaf wrong leaf
leaf timestamp tsa
openssl x509 -in signer.pem -outform DER -out "$fixtures/signer.der"
openssl pkcs12 -export -inkey signer.key -in signer.pem -certfile ca.pem \
  -passout pass:changeit -out "$fixtures/signer.p12"

ocsp() {
  local name=$1 signer=$2 days=$3
  openssl ocsp -index index.txt -issuer ca.pem -cert signer.pem \
    -CA ca.pem -rsigner "$signer.pem" -rkey "$signer.key" -ndays "$days" \
    -no_nonce -respout "$fixtures/$name.der"
}
ocsp good ca 30
ocsp expired ca 1
ocsp wrong-responder wrong 30
openssl ca -config ca.cnf -batch -revoke signer.pem -crl_reason keyCompromise
ocsp revoked ca 30
openssl ca -config ca.cnf -gencrl -out revoked.pem
openssl crl -in revoked.pem -outform DER -out "$fixtures/revoked-crl.der"
for response in good expired revoked; do
  openssl ocsp -respin "$fixtures/$response.der" -verify_other ca.pem -CAfile ca.pem \
    -issuer ca.pem -cert signer.pem -no_nonce
done
openssl crl -inform DER -in "$fixtures/revoked-crl.der" -verify -CAfile ca.pem -noout
openssl x509 -in timestamp.pem -outform DER -out "$fixtures/tsa.der"
cp "$fixtures/ca.der" "$fixtures/tsa-root.der"
openssl pkcs12 -export -inkey timestamp.key -in timestamp.pem -certfile ca.pem \
  -passout pass:changeit -out "$fixtures/tsa.p12"

cat > tsa.cnf <<'CONF'
[tsa]
default_tsa=local
[local]
serial=tsa.serial
signer_cert=timestamp.pem
certs=ca.pem
signer_key=timestamp.key
signer_digest=sha256
default_policy=1.3.6.1.4.1.12345.1
digests=sha256,sha384,sha512
ess_cert_id_alg=sha256
CONF
printf '01\n' > tsa.serial
printf 'SignatureKit timestamp fixture\n' > message
openssl ts -query -data message -sha256 -cert -out query.der
openssl ts -reply -config tsa.cnf -queryfile query.der -out timestamp-response.der
openssl ts -reply -in timestamp-response.der -token_out -out "$fixtures/timestamp-token.der"
openssl ts -verify -token_in -in "$fixtures/timestamp-token.der" -data message -CAfile ca.pem
