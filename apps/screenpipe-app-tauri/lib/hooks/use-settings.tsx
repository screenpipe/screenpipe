import { homeDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { platform } from "@tauri-apps/plugin-os";
import { Store } from "@tauri-apps/plugin-store";
import React, { createContext, useContext, useEffect, useState } from "react";
import posthog from "posthog-js";
import localforage from "localforage";
import { User } from "../utils/tauri";
import { SettingsStore } from "../utils/tauri";
export type VadSensitivity = "low" | "medium" | "high";

export type AIProviderType =
	| "native-ollama"
	| "openai"
	| "custom"
	| "embedded"
	| "pi";

export type EmbeddedLLMConfig = {
	enabled: boolean;
	model: string;
	port: number;
};

export enum Shortcut {
	SHOW_SCREENPIPE = "show_screenpipe",
	START_RECORDING = "start_recording",
	STOP_RECORDING = "stop_recording",
}

export type AIPreset = {
	id: string;
	maxContextChars: number;
	url: string;
	model: string;
	defaultPreset: boolean;
	prompt: string;
} & (
	| {
			provider: "openai";
			apiKey: string;
	  }
	| {
			provider: "native-ollama";
	  }
	| {
			provider: "screenpipe-cloud";
	  }
	| {
			provider: "custom";
			apiKey?: string;
	  }
	| {
			provider: "pi";
	  }
);

export type UpdateChannel = "stable" | "beta";

// Chat history types
export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface ChatConversation {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

export interface ChatHistoryStore {
	conversations: ChatConversation[];
	activeConversationId: string | null;
	historyEnabled: boolean;
}

// Extend SettingsStore with fields added before Rust types are regenerated
export type Settings = SettingsStore & {
	deviceId?: string;
	updateChannel?: UpdateChannel;
	chatHistory?: ChatHistoryStore;
	ignoredUrls?: string[];
	searchShortcut?: string;
	/** When true, audio devices follow system default and auto-switch on changes */
	useSystemDefaultAudio?: boolean;
	adaptiveFps?: boolean;
	enableInputCapture?: boolean;
	enableAccessibility?: boolean;
	/** Audio transcription scheduling: "realtime" (default) or "smart" (defer to idle) */
	transcriptionMode?: "realtime" | "smart";
	/** User's name for speaker identification — input device audio will be labeled with this name */
	userName?: string;
	/** When true, screen capture continues but OCR text extraction is skipped (saves CPU) */
	disableOcr?: boolean;
}

export const DEFAULT_PROMPT = `Rules:
- Videos: use inline code \`/path/to/video.mp4\` (not links or multiline blocks)
- Diagrams: use \`\`\`mermaid blocks for visual summaries (flowchart, gantt, mindmap, graph)
- Activity summaries: gantt charts with apps/duration
- Workflows: flowcharts showing steps taken
- Knowledge sources: graph diagrams showing where info came from (apps, times, conversations)
- Meetings: extract speakers, decisions, action items
- Stay factual, use only provided data
`;

const DEFAULT_IGNORED_WINDOWS_IN_ALL_OS = [
	"bit",
	"VPN",
	"Trash",
	"Private",
	"Incognito",
	"Wallpaper",
	"Settings",
	"Keepass",
	"Recorder",
	"Vaults",
	"OBS Studio",
	"screenpipe",
];

const DEFAULT_IGNORED_WINDOWS_PER_OS: Record<string, string[]> = {
	macos: [
		".env",
		"Item-0",
		"App Icon Window",
		"Battery",
		"Shortcuts",
		"WiFi",
		"BentoBox",
		"Clock",
		"Dock",
		"DeepL",
		"Control Center",
	],
	windows: ["Nvidia", "Control Panel", "System Properties"],
	linux: ["Info center", "Discover", "Parted"],
};

// Default Pi agent preset — local coding agent with screenpipe search skill
const DEFAULT_PI_PRESET: AIPreset = {
	id: "pi-agent",
	provider: "pi",
	url: "",
	model: "claude-haiku-4-5",
	maxContextChars: 200000,
	defaultPreset: true,
	prompt: "",
};

// Legacy presets removed — Pi agent is the only default now
// screenpipe-cloud presets are migrated away for existing users

let DEFAULT_SETTINGS: Settings = {
			aiPresets: [DEFAULT_PI_PRESET as any],
			deviceId: crypto.randomUUID(),
			deepgramApiKey: "",
			isLoading: false,
			userId: "",
			analyticsId: "",
			devMode: false,
			audioTranscriptionEngine: "whisper-large-v3-turbo",
			ocrEngine: "default",
			monitorIds: ["default"],
			audioDevices: ["default"],
			useSystemDefaultAudio: true,
			usePiiRemoval: false,
			port: 3030,
			dataDir: "default",
			disableAudio: false,
			ignoredWindows: [
			],
			includedWindows: [],
			ignoredUrls: [],

			fps: 0.5,
			vadSensitivity: "high",
			analyticsEnabled: true,
			audioChunkDuration: 30,
			useChineseMirror: false,
			languages: [],
			embeddedLLM: {
				enabled: false,
				model: "ministral-3:latest",
				port: 11434,
			},
		updateChannel: "stable",
			autoStartEnabled: true,
			platform: "unknown",
			disabledShortcuts: [],
			user: {
				id: null,
				name: null,
				email: null,
				image: null,
				token: null,
				clerk_id: null,
				api_key: null,
				credits: null,
				stripe_connected: null,
				stripe_account_status: null,
				github_username: null,
				bio: null,
				website: null,
				contact: null,
				cloud_subscribed: null,
				credits_balance: null
			},
			showScreenpipeShortcut: "Control+Super+S",
			startRecordingShortcut: "Super+Alt+U",
			stopRecordingShortcut: "Super+Alt+X",
			startAudioShortcut: "",
			stopAudioShortcut: "",
			showChatShortcut: "Control+Super+L",
			searchShortcut: "Control+Super+K",
			realtimeAudioTranscriptionEngine: "deepgram",
			disableVision: false,
			disableOcr: false,
			useAllMonitors: true,
			adaptiveFps: false,
			showShortcutOverlay: true,
			chatHistory: {
				conversations: [],
				activeConversationId: null,
				historyEnabled: true,
			},
			enableInputCapture: false,
			enableAccessibility: true,
			overlayMode: "fullscreen",
			showOverlayInScreenRecording: false,
			videoQuality: "balanced",
			transcriptionMode: "realtime",
		};

export function createDefaultSettingsObject(): Settings {
	try {
		const p = platform();
		DEFAULT_SETTINGS.platform = p;
		DEFAULT_SETTINGS.disabledShortcuts = DEFAULT_IGNORED_WINDOWS_IN_ALL_OS;
		DEFAULT_SETTINGS.disabledShortcuts.push(...(DEFAULT_IGNORED_WINDOWS_PER_OS[p] ?? []));
		DEFAULT_SETTINGS.ocrEngine = p === "macos" ? "apple-native" : p === "windows" ? "windows-native" : "tesseract";
		DEFAULT_SETTINGS.fps = p === "macos" ? 0.5 : 1;
		DEFAULT_SETTINGS.showScreenpipeShortcut = p === "windows" ? "Alt+S" : "Control+Super+S";
		DEFAULT_SETTINGS.showChatShortcut = p === "windows" ? "Alt+L" : "Control+Super+L";
		DEFAULT_SETTINGS.searchShortcut = p === "windows" ? "Alt+K" : "Control+Super+K";

		if (p === "windows") {
			DEFAULT_SETTINGS.enableAccessibility = true;
			DEFAULT_SETTINGS.enableInputCapture = true;
			DEFAULT_SETTINGS.disableOcr = true;
		}

		return DEFAULT_SETTINGS;
	} catch (e) {
		// Fallback if platform detection fails
		return DEFAULT_SETTINGS;
	}
}

// Store singleton
let _store: Promise<Store> | undefined;

export const getStore = async () => {
	if (!_store) {
		// Use homeDir to match Rust backend's get_base_dir which uses $HOME/.screenpipe
		const dir = await homeDir();
		_store = Store.load(`${dir}/.screenpipe/store.bin`, {
			autoSave: false,
			defaults: {},
		});
	}
	return _store;
};

// Store utilities similar to Cap's implementation
function createSettingsStore() {
	const get = async (): Promise<Settings> => {
		const store = await getStore();
		const settings = await store.get<Settings>("settings");
		if (!settings) {
			return createDefaultSettingsObject();
		}

		// Migration: Ensure existing users have deviceId for free tier tracking
		let needsUpdate = false;
		if (!settings.deviceId) {
			settings.deviceId = crypto.randomUUID();
			needsUpdate = true;
		}

		// Migration: Add default presets if user has none
		if (!settings.aiPresets || settings.aiPresets.length === 0) {
			settings.aiPresets = [DEFAULT_PI_PRESET as any];
			needsUpdate = true;
		}

		// Migration: Add Pi agent preset for existing users and make it default
		const hasPiPreset = settings.aiPresets?.some(
			(p: any) => p.id === "pi-agent" || p.provider === "pi"
		);
		if (settings.aiPresets && settings.aiPresets.length > 0 && !hasPiPreset) {
			// Demote all existing presets from default
			settings.aiPresets = settings.aiPresets.map((p: any) => ({ ...p, defaultPreset: false }));
			// Add Pi as default at the front
			settings.aiPresets = [DEFAULT_PI_PRESET as any, ...settings.aiPresets];
			needsUpdate = true;
		}

		// Migration: Remove screenpipe-cloud presets (replaced by Pi agent)
		if (settings.aiPresets?.some((p: any) => p.provider === "screenpipe-cloud")) {
			const wasDefault = settings.aiPresets.some(
				(p: any) => p.provider === "screenpipe-cloud" && p.defaultPreset
			);
			settings.aiPresets = settings.aiPresets.filter(
				(p: any) => p.provider !== "screenpipe-cloud"
			);
			// If a screenpipe-cloud preset was default, make Pi default
			if (wasDefault) {
				const piPreset = settings.aiPresets.find((p: any) => p.provider === "pi");
				if (piPreset) (piPreset as any).defaultPreset = true;
			}
			// Ensure we still have at least one preset
			if (settings.aiPresets.length === 0) {
				settings.aiPresets = [DEFAULT_PI_PRESET as any];
			}
			needsUpdate = true;
		}

		// Migration: Add chat history for existing users
		if (!settings.chatHistory) {
			settings.chatHistory = {
				conversations: [],
				activeConversationId: null,
				historyEnabled: true,
			};
			needsUpdate = true;
		}

		// Migration: Fill empty showChatShortcut with platform default
		if (!settings.showChatShortcut || settings.showChatShortcut.trim() === "") {
			const p = platform();
			settings.showChatShortcut = p === "windows" ? "Alt+L" : "Control+Super+L";
			needsUpdate = true;
		}

		// Migration: Default Pro subscribers to cloud transcription (one-time only)
		if (settings.user?.cloud_subscribed && !(settings as any)._proCloudMigrationDone) {
			// Switch audio transcription to cloud if still on local default
			if (
				settings.audioTranscriptionEngine === "whisper-large-v3-turbo" ||
				settings.audioTranscriptionEngine === "whisper-large-v3-turbo-quantized"
			) {
				settings.audioTranscriptionEngine = "screenpipe-cloud";
				needsUpdate = true;
			}
			(settings as any)._proCloudMigrationDone = true;
			needsUpdate = true;
		}

		// Save migrations if needed
		if (needsUpdate) {
			await store.set("settings", settings);
			await store.save();
		}

		return settings;
	};

	const set = async (value: Partial<Settings>) => {
		const store = await getStore();
		const current = await get();
		const newSettings = { ...current, ...value };
		await store.set("settings", newSettings);
		await store.save();
	};

	const reset = async () => {
		const store = await getStore();
		await store.set("settings", createDefaultSettingsObject());
		await store.save();
	};

	const resetSetting = async <K extends keyof Settings>(key: K) => {
		const current = await get();
		const defaultValue = createDefaultSettingsObject()[key];
		await set({ [key]: defaultValue } as Partial<Settings>);
	};

	const listen = (callback: (settings: Settings) => void) => {
		return getStore().then((store) => {
			return store.onKeyChange("settings", (newValue: Settings | null | undefined) => {
				callback(newValue || createDefaultSettingsObject());
			});
		});
	};

	return {
		get,
		set,
		reset,
		resetSetting,
		listen,
	};
}

const settingsStore = createSettingsStore();

// Context for React
interface SettingsContextType {
	settings: Settings;
	updateSettings: (updates: Partial<Settings>) => Promise<void>;
	resetSettings: () => Promise<void>;
	resetSetting: <K extends keyof Settings>(key: K) => Promise<void>;
	reloadStore: () => Promise<void>;
	loadUser: (token: string, forceReload?: boolean) => Promise<void>;
	getDataDir: () => Promise<string>;
	isSettingsLoaded: boolean;
	loadingError: string | null;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [settings, setSettings] = useState<Settings>(createDefaultSettingsObject());
	const [isSettingsLoaded, setIsSettingsLoaded] = useState(false);
	const [loadingError, setLoadingError] = useState<string | null>(null);

	// Load settings on mount
	useEffect(() => {
		const loadSettings = async () => {
			try {
				const loadedSettings = await settingsStore.get();
				setSettings(loadedSettings);
				setIsSettingsLoaded(true);
				setLoadingError(null);
			} catch (error) {
				console.error("Failed to load settings:", error);
				setLoadingError(error instanceof Error ? error.message : "Unknown error");
				setIsSettingsLoaded(true);
			}
		};

		loadSettings();

		// Listen for changes
		const unsubscribe = settingsStore.listen((newSettings) => {
			setSettings(newSettings);
		});

		return () => {
			unsubscribe.then((unsub) => unsub());
		};
	}, []);

	// Identify with persistent analyticsId for consistent tracking across frontend/backend
	useEffect(() => {
		if (settings.analyticsId) {
			getVersion()
				.then((appVersion) => {
					posthog.identify(settings.analyticsId, {
						email: settings.user?.email,
						name: settings.user?.name,
						user_id: settings.user?.id,
						github_username: settings.user?.github_username,
						website: settings.user?.website,
						contact: settings.user?.contact,
						app_version: appVersion,
					});
				})
				.catch(() => {
					posthog.identify(settings.analyticsId, {
						email: settings.user?.email,
						name: settings.user?.name,
						user_id: settings.user?.id,
						github_username: settings.user?.github_username,
						website: settings.user?.website,
						contact: settings.user?.contact,
					});
				});
		}
	}, [settings.analyticsId, settings.user?.id]);

	// When user becomes a Pro subscriber, default to cloud transcription (one-time)
	useEffect(() => {
		if (!settings.user?.cloud_subscribed || !isSettingsLoaded) return;
		if ((settings as any)._proCloudMigrationDone) return;

		// Switch audio transcription to cloud if still on local default
		if (
			settings.audioTranscriptionEngine === "whisper-large-v3-turbo" ||
			settings.audioTranscriptionEngine === "whisper-large-v3-turbo-quantized"
		) {
			settingsStore.set({
				audioTranscriptionEngine: "screenpipe-cloud",
				_proCloudMigrationDone: true,
			} as any);
		} else {
			// Mark as done even if we didn't change anything
			settingsStore.set({ _proCloudMigrationDone: true } as any);
		}
	}, [settings.user?.cloud_subscribed, isSettingsLoaded]);

	const updateSettings = async (updates: Partial<Settings>) => {
		await settingsStore.set(updates);
		// Settings will be updated via the listener
	};

	const resetSettings = async () => {
		await settingsStore.reset();
		// Settings will be updated via the listener
	};

	const resetSetting = async <K extends keyof Settings>(key: K) => {
		await settingsStore.resetSetting(key);
		// Settings will be updated via the listener
	};

	const reloadStore = async () => {
		const freshSettings = await settingsStore.get();
		setSettings(freshSettings);
	};

	const getDataDir = async () => {
		const homeDirPath = await homeDir();

		if (
			settings.dataDir !== "default" &&
			settings.dataDir &&
			settings.dataDir !== ""
		)
			return settings.dataDir;

		return `${homeDirPath}/.screenpipe`;
	};

	const loadUser = async (token: string, forceReload = false) => {
		try {
			// try to get from cache first (unless force reload)
			const cacheKey = `user_data_${token}`;
			if (!forceReload) {
				const cached = await localforage.getItem<{
					data: User;
					timestamp: number;
				}>(cacheKey);

				// use cache if less than 30s old
				if (cached && Date.now() - cached.timestamp < 30000) {
					await updateSettings({ user: cached.data });
					return;
				}
			}

			const response = await fetch(`https://screenpi.pe/api/user`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ token }),
			});

			if (!response.ok) {
				throw new Error("failed to verify token");
			}

			const data = await response.json();
			const userData = {
				...data.user,
				token
			} as User;

			// if user was not logged in, send posthog event and bridge identity
			if (!settings.user?.id) {
				posthog.capture("app_login", {
					email: userData.email,
				});
				// Bridge app identity → website identity via email alias
				// This merges the anonymous app profile with any website profile
				// that used the same email during checkout
				if (userData.email) {
					posthog.alias(userData.email);
					posthog.people?.set({
						email: userData.email,
						app_user_id: userData.id,
						login_source: "app",
					});
				}
			}

			// cache the result
			await localforage.setItem(cacheKey, {
				data: userData,
				timestamp: Date.now(),
			});

			await updateSettings({ user: userData });
		} catch (err) {
			console.error("failed to load user:", err);
			throw err;
		}
	};

	const value: SettingsContextType = {
		settings,
		updateSettings,
		resetSettings,
		resetSetting,
		reloadStore,
		loadUser,
		getDataDir,
		isSettingsLoaded,
		loadingError,
	};

	return (
		<SettingsContext.Provider value={value}>
			{children}
		</SettingsContext.Provider>
	);
};

export function useSettings(): SettingsContextType {
	const context = useContext(SettingsContext);
	if (context === undefined) {
		throw new Error("useSettings must be used within a SettingsProvider");
	}
	return context;
}
