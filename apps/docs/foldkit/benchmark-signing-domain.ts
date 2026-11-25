import * as Domain from "@alchemy.run/domain";
import { SigningModel } from "@signature-kit/signing-domain";
import { Layer } from "effect";

export const foldkitBenchmarkSigningLayer = SigningModel.layer(Layer.empty).pipe(
  Layer.provide(Domain.InMemory),
);
