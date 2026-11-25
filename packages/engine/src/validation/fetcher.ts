import { Context } from "effect";
import type { Effect } from "effect";
import type { EvidenceFetchError } from "./config.js";

export class EvidenceFetcher extends Context.Service<
  EvidenceFetcher,
  {
    readonly ocsp: (
      url: string,
      request: Uint8Array,
      timeoutMillis?: number,
    ) => Effect.Effect<Uint8Array, EvidenceFetchError>;
    readonly crl: (
      url: string,
      timeoutMillis?: number,
    ) => Effect.Effect<Uint8Array, EvidenceFetchError>;
    readonly timestamp: (
      url: string,
      request: Uint8Array,
      timeoutMillis?: number,
    ) => Effect.Effect<Uint8Array, EvidenceFetchError>;
  }
>()("@signature-kit/engine/EvidenceFetcher") {}
