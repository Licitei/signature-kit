---
packages:
  "@signature-kit/engine":
    replay:
      - exit-prerelease(npm:@signature-kit/engine)
  "@signature-kit/browser":
    replay:
      - exit-prerelease(npm:@signature-kit/browser)
---

## Engine and browser packages

The engine provides the RPC contract, local services and WebAssembly bindings.
The browser package provides the worker, client and viewer.
