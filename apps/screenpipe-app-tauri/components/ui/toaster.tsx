// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client"

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { useGT } from "gt-react"
import { useToast } from "@/components/ui/use-toast"

export function Toaster() {
  const ui = useGT()
  const { toasts } = useToast()

  return (
    <ToastProvider label={ui("Notification")}>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div
              className="grid gap-1"
              data-testid={props.variant === "destructive" ? "toast-error" : "toast-success"}
            >
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport label={ui("Notifications ({shortcut})", { shortcut: "{hotkey}" })} />
    </ToastProvider>
  )
}
