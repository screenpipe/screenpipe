// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FirstTaskChoice } from "./first-task-choice";

describe("first task after shared setup", () => {
  it("opens memory directly without a second setup", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<FirstTaskChoice onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /Find something/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith("screenpipe"));
  });
  it("opens Workflows directly and can retry a failed completion", async () => {
    const onComplete = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    render(<FirstTaskChoice onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /Understand a workflow/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("try again");
    expect(screen.queryByLabelText("A task or process")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Understand a workflow/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(onComplete).toHaveBeenLastCalledWith("workflows");
  });
});
