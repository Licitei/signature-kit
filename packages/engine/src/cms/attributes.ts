import { Effect, Schema } from "effect";
import { encode, oidNode, primitiveNode, sequenceNode, setNode } from "../asn1/asn1.js";
import type { Asn1Error, Asn1Node } from "../asn1/asn1.js";
import { IcpBrasilPolicySchema, CmsOid, hashAlgorithmOid } from "./config.js";
import type { IcpBrasilPolicy } from "./config.js";

export type SignedAttribute = {
  readonly type: string;
  readonly value: Asn1Node;
  readonly node: Asn1Node;
};

const SPURI_OID = "1.2.840.113549.1.9.16.5.1";

const octetString = (bytes: Uint8Array) => primitiveNode(0x04, new Uint8Array(bytes));
const ascii = (tag: number, text: string) => primitiveNode(tag, new TextEncoder().encode(text));

const attribute = Effect.fnUntraced(function* (type: string, value: Asn1Node) {
  return { type, value, node: sequenceNode([yield* oidNode(type), setNode([value])]) };
});

const signaturePolicy = Effect.fnUntraced(function* (policy: IcpBrasilPolicy) {
  return sequenceNode([
    yield* oidNode(policy.policyOid),
    sequenceNode([
      sequenceNode([yield* oidNode(hashAlgorithmOid(policy.policyHashAlgorithm))]),
      octetString(policy.policyHash),
    ]),
    sequenceNode([sequenceNode([yield* oidNode(SPURI_OID), ascii(0x16, policy.policyUri)])]),
  ]);
});

const twoDigits = (value: number) => String(value).padStart(2, "0");

const signingTimeValue = (date: Date) => {
  const year = date.getUTCFullYear();
  const clock = [
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]
    .map(twoDigits)
    .join("");
  if (year >= 1950 && year < 2050) return ascii(0x17, `${twoDigits(year % 100)}${clock}Z`);
  const fraction = String(date.getUTCMilliseconds()).padStart(3, "0").replace(/0+$/, "");
  return ascii(0x18, `${year}${clock}${fraction === "" ? "" : `.${fraction}`}Z`);
};

export const compareDer = (a: Uint8Array, b: Uint8Array): number => {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
};

const BuildSignedAttributesParamsSchema = Schema.Struct({
  messageDigest: Schema.Uint8Array,
  certificateSha256: Schema.Uint8Array,
  icpBrasil: Schema.optional(IcpBrasilPolicySchema),
  signingTime: Schema.optional(Schema.Date),
});
type BuildSignedAttributesParams = (typeof BuildSignedAttributesParamsSchema)["Type"];

export const buildSignedAttributes = (
  params: BuildSignedAttributesParams,
): Effect.Effect<readonly SignedAttribute[], Asn1Error> =>
  Effect.gen(function* () {
    const attributes = [
      yield* attribute(CmsOid.contentType, yield* oidNode(CmsOid.data)),
      yield* attribute(CmsOid.messageDigest, octetString(params.messageDigest)),
      yield* attribute(
        CmsOid.signingCertificateV2,
        sequenceNode([sequenceNode([sequenceNode([octetString(params.certificateSha256)])])]),
      ),
    ];
    if (params.icpBrasil !== undefined) {
      attributes.push(
        yield* attribute(CmsOid.signaturePolicy, yield* signaturePolicy(params.icpBrasil)),
      );
    }
    if (params.signingTime !== undefined) {
      attributes.push(yield* attribute(CmsOid.signingTime, signingTimeValue(params.signingTime)));
    }
    return attributes
      .map((entry) => ({ entry, der: encode(entry.node) }))
      .sort((left, right) => compareDer(left.der, right.der))
      .map(({ entry }) => entry);
  });
