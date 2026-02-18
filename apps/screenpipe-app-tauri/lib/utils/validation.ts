import { z } from "zod";
import { SettingsStore, AIPreset, AIProviderType, EmbeddedLLM, User, Credits } from "./tauri";

// Extended settings type that includes fields not yet in generated SettingsStore
type ExtendedSettingsKeys = keyof SettingsStore | "ignoredUrls" | "deviceId" | "updateChannel";

// Zod schemas for validation
export const creditsSchema = z.object({
  amount: z.number().min(0, "Credits amount cannot be negative"),
});

export const embeddedLLMSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1, "Model name is required"),
  port: z.number().int().min(1024).max(65535, "Port must be between 1024-65535"),
});

export const userSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().email("Invalid email format").nullable(),
  image: z.string().url("Invalid image URL").nullable(),
  token: z.string().nullable(),
  clerk_id: z.string().nullable(),
  api_key: z.string().nullable(),
  credits: creditsSchema.nullable(),
  stripe_connected: z.boolean().nullable(),
  stripe_account_status: z.string().nullable(),
  github_username: z.string().nullable(),
  bio: z.string().nullable(),
  website: z.string().url("Invalid website URL").nullable(),
  contact: z.string().nullable(),
  cloud_subscribed: z.boolean().nullable(),
  credits_balance: z.number().nullable(),
});

export const aiProviderTypeSchema = z.enum(["openai", "native-ollama", "custom", "pi"]);

export const aiPresetSchema = z.object({
  id: z.string().min(1, "Preset name is required").regex(/^[a-zA-Z0-9\s\-_]+$/, "Only letters, numbers, spaces, hyphens, and underscores allowed").refine(
    (val) => !val.trim().toLowerCase().endsWith("copy"),
    "Preset name cannot end with 'copy'"
  ),
  prompt: z.string().min(10, "Prompt must be at least 10 characters"),
  provider: aiProviderTypeSchema,
  url: z.string().url("Invalid URL format"),
  model: z.string().min(1, "Model is required"),
  defaultPreset: z.boolean(),
  apiKey: z.string().nullable(),
  maxContextChars: z.number().int().min(1000, "Must be at least 1,000 characters").max(2000000, "Cannot exceed 2,000,000 characters"),
});

export const settingsStoreSchema = z.object({
  // AI Settings
  aiPresets: z.array(aiPresetSchema),
  openaiApiKey: z.string(),
  deepgramApiKey: z.string(),
  aiModel: z.string().min(1, "AI model is required"),
  customPrompt: z.string().min(10, "Custom prompt must be at least 10 characters"),
  aiProviderType: aiProviderTypeSchema,
  aiUrl: z.string().url("Invalid AI URL format"),
  aiMaxContextChars: z.number().int().min(1000).max(2000000),
  
  // Audio Settings
  audioTranscriptionEngine: z.string().min(1, "Audio transcription engine is required"),
  realtimeAudioTranscriptionEngine: z.string(),
  audioDevices: z.array(z.string()),
  disableAudio: z.boolean(),
  vadSensitivity: z.enum(["low", "medium", "high"]),
  audioChunkDuration: z.number().int().min(5, "Must be at least 5 seconds").max(3600, "Cannot exceed 1 hour"),
  languages: z.array(z.string()),
  
  // Video Settings
  ocrEngine: z.string().min(1, "OCR engine is required"),
  monitorIds: z.array(z.string()),
  ignoredWindows: z.array(z.string()),
  includedWindows: z.array(z.string()),
  ignoredUrls: z.array(z.string()),
  disableVision: z.boolean(),
  useAllMonitors: z.boolean(),
  fps: z.number().min(0.1, "FPS must be at least 0.1").max(60, "FPS cannot exceed 60"),

  // System Settings
  dataDir: z.string().min(1, "Data directory is required"),
  port: z.number().int().min(1024, "Port must be at least 1024").max(65535, "Port cannot exceed 65535"),
  analyticsEnabled: z.boolean(),
  useChineseMirror: z.boolean(),
  usePiiRemoval: z.boolean(),
  devMode: z.boolean(),
  autoStartEnabled: z.boolean(),
  platform: z.string(),
  
  // Shortcuts
  disabledShortcuts: z.array(z.string()),
  showScreenpipeShortcut: z.string(),
  startRecordingShortcut: z.string(),
  stopRecordingShortcut: z.string(),
  startAudioShortcut: z.string(),
  stopAudioShortcut: z.string(),
  pipeShortcuts: z.record(z.string()),
  showShortcutOverlay: z.boolean().optional(),
  
  // Other
  isLoading: z.boolean(),
  installedPipes: z.array(z.any()), // Define proper pipe schema if needed
  userId: z.string(),
  analyticsId: z.string(),
  embeddedLLM: embeddedLLMSchema,
  user: userSchema,
});

// Validation results
export interface ValidationResult {
  isValid: boolean;
  errors: Record<string, string[]>;
  warnings: Record<string, string[]>;
}

