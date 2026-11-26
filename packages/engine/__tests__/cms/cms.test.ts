import { describe, expect, it } from "@effect/vitest";
import { encode } from "../../src/asn1/asn1";
import { buildSignedAttributes } from "../../src/cms/attributes";
import {
  CmsHashAlgorithmValue,
  CmsOid,
  CmsVerifyResultSchema,
  hashAlgorithmOid,
  webCryptoHashName,
} from "../../src/cms/config";
import { Effect, Schema } from "effect";
const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0) return true;
  const lastStart = haystack.length - needle.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) matched = false;
    }
    if (matched) return true;
  }
  return false;
};

describe("CMS contracts", () => {
  it("maps digest catalogs to WebCrypto and ASN.1 OIDs", () => {
    expect(CmsHashAlgorithmValue.sha1).toBe("sha1");
    expect(webCryptoHashName("sha1")).toBe("SHA-1");
    expect(webCryptoHashName("sha256")).toBe("SHA-256");
    expect(webCryptoHashName("sha384")).toBe("SHA-384");
    expect(webCryptoHashName("sha512")).toBe("SHA-512");
    expect(hashAlgorithmOid("sha1")).toBe("1.3.14.3.2.26");
    expect(hashAlgorithmOid("sha256")).toBe("2.16.840.1.101.3.4.2.1");
    expect(CmsOid.timeStampToken).toBe("1.2.840.113549.1.9.16.2.14");
  });

  it.effect("builds PAdES signed attributes without signingTime", () =>
    Effect.gen(function* () {
      const messageDigest = new Uint8Array(32).fill(0x11);
      const certificateSha256 = new Uint8Array(32).fill(0x22);
      const attributes = yield* buildSignedAttributes({
        messageDigest,
        certificateSha256,
      });

      expect(attributes.map((attribute) => attribute.type)).toEqual([
        CmsOid.contentType,
        CmsOid.messageDigest,
        CmsOid.signingCertificateV2,
      ]);
      expect(attributes.map((attribute) => attribute.type)).not.toContain(CmsOid.signingTime);
      const signingCertificate = attributes.find(
        (attribute) => attribute.type === CmsOid.signingCertificateV2,
      );
      expect(signingCertificate).toBeDefined();
      const encoded =
        signingCertificate === undefined ? new Uint8Array() : encode(signingCertificate.value);
      expect(encoded.byteLength).toBeGreaterThan(0);
      expect(containsBytes(encoded, certificateSha256)).toBe(true);
      expect(encoded).toEqual(
        Uint8Array.of(0x30, 38, 0x30, 36, 0x30, 34, 0x04, 32, ...certificateSha256),
      );
    }),
  );

  it.effect("adds ICP-Brasil signature policy attribute when policy metadata is present", () =>
    Effect.gen(function* () {
      const policyHash = new Uint8Array(32).fill(0x33);
      const attributes = yield* buildSignedAttributes({
        messageDigest: new Uint8Array(32).fill(0x11),
        certificateSha256: new Uint8Array(32).fill(0x22),
        icpBrasil: {
          policyOid: "2.16.76.1.7.1.11.1.1",
          policyHash,
          policyHashAlgorithm: "sha256",
          policyUri: "http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_1.der",
        },
      });

      const policy = attributes.find((attribute) => attribute.type === CmsOid.signaturePolicy);
      expect(policy).toBeDefined();
      const encoded = policy === undefined ? new Uint8Array() : encode(policy.value);
      expect(containsBytes(encoded, policyHash)).toBe(true);
    }),
  );

  it.effect("makes revocation verification state explicit in CMS verify results", () =>
    Schema.decodeUnknownEffect(CmsVerifyResultSchema)({
      valid: true,
      chainValid: false,
      revocationStatus: "not_checked",
      signerSerialNumber: null,
    }).pipe(
      Effect.map((result) => {
        expect(result.chainValid).toBe(false);
        expect(result.revocationStatus).toBe("not_checked");
      }),
    ),
  );
});
