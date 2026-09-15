// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createFixtureWorkflowsPlatform } from "@screenpipe/workflows-ui/fixture";
import { useContextProfile } from "../../../../packages/workflows-ui/src/use-context-profile";

it("never writes on load or replaces newer typing with a slow save response", async () => {
  const platform = createFixtureWorkflowsPlatform();
  const finish: Array<() => void> = [];
  platform.saveWorkProfile = vi.fn((profile) => new Promise((resolve) => finish.push(() => resolve({ ...profile, summary: "Old server response" }))));
  const { result } = renderHook(() => useContextProfile(platform, undefined, false, true));
  await waitFor(() => expect(result.current.profile).not.toBeNull());
  expect(platform.saveWorkProfile).not.toHaveBeenCalled();
  act(() => result.current.update({ ...result.current.profile!, summary: "First edit" }));
  await waitFor(() => expect(platform.saveWorkProfile).toHaveBeenCalledTimes(1));
  act(() => result.current.update({ ...result.current.profile!, summary: "Latest edit" }));
  await act(async () => finish[0]());
  expect(result.current.profile?.summary).toBe("Latest edit");
  expect(result.current.status).toBe("saving");
  await waitFor(() => expect(platform.saveWorkProfile).toHaveBeenCalledTimes(2));
  await act(async () => finish[1]());
  expect(result.current.profile?.summary).toBe("Latest edit");
  expect(result.current.status).toBe("saved");
});
it("flushes the most recent edit when the surface unmounts", async () => {
  const platform = createFixtureWorkflowsPlatform();
  platform.saveWorkProfile = vi.fn(async (profile) => profile);
  const { result, unmount } = renderHook(() => useContextProfile(platform, undefined, false, true));
  await waitFor(() => expect(result.current.profile).not.toBeNull());
  act(() => {
    result.current.update({ ...result.current.profile!, company: "First" });
    result.current.update({ ...result.current.profile!, company: "Latest" });
  });
  unmount();
  await waitFor(() => expect(platform.saveWorkProfile).toHaveBeenCalledTimes(1));
  expect(platform.saveWorkProfile).toHaveBeenCalledWith(expect.objectContaining({ company: "Latest" }), undefined);
});
it("keeps a failed save editable and retries the current draft", async () => {
  const platform = createFixtureWorkflowsPlatform();
  platform.saveWorkProfile = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation(async (profile) => profile);
  const { result } = renderHook(() => useContextProfile(platform, undefined, false, true));
  await waitFor(() => expect(result.current.profile).not.toBeNull());
  act(() => result.current.update({ ...result.current.profile!, priorities: "Ship the app" }));
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.profile?.priorities).toBe("Ship the app");
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.status).toBe("saved"));
});
it("does not overwrite stored context after a load failure", async () => {
  const platform = createFixtureWorkflowsPlatform();
  const profile = await platform.loadWorkProfile!();
  platform.loadWorkProfile = vi.fn().mockRejectedValueOnce(new Error("unreadable")).mockResolvedValue(profile);
  platform.saveWorkProfile = vi.fn(async (value) => value);
  const { result } = renderHook(() => useContextProfile(platform, undefined, false, true));
  await waitFor(() => expect(result.current.status).toBe("error"));
  act(() => result.current.update(profile!));
  expect(platform.saveWorkProfile).not.toHaveBeenCalled();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.profile).toEqual(profile));
  expect(platform.saveWorkProfile).not.toHaveBeenCalled();
});

it("saves a pending edit to its original scope before loading the next one", async () => {
  const platform = createFixtureWorkflowsPlatform();
  const original = await platform.loadWorkProfile!();
  const scopes = [{ id: "a", kind: "team" as const, label: "A" }, { id: "b", kind: "team" as const, label: "B" }];
  platform.saveWorkProfile = vi.fn(async (value) => value);
  platform.loadWorkProfile = vi.fn(async (scope) => ({ ...original!, company: scope?.id || "" }));
  const { result, rerender } = renderHook(({ scope }) => useContextProfile(platform, scope, true, true), { initialProps: { scope: scopes[0] } });
  await waitFor(() => expect(result.current.profile?.company).toBe("a"));
  act(() => result.current.update({ ...result.current.profile!, company: "Edited A" }));
  rerender({ scope: scopes[1] });
  await waitFor(() => expect(result.current.profile?.company).toBe("b"));
  expect(platform.saveWorkProfile).toHaveBeenCalledTimes(1);
  expect(platform.saveWorkProfile).toHaveBeenCalledWith(expect.objectContaining({ company: "Edited A" }), scopes[0]);
});