export interface FieldValidationResult {
  isValid: boolean;
  error?: string;
  warning?: string;
}

// Field-specific validators
export const validateField = (
  field: keyof SettingsStore,
  value: any
): FieldValidationResult => {
  try {
    const schemaShape = settingsStoreSchema.shape as Record<string, z.ZodTypeAny>;
    const fieldSchema = schemaShape[field];
    if (!fieldSchema) {
      return { isValid: false, error: "Unknown field" };
    }
    
    fieldSchema.parse(value);
    return { isValid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        isValid: false,
        error: error.errors[0]?.message || "Invalid value",
      };
    }
    return { isValid: false, error: "Validation failed" };
  }
};

// Validate entire settings object
export const validateSettings = (settings: Partial<SettingsStore>): ValidationResult => {
  const result: ValidationResult = {
    isValid: true,
    errors: {},
    warnings: {},
  };

  for (const [field, value] of Object.entries(settings)) {
    const fieldResult = validateField(field as keyof SettingsStore, value);
    if (!fieldResult.isValid && fieldResult.error) {
      result.isValid = false;
      result.errors[field] = [fieldResult.error];
    }
    if (fieldResult.warning) {
      result.warnings[field] = [fieldResult.warning];
    }
  }

  return result;
};

// Sanitize input values
export const sanitizeValue = (field: ExtendedSettingsKeys, value: any): any => {
  switch (field) {
    case "port":
    case "audioChunkDuration":
      return Math.max(0, parseInt(String(value)) || 0);
    
    case "fps":
      return Math.max(0.1, Math.min(60, parseFloat(String(value)) || 1));
      
    case "dataDir":
      return String(value).trim();
      
    case "ignoredWindows":
    case "includedWindows":
    case "ignoredUrls":
    case "audioDevices":
    case "monitorIds":
    case "languages":
      return Array.isArray(value) ? value.filter(Boolean) : [];
      
    default:
      return value;
  }
};

// Performance optimization helpers
export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

export const throttle = <T extends (...args: any[]) => any>(
  func: T,
  limit: number
): ((...args: Parameters<T>) => void) => {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
};

// UI feedback helpers
export const getFieldVariant = (field: keyof SettingsStore, settings: any) => {
  const validation = validateField(field, settings[field]);
  if (!validation.isValid) return "destructive";
  if (validation.warning) return "secondary";
  return "default";
};

export const getFieldHelperText = (field: keyof SettingsStore, settings: any) => {
  const validation = validateField(field, settings[field]);
  return validation.error || validation.warning || "";
};

// Preset validation
export const validatePresetName = (name: string, existingPresets: AIPreset[], currentId?: string): FieldValidationResult => {
  if (!name.trim()) {
    return { isValid: false, error: "Preset name is required" };
  }
  
  if (name.trim().toLowerCase().endsWith("copy")) {
    return { isValid: false, error: "Preset name cannot end with 'copy'" };
  }
  
  const exists = existingPresets.some(
    preset => preset.id.toLowerCase() === name.toLowerCase() && preset.id !== currentId
  );
  
  if (exists) {
    return { isValid: false, error: "A preset with this name already exists" };
  }
  
  if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) {
    return { isValid: false, error: "Only letters, numbers, spaces, hyphens, and underscores are allowed" };
  }
  
  return { isValid: true };
};

// URL validation
export const validateUrl = (url: string): FieldValidationResult => {
  if (!url.trim()) {
    return { isValid: false, error: "URL is required" };
  }
  
  try {
    new URL(url);
    return { isValid: true };
  } catch {
    return { isValid: false, error: "Please enter a valid URL" };
  }
};

// API key validation
export const validateApiKey = (apiKey: string, provider: AIProviderType): FieldValidationResult => {
  if (!apiKey.trim()) {
    return { isValid: false, error: "API key is required" };
  }
  
  switch (provider) {
    case "openai":
      if (!apiKey.startsWith("sk-")) {
        return { isValid: false, error: "OpenAI API keys should start with 'sk-'" };
      }
      break;
    case "custom":
      // No length check — local providers (e.g. Ollama) use short keys
      break;
  }
  
  return { isValid: true };
};

// Context length validation
export const validateContextLength = (length: number, model: string): FieldValidationResult => {
  if (length < 1000) {
    return { isValid: false, error: "Context length must be at least 1,000 characters" };
  }
  
  if (length > 2000000) {
    return { isValid: false, error: "Context length cannot exceed 2,000,000 characters" };
  }
  
  // Model-specific warnings
  if (model.includes("gpt-4") && length > 128000 * 4) {
    return { isValid: true, warning: "This context length exceeds GPT-4's recommended limit" };
  }
  
  if (model.includes("gpt-3.5") && length > 16000 * 4) {
    return { isValid: true, warning: "This context length exceeds GPT-3.5's limit" };
  }
  
  return { isValid: true };
};