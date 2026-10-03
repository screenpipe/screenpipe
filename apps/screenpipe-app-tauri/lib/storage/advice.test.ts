// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, it, expect } from "vitest";
import {
  canRecommendMedia,
  storageNoticeKind,
  buildStorageNotice,
} from "./advice";
const capacity = {
  totalBytes: 1024 * 1024 ** 3,
  availableBytes: 12 * 1024 ** 3,
  smallCapacity: false,
  lowSpace: true,
  recommendedDays: 7,
};
describe("storage advice", () => {
  it.each(["lean", "all"])("preserves an active %s policy", (mode) => {
    expect(
      canRecommendMedia({
        localRetentionEnabled: true,
        localRetentionMode: mode,
        localRetentionDays: 30,
      }),
    ).toBe(false);
  });
  it.each([1, 7])("does not lengthen a %i-day policy", (days) => {
    expect(
      storageNoticeKind(capacity, {
        localRetentionEnabled: true,
        localRetentionDays: days,
      }),
    ).toBeNull();
  });
  it("offers review for off or longer media history, without changing it", () => {
    const choice = { localRetentionEnabled: false };
    expect(storageNoticeKind(capacity, choice)).toBe("pressure");
    expect(choice.localRetentionEnabled).toBe(false);
    expect(
      storageNoticeKind(capacity, {
        localRetentionEnabled: true,
        localRetentionDays: 14,
      }),
    ).toBe("pressure");
  });
  it("leaves critical pressure to the recording-stop alert", () => {
    expect(
      storageNoticeKind({ ...capacity, availableBytes: 5 * 1024 ** 3 }, {}),
    ).toBeNull();
  });
  it("does not send pressure notices for a healthy small drive", () => {
    expect(
      storageNoticeKind(
        { ...capacity, smallCapacity: true, lowSpace: false },
        {},
      ),
    ).toBeNull();
  });
  it("explains the fresh-install default once, only while still selected", () => {
    const choice = {
      storageRetentionDefaultDays: 7,
      localRetentionEnabled: true,
      localRetentionDays: 7,
    };
    expect(storageNoticeKind(capacity, choice)).toBe("default");
    expect(
      storageNoticeKind(
        { ...capacity, lowSpace: false },
        { ...choice, localRetentionDays: 30 },
      ),
    ).toBeNull();
  });
  it("uses a normal-priority review action and unique history IDs", () => {
    const notice = buildStorageNotice("pressure", capacity, 1);
    expect(notice.priority).toBe("normal");
    expect(notice.type).toBe("storage_advice");
    expect(notice.actions[0].url).toBe("screenpipe://settings?section=storage");
    expect(notice.body).toContain("Nothing changes until you confirm");
    expect(notice.id).not.toBe(buildStorageNotice("pressure", capacity, 2).id);
  });
});
