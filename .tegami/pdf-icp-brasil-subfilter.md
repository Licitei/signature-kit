---
packages:
  "@signature-kit/pdf-core": patch
  "@signature-kit/pdf": patch
  "@signature-kit/iti": patch
---

## Declare the ETSI SubFilter for ICP-Brasil PAdES

Signing with `policy: "pades-icp-brasil"` writes `/SubFilter /ETSI.CAdES.detached`. Generic CMS signing still writes `/adbe.pkcs7.detached`. The local AD-RB conformance check reports a missing or different SubFilter as invalid, including in documents signed with the previous SubFilter.
