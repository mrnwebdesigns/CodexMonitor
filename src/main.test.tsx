/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryInitMock = vi.fn();
const sentryMetricsCountMock = vi.fn();
const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({
  render: renderMock,
}));

vi.mock("@sentry/react", () => ({
  init: sentryInitMock,
  metrics: {
    count: sentryMetricsCountMock,
  },
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: createRootMock,
  },
  createRoot: createRootMock,
}));

vi.mock("./App", () => ({
  default: () => null,
}));

describe("main sentry bootstrap", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetModules();
    sentryInitMock.mockClear();
    sentryMetricsCountMock.mockClear();
    createRootMock.mockClear();
    renderMock.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("keeps telemetry disabled when the local DSN is empty", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    await import("./main");
    expect(sentryInitMock).toHaveBeenCalledWith(expect.objectContaining({ dsn: "", enabled: false }));
  });

  it("initializes sentry and records app_open", async () => {
    // Sentry is fully mocked; this deliberately non-URL value cannot send telemetry.
    vi.stubEnv("VITE_SENTRY_DSN", "mock-dsn");
    await import("./main");

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "mock-dsn",
        enabled: true,
        release: expect.any(String),
      }),
    );
    expect(sentryMetricsCountMock).toHaveBeenCalledTimes(1);
    expect(sentryMetricsCountMock).toHaveBeenCalledWith(
      "app_open",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          platform: "macos",
        }),
      }),
    );
  });
});
