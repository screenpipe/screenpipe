// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Mutable harness state + spies. The gate reads everything through useSettings
// and the tauri `commands` object, so we drive entitlement scenarios by swapping
// `mocks.state.user` and assert on the engine start/stop calls it makes.
const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  open: vi.fn().mockResolvedValue(undefined),
  stopScreenpipe: vi.fn().mockResolvedValue(undefined),
  spawnScreenpipe: vi.fn().mockResolvedValue(undefined),
  openLoginWindow: vi.fn().mockResolvedValue(undefined),
  setCloudToken: vi.fn().mockResolvedValue(undefined),
  getCloudToken: vi.fn().mockResolvedValue(null),
  piUpdateConfig: vi.fn().mockResolvedValue(undefined),
  platform: vi.fn(() => "windows"),
  arch: vi.fn(() => "x86_64"),
  windowLabel: "home",
  loadUser: vi.fn().mockResolvedValue(undefined),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  state: { isSettingsLoaded: true, user: null as any },
  enterpriseResolutionError: false,
  enterprise: {
    isManagedDeployment: false,
    isManagedDeploymentResolved: true,
    authenticationState: "authenticated",
    authenticationError: null as string | null,
    isManagedAuthenticated: true,
  },
  selectAuthenticationMethod: vi.fn(),
  submitLicenseKey: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: { user: mocks.state.user },
    isSettingsLoaded: mocks.state.isSettingsLoaded,
    loadUser: mocks.loadUser,
    updateSettings: mocks.updateSettings,
  }),
}));

vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    stopScreenpipe: mocks.stopScreenpipe,
    spawnScreenpipe: mocks.spawnScreenpipe,
    openLoginWindow: mocks.openLoginWindow,
    setCloudToken: mocks.setCloudToken,
    getCloudToken: mocks.getCloudToken,
    piUpdateConfig: mocks.piUpdateConfig,
  },
}));

vi.mock("@/lib/hooks/use-managed-policy", () => ({
  useManagedPolicy: () => ({
    isManagedDeployment: mocks.enterprise.isManagedDeployment,
    isManagedDeploymentResolved: mocks.enterprise.isManagedDeploymentResolved,
    managedDeploymentResolutionError: mocks.enterpriseResolutionError,
    authenticationState: mocks.enterprise.authenticationState,
    authenticationError: mocks.enterprise.authenticationError,
    isManagedAuthenticated: mocks.enterprise.isManagedAuthenticated,
    selectAuthenticationMethod: mocks.selectAuthenticationMethod,
    submitLicenseKey: mocks.submitLicenseKey,
  }),
}));

vi.mock("posthog-js", () => ({ default: { capture: mocks.capture } }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: mocks.platform,
  arch: mocks.arch,
}));

// The resume effect only restarts the engine from the primary window, which it
// detects via getCurrentWindow().label. Stand in as the primary "home" window so
// the sequenced stop -> settle -> spawn actually runs under test.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel }),
}));

import { AppEntitlementGate } from "./app-entitlement-gate";

// Build timestamps relative to the real clock so freshness checks are stable
// without fake timers.
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) =>
  new Date(Date.now() - d * 86_400_000).toISOString();
const daysAhead = (d: number) =>
  new Date(Date.now() + d * 86_400_000).toISOString();

function baseUser(overrides: Record<string, any> = {}) {
  return {
    id: "free-user",
    token: "tok",
    email: "owner@example.invalid",
    cloud_subscribed: false,
    app_entitled: false,
    subscription_plan: "none",
    entitlement: {
      active: false,
      plan: "none",
      source: "none",
      checked_at: minsAgo(1),
      features: { app: false, cloud: false },
    },
    ...overrides,
  };
}

const protectedApp = <div data-testid="protected-app">app</div>;

