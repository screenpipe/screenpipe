// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export function isRetiredEnclaveModel(model: string | null | undefined): boolean {
  return ["glm-5.3-flash-reap50-iq3m", "gemma4-e4b", "gemma4-e2b"].includes(
    model?.trim().toLowerCase().split("@")[0] ?? "",
  );
}
export function isRetiredHostedPreset(preset: { provider?: string | null; model?: string | null }): boolean {
  return ["screenpipe", "screenpipe-cloud", "pi"].includes(preset.provider ?? "")
    && isRetiredEnclaveModel(preset.model);
}
export const RETIRED_ENCLAVE_MESSAGE = "This confidential AI model is no longer available. Choose another AI model to continue. Your request has not been sent to a different provider.";
