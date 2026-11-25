# Co-signing fixtures

These files model a two-party contract and an ICP-Brasil-like test chain. The RSA
test keys in the two PKCS#12 files use the public password `changeit`. The
identities and identifiers are synthetic. Use the DER root only in tests.

Run `bun run build` first, then `bash tooling/testing/fixtures/cosign/generate.sh`,
both through the host resource wrapper. Generation requires OpenSSL with `-not_before` and `-not_after` support and uv. The
generator signs at a fixed test time inside the fixture certificates' validity
interval. Regeneration creates new test keys and PDF signatures. PyMuPDF performs
the external incremental save and changes the producer metadata.

- `contract.pdf` is the draft. `sent.pdf` is the same document with two empty
  signature widgets added in one revision.
- `cosigned.pdf` has both signatures, and `report.json` is its comparison report.
- `different.pdf` starts from a different draft and carries a valid signature.
- `page-changed.pdf` adds a content stream after both signatures.
- `unknown.pdf` adds an object outside the known change categories.
- `external.pdf` retains both valid signatures after PyMuPDF saves incrementally.
- `integrity-failure.pdf` has a modified byte in the second signature's padding.