describe("Restricted enterprise onboarding outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    // Production-like env so the dev billing bypass stays off and the gate runs.
    vi.stubEnv("TAURI_ENV_DEBUG", "false");
    vi.stubEnv("NEXT_PUBLIC_SCREENPIPE_DEV_BILLING_BYPASS", "false");
    vi.stubEnv("NEXT_PUBLIC_SCREENPIPE_DEV_LOGIN_SKIP", "false");
    mocks.state = { isSettingsLoaded: true, user: null };
    mocks.enterpriseResolutionError = false;
    mocks.windowLabel = "home";
    mocks.enterprise = {
      isManagedDeployment: false,
      isManagedDeploymentResolved: true,
      authenticationState: "authenticated",
      authenticationError: null,
      isManagedAuthenticated: true,
    };
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    vi.unstubAllEnvs();
  });

  it("starts the application without an account when authentication is not required", () => {
    render(
      <AppEntitlementGate authenticationStatus="not_required">
        {protectedApp}
      </AppEntitlementGate>,
    );

    expect(screen.getByTestId("protected-app")).toBeInTheDocument();
    expect(mocks.stopScreenpipe).not.toHaveBeenCalled();
  });

  it("leaves enterprise authentication on the onboarding login step", () => {
    window.history.replaceState({}, "", "/onboarding");
    mocks.enterprise = {
      isManagedDeployment: true,
      isManagedDeploymentResolved: true,
      authenticationState: "choice",
      authenticationError: null,
      isManagedAuthenticated: false,
    };

    render(<AppEntitlementGate>{protectedApp}</AppEntitlementGate>);

    expect(screen.getByTestId("protected-app")).toBeInTheDocument();
    expect(screen.queryByText(/enterprise access/i)).not.toBeInTheDocument();
  });

  it("keeps an ordinary signed-in consumer in onboarding", () => {
    window.history.replaceState({}, "", "/onboarding");
    mocks.state.user = baseUser();

    render(
      <AppEntitlementGate authenticationStatus="logged_out">
        {protectedApp}
      </AppEntitlementGate>,
    );

    expect(screen.getByTestId("protected-app")).toBeInTheDocument();
    expect(
      screen.queryByText(/enterprise app required/i),
    ).not.toBeInTheDocument();
  });

  it("gates a restricted enterprise member as soon as onboarding sign-in resolves", () => {
    window.history.replaceState({}, "", "/onboarding");
    mocks.windowLabel = "onboarding";

    const { rerender } = render(
      <AppEntitlementGate authenticationStatus="logged_out">
        {protectedApp}
      </AppEntitlementGate>,
    );

    expect(screen.getByTestId("protected-app")).toBeInTheDocument();

    mocks.state.user = baseUser({
      app_entitled: true,
      cloud_subscribed: true,
      subscription_plan: "pro",
      enterprise_account: {
        org_name: "Example Org",
        role: "member",
        requires_enterprise_app: true,
        restrict_consumer_build_access: true,
      },
      entitlement: {
        active: true,
        plan: "pro",
        source: "subscription",
        checked_at: minsAgo(1),
        features: { app: true, cloud: true },
      },
    });
    rerender(
      <AppEntitlementGate authenticationStatus="logged_out">
        {protectedApp}
      </AppEntitlementGate>,
    );

    expect(screen.getByText(/enterprise app required/i)).toBeInTheDocument();
    expect(screen.queryByTestId("protected-app")).not.toBeInTheDocument();
  });

  it("does not misclassify a cached restricted user before build detection resolves", () => {
    window.history.replaceState({}, "", "/onboarding");
    mocks.state.user = baseUser({
      enterprise_account: {
        org_name: "Example Org",
        role: "member",
        requires_enterprise_app: true,
        restrict_consumer_build_access: true,
      },
    });
    mocks.enterprise.isManagedDeploymentResolved = false;

    const { rerender } = render(
      <AppEntitlementGate authenticationStatus="logged_out">
        {protectedApp}
      </AppEntitlementGate>,
    );

    expect(screen.getByTestId("protected-app")).toBeInTheDocument();
    expect(
      screen.queryByText(/enterprise app required/i),
    ).not.toBeInTheDocument();

    mocks.enterprise = {
      isManagedDeployment: true,
      isManagedDeploymentResolved: true,
      authenticationState: "choice",
      authenticationError: null,
      isManagedAuthenticated: false,
    };
    rerender(
      <AppEntitlementGate authenticationStatus="logged_out">
        {protectedApp}
      </AppEntitlementGate>,
    );

    expect(screen.getByTestId("protected-app")).toBeInTheDocument();
    expect(
      screen.queryByText(/enterprise app required/i),
    ).not.toBeInTheDocument();
  });

  function restrictedUser(overrides: Record<string, any> = {}) {
    return baseUser({
      app_entitled: true, cloud_subscribed: true, subscription_plan: "pro",
      enterprise_account: { org_name: "Example Org", role: "member", requires_enterprise_app: true, restrict_consumer_build_access: true },
      entitlement: { active: true, plan: "pro", source: "subscription", checked_at: minsAgo(1), features: {app:true,cloud:true} },
      ...overrides,
    });
  }
  it("gates a cached restricted identity after detection confirms consumer build", () => {
    window.history.replaceState({}, "", "/onboarding");mocks.windowLabel="onboarding";
    mocks.state.user=restrictedUser();mocks.enterprise.isManagedDeploymentResolved=false;
    const {rerender}=render(<AppEntitlementGate authenticationStatus="logged_out">{protectedApp}</AppEntitlementGate>);
    expect(screen.getByTestId("protected-app")).toBeInTheDocument();expect(mocks.stopScreenpipe).not.toHaveBeenCalled();
    mocks.enterprise.isManagedDeploymentResolved=true;
    rerender(<AppEntitlementGate authenticationStatus="logged_out">{protectedApp}</AppEntitlementGate>);
    expect(screen.getByRole("heading",{name:/enterprise app required/i})).toBeInTheDocument();expect(screen.queryByTestId("protected-app")).not.toBeInTheDocument();
  });
  it("preserves paid consumer access when enterprise policy does not restrict it", () => {
    window.history.replaceState({}, "", "/onboarding");
    mocks.state.user=restrictedUser({enterprise_account:{org_name:"Example Org",role:"member",requires_enterprise_app:true,restrict_consumer_build_access:false}});
    render(<AppEntitlementGate authenticationStatus="logged_out">{protectedApp}</AppEntitlementGate>);
    expect(screen.getByTestId("protected-app")).toBeInTheDocument();expect(mocks.stopScreenpipe).not.toHaveBeenCalled();
  });
  it("preserves tokenless onboarding rather than gating a cached organization", () => {
    window.history.replaceState({}, "", "/onboarding");mocks.state.user=restrictedUser({token:null});
    render(<AppEntitlementGate authenticationStatus="logged_out">{protectedApp}</AppEntitlementGate>);
    expect(screen.getByTestId("protected-app")).toBeInTheDocument();expect(mocks.stopScreenpipe).not.toHaveBeenCalled();
  });
  it("does not infer a required enterprise build from restriction flag alone", () => {
    window.history.replaceState({}, "", "/onboarding");mocks.state.user=restrictedUser({enterprise_account:{org_name:"Example Org",role:"member",requires_enterprise_app:false,restrict_consumer_build_access:true}});
    render(<AppEntitlementGate authenticationStatus="logged_out">{protectedApp}</AppEntitlementGate>);
    expect(screen.getByTestId("protected-app")).toBeInTheDocument();expect(mocks.stopScreenpipe).not.toHaveBeenCalled();
  });
  it("keeps explicit no-auth startup semantics for a cached restricted user", () => {
    window.history.replaceState({}, "", "/onboarding");mocks.state.user=restrictedUser();
    render(<AppEntitlementGate authenticationStatus="not_required">{protectedApp}</AppEntitlementGate>);
    expect(screen.getByTestId("protected-app")).toBeInTheDocument();expect(mocks.stopScreenpipe).not.toHaveBeenCalled();
  });

});
