import type { Properties } from "posthog-js";

export const captureDocsEvent = (event: string, properties?: Properties) => {
  void import("../lib/posthog/client").then((client) => client.captureDocsEvent(event, properties));
};

export const initDocsAnalytics = () => {
  void import("../lib/posthog/client").then((client) => client.initDocsPostHog());
};
