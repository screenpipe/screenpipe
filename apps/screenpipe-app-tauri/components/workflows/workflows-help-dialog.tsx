// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { FeedbackSection } from "@/components/settings/feedback-section";

export function WorkflowsHelpDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl" aria-describedby={undefined}>
      <DialogTitle>Help</DialogTitle>
      <FeedbackSection />
    </DialogContent>
  </Dialog>;
}
