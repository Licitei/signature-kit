---
packages:
  "@signature-kit/pdf-core": minor
  "@signature-kit/pdf": minor
  "@signature-kit/iti": minor
---

## Declare the ETSI SubFilter for ICP-Brasil PAdES

Signing with `policy: "pades-icp-brasil"` now writes `/SubFilter /ETSI.CAdES.detached`. Local AD-RB validation accepts `ETSI.CAdES.detached` and `PBAD.PAdES` and rejects older signatures with `adbe.pkcs7.detached`. Generic CMS signing still writes `adbe.pkcs7.detached`.

Signature dictionary reports and extracted PDF signatures now expose the optional `subFilter` name in place of `usesEtsiCadesDetached`.
