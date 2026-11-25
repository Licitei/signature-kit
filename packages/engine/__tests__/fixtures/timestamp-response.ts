import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

const TSA_TST_INFO_CONTENT_TYPE = "1.2.840.113549.1.9.16.1.4";
const cmsOid = {
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
};
export type TimestampSigner = {
  readonly certificate: pkijs.Certificate;
  readonly certificateDer: Uint8Array;
  readonly privateKey: CryptoKey;
};

type TimestampResponseOptions = {
  readonly includeSignedAttributes?: boolean;
  readonly signingCertificateDers?: readonly Uint8Array[];
  readonly tamperSignature?: boolean;
  readonly genTime?: Date;
};

const timestampSignedAttributes = async (
  tstInfoDer: ArrayBuffer,
  certificateDers: readonly Uint8Array[],
): Promise<pkijs.SignedAndUnsignedAttributes> => {
  const [messageDigest, certificateHashes] = await Promise.all([
    crypto.subtle.digest("SHA-256", tstInfoDer),
    Promise.all(
      certificateDers.map((certificateDer) =>
        crypto.subtle.digest("SHA-256", new Uint8Array(certificateDer).buffer),
      ),
    ),
  ]);
  const signingCertificate = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: certificateHashes.map(
          (valueHex) => new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex })] }),
        ),
      }),
    ],
  });
  return new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({
        type: cmsOid.contentType,
        values: [new asn1js.ObjectIdentifier({ value: TSA_TST_INFO_CONTENT_TYPE })],
      }),
      new pkijs.Attribute({
        type: cmsOid.messageDigest,
        values: [new asn1js.OctetString({ valueHex: messageDigest })],
      }),
      new pkijs.Attribute({
        type: cmsOid.signingCertificateV2,
        values: [signingCertificate],
      }),
    ],
  });
};

export const timestampResponse = async (
  requestDer: Uint8Array,
  signer: TimestampSigner | undefined,
  options: TimestampResponseOptions = {},
): Promise<Uint8Array> => {
  const requestSchema = asn1js.fromBER(new Uint8Array(requestDer).buffer);
  const request = new pkijs.TimeStampReq({ schema: requestSchema.result });
  const serialNumber = pkijs.TSTInfo.defaultValues("serialNumber");
  serialNumber.valueBlock.valueDec = 1;
  const tstInfoBase = {
    version: 1,
    policy: "1.2.3.4",
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: request.messageImprint.hashAlgorithm,
      hashedMessage: request.messageImprint.hashedMessage,
    }),
    serialNumber,
    genTime: options.genTime ?? new Date(),
  };
  const tstInfo = new pkijs.TSTInfo(
    request.nonce === undefined ? tstInfoBase : { ...tstInfoBase, nonce: request.nonce },
  );
  const tstInfoDer = tstInfo.toSchema().toBER(false);
  const signedAttributes =
    signer === undefined || options.includeSignedAttributes === false
      ? undefined
      : await timestampSignedAttributes(
          tstInfoDer,
          options.signingCertificateDers ?? [signer.certificateDer],
        );
  const eContent = pkijs.EncapsulatedContentInfo.defaultValues("eContent");
  eContent.valueBlock.valueHexView = new Uint8Array(tstInfoDer);
  const signed = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: TSA_TST_INFO_CONTENT_TYPE,
      eContent,
    }),
    signerInfos:
      signer === undefined
        ? []
        : [
            new pkijs.SignerInfo({
              version: 1,
              sid: new pkijs.IssuerAndSerialNumber({
                issuer: signer.certificate.issuer,
                serialNumber: signer.certificate.serialNumber,
              }),
              ...(signedAttributes === undefined ? {} : { signedAttrs: signedAttributes }),
            }),
          ],
    ...(signer === undefined ? {} : { certificates: [signer.certificate] }),
  });
  if (signer !== undefined) {
    await signed.sign(signer.privateKey, 0, "SHA-256");
    const signature = signed.signerInfos[0]?.signature.valueBlock.valueHexView;
    if (options.tamperSignature === true && signature !== undefined && signature.byteLength > 0) {
      signature[0] = (signature[0] ?? 0) ^ 0x01;
    }
  }
  const token = new pkijs.ContentInfo({
    contentType: pkijs.ContentInfo.SIGNED_DATA,
    content: signed.toSchema(true),
  });
  return new Uint8Array(
    new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: pkijs.PKIStatus.granted }),
      timeStampToken: token,
    })
      .toSchema()
      .toBER(false),
  );
};
