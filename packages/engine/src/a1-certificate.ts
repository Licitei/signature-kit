import { decode, oidString } from "./asn1/asn1.js";
import type { Asn1Node } from "./asn1/asn1.js";
import { parseX509 } from "./certificates/certificate.js";
import { Effect, Schema } from "effect";
import { LocalError } from "./rpc.js";
import type { A1Profile } from "./rpc.js";

export const A1Hash = Schema.Literals(["SHA-256", "SHA-384", "SHA-512"]);
export type A1Hash = (typeof A1Hash)["Type"];

export const sha256Hex = Effect.fn(function* (bytes: Uint8Array<ArrayBuffer>) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", bytes),
    catch: () => new LocalError({ code: "digestFailed" }),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

const isSequence = (
  node: Asn1Node | undefined,
): node is Extract<Asn1Node, { kind: "constructed" }> =>
  node?.kind === "constructed" && node.class === "universal" && node.tag === 16;

export const icpBrasilIdentity = Effect.fn(function* (der: Uint8Array) {
  const certificate = yield* decode(der);
  const tbs = isSequence(certificate) ? certificate.children[0] : undefined;
  const wrapper = isSequence(tbs)
    ? tbs.children.find((node) => node.class === "context" && node.tag === 3)
    : undefined;
  const extensions = wrapper?.kind === "constructed" ? wrapper.children[0] : undefined;
  let cpf: string | null = null;
  let cnpj: string | null = null;
  let person = false;
  let company = false;
  for (const extension of isSequence(extensions) ? extensions.children : []) {
    if (!isSequence(extension)) continue;
    const oid = extension.children[0];
    const value = extension.children.at(-1);
    if (oid?.kind !== "primitive" || oid.class !== "universal" || oid.tag !== 6) continue;
    if ((yield* oidString(oid)) !== "2.5.29.17") continue;
    if (value?.kind !== "primitive" || value.class !== "universal" || value.tag !== 4) continue;

    const names = yield* decode(value.bytes);
    if (!isSequence(names)) continue;
    for (const name of names.children) {
      if (name.kind !== "constructed" || name.class !== "context" || name.tag !== 0) continue;
      const [type, otherName] = name.children;
      if (type?.kind !== "primitive" || type.class !== "universal" || type.tag !== 6) continue;
      if (
        otherName?.kind !== "constructed" ||
        otherName.class !== "context" ||
        otherName.tag !== 0
      ) {
        continue;
      }

      const id = yield* oidString(type);
      const value = otherName.children[0];
      if (value?.kind !== "primitive" || value.class !== "universal") continue;
      const text = new TextDecoder().decode(value.bytes);
      if (id === "2.16.76.1.3.3") {
        company = true;
        cnpj = /^(\d{14})$/.exec(text)?.[1] ?? null;
      }
      if (id === "2.16.76.1.3.1") {
        person = true;
        cpf =
          /^(?:\d{8})?(\d{11})$/.exec(text)?.[1] ?? /^\d{8}(\d{11})\d+$/.exec(text)?.[1] ?? null;
      }
    }
  }
  return {
    holderKind: company ? "e-cnpj" : person ? "e-cpf" : "other",
    brazilian: { cpf, cnpj },
  } satisfies {
    holderKind: A1Profile["holderKind"];
    brazilian: { cpf: string | null; cnpj: string | null };
  };
});

export const a1Profile = Effect.fn(function* (der: Uint8Array) {
  const [certificate, identity, fingerprintSha256] = yield* Effect.all([
    parseX509(der).pipe(Effect.mapError(() => new LocalError({ code: "invalidPkcs12" }))),
    icpBrasilIdentity(der).pipe(Effect.mapError(() => new LocalError({ code: "invalidPkcs12" }))),
    sha256Hex(new Uint8Array(der)),
  ]);
  return {
    holderKind: identity.holderKind,
    subjectName: certificate.subject.commonName ?? certificate.subject.raw,
    notBefore: certificate.validity.notBefore,
    notAfter: certificate.validity.notAfter,
    issuerName: certificate.issuer.commonName ?? certificate.issuer.raw,
    fingerprintSha256,
  } satisfies A1Profile;
});

export const importA1SigningKey = (pkcs8: Uint8Array, hash: A1Hash) =>
  Effect.suspend(() => {
    const owned = new Uint8Array(pkcs8);
    return Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("pkcs8", owned, { name: "RSASSA-PKCS1-v1_5", hash }, false, [
          "sign",
        ]),
      catch: () => new LocalError({ code: "keyImportFailed" }),
    }).pipe(Effect.uninterruptible, Effect.ensuring(Effect.sync(() => owned.fill(0))));
  });
