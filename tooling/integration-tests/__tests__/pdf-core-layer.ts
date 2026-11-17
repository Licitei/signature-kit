import * as NodeServices from "@effect/platform-node/NodeServices";
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file";
import { Layer } from "effect";

export const pdfCoreTestLayer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
