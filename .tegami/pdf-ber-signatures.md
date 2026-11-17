---
packages:
  "@signature-kit/pdf": patch
---

## Verify signatures encoded with indefinite-length BER

Signature `/Contents` encoded as indefinite-length BER (`30 80 …`), as produced by common ICP-Brasil signing tools, no longer fail with `cms.DECODE_ERROR`. The signature length is now measured by walking the BER structure up to its end-of-contents octets instead of trimming trailing zero bytes, which used to strip those octets. Non-zero bytes after the signature still fail closed.
