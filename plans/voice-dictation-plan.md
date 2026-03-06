# Voice Dictation Feature Implementation Plan

## Overview
Add voice dictation capability using a **global hotkey** (`Ctrl+Super+D`) that works system-wide, plus in-app microphone buttons for the text input modals. Uses the **user's selected transcription engine** (Deepgram, Whisper, or OpenAI-compatible).

## Architecture

```mermaid
flowchart TD
    subgraph Global["Global Hotkey Mode (Ctrl+Super+D)"]
        A1[User Press Ctrl+Super+D] --> B1{Modal Open?}
        B1 -->|Yes| C1[Trigger dictation in modal]
        B1 -->|No| D1[No action (modal required)]
    end
    
    subgraph InApp["In-App Mode (Mic Button)"]
        A2[User Click Mic Button] --> E2[Start/Stop dictation]
    end
    
    C1 --> G[Stream audio to STT engine]
    E2 --> G
    
    G --> H[Receive transcription results]
    H --> I1[Display in real-time]
    
    I1 --> J[User Release key/button]
    J --> K[Stop dictation session]
```

## Target Features

### 1. Global Hotkey Dictation (`Ctrl+Super+D`)
- Works when the app is running and a modal is open
- Two behaviors based on context:
  - **When text input is focused in modal**: Append transcribed text to the input
  - **When no text input is focused**: Show floating window with transcribed text (future)

### 2. In-App Mic Buttons
- **"Ask about your screen"** - [`apps/screenpipe-app-tauri/components/standalone-chat.tsx`](apps/screenpipe-app-tauri/components/standalone-chat.tsx)
- **"Search your memory"** - [`apps/screenpipe-app-tauri/components/rewind/search-modal.tsx`](apps/screenpipe-app-tauri/components/rewind/search-modal.tsx)

## Implementation Steps

### Phase 1: MVP - Simple Indicator (COMPLETED ✅)
1. **Create useDictation hook** - Basic hook with transcription state
2. **Add simple indicator UI** - Display "Recording..." indicator when active
3. **Wire up to existing transcription** - Connect to STT engine (placeholder)
4. **Test basic flow** - Verify indicator shows during transcription

### Phase 2: Backend (Rust) - IN PROGRESS
1. **Explore STT streaming** - Review transcription modules for Deepgram, Whisper, and OpenAI-compatible engines
2. **Create dictation module** - New module for short-lived transcription sessions
3. **Add HTTP endpoints**:
   - POST `/dictation/start` - Start dictation session
   - POST `/dictation/stop` - Stop dictation session
   - GET `/dictation/stream` - SSE stream for real-time results
4. **Add global hotkey handling** - Register system-wide keyboard shortcut in Rust/Tauri
5. **Expose transcription events** - Broadcast transcription results to frontend via events

### Phase 3: Floating Window UI (PENDING)
1. **Create floating dictation component** - New overlay component
2. **Display transcribed text** - Show text in real-time as it's transcribed
3. **Copy to clipboard button** - Copy transcribed text to system clipboard
4. **Auto-dismiss** - Close after copying or after inactivity

### Phase 4: In-App UI Integration (COMPLETED ✅)
1. **Add Mic button to standalone-chat.tsx** - Next to the textarea input
2. **Add Mic button to search-modal.tsx** - Next to the search input
3. **Recording state UI** - Visual feedback (pulsing animation, "Recording..." text)
4. **Error handling** - Show toast on permission denied or transcription errors

## Key Files Modified

### Rust Backend
| File | Change |
|------|--------|
| `apps/screenpipe-app-tauri/src-tauri/src/main.rs` | ✅ Added dictation shortcut registration and event emission |
| `crates/screenpipe-server/src/routes/mod.rs` | Add dictation routes (pending) |
| `crates/screenpipe-server/src/routes/dictation.rs` | NEW - Dictation endpoint implementation (pending) |
| `crates/screenpipe-audio/src/audio_manager/manager.rs` | Add dictation session management (pending) |

### Frontend
| File | Change |
|------|--------|
| `apps/screenpipe-app-tauri/lib/hooks/use-dictation.ts` | ✅ NEW - Dictation hook |
| `apps/screenpipe-app-tauri/components/dictation-indicator.tsx` | ✅ NEW - DictationIndicator and DictationButton components |
| `apps/screenpipe-app-tauri/components/standalone-chat.tsx` | ✅ Add Mic button |
| `apps/screenpipe-app-tauri/components/rewind/search-modal.tsx` | ✅ Add Mic button |
| `apps/screenpipe-app-tauri/components/deeplink-handler.tsx` | ✅ Add shortcut-dictation event listener |
| `apps/screenpipe-app-tauri/components/dictation-floating-window.tsx` | NEW - Floating window component (pending) |
| `apps/screenpipe-app-tauri/lib/hooks/use-settings.tsx` | ✅ Added dictationShortcut setting |
| `apps/screenpipe-app-tauri/components/settings/shortcut-section.tsx` | ✅ Added dictation shortcut UI |

## Technical Implementation Details

### Current Implementation (MVP)

1. **useDictation Hook** (`lib/hooks/use-dictation.ts`):
   - Manages state: `idle`, `recording`, `processing`
   - Listens to Tauri event `shortcut-dictation` for global shortcut
   - Listens to DOM event `toggle-dictation` as fallback
   - Provides `toggleDictation`, `startDictation`, `stopDictation` functions

2. **DictationIndicator Component** (`components/dictation-indicator.tsx`):
   - Shows "Recording..." with animated red dot when recording
   - Shows "Processing..." with spinner when processing

3. **DictationButton Component** (`components/dictation-indicator.tsx`):
   - Mic icon button that toggles dictation
   - Red background when recording
   - Includes DictationIndicator

4. **Global Shortcut**:
   - Default: `Ctrl+Super+D` (Mac/Linux), `Alt+D` (Windows)
   - Configurable in Settings → Shortcuts
   - Registered in Rust main.rs via global_shortcut plugin

### Backend Requirements (Next Phase)

1. **Audio Capture**:
   - Reuse existing audio device infrastructure from `crates/screenpipe-audio`
   - Start temporary stream from **default input device**
   - Do NOT persist audio to database (dictation only)
   - **Keep main audio recording running** during dictation

2. **Global Hotkey**:
   - Use Tauri's global shortcut API
   - Handle key press and release events
   - Broadcast events to frontend when hotkey is triggered

3. **Real-time Streaming**:
   - Use Server-Sent Events (SSE) for streaming transcription to frontend
   - Similar to existing streaming patterns in server routes
   - Send partial results as they arrive from the selected STT engine

4. **Text Behavior**:
   - **Append** transcribed text to existing input (not replace)
   - When not in text input: show floating window with copy button
   - Floating window auto-closes after copying or after timeout

5. **Transcription Engine**:
   - Use whatever transcription engine the user has configured (Deepgram, Whisper, or OpenAI-compatible)
   - Respect user settings from `use-settings.tsx`

## Implementation Status

### ✅ COMPLETED (MVP)
1. Created `useDictation` hook - tracks recording state (idle/recording/processing)
2. Created `DictationIndicator` and `DictationButton` components
3. Added mic button to "Ask about your screen" modal (standalone-chat.tsx)
4. Added mic button to "Search your memory" modal (search-modal.tsx)
5. Simple indicator shows "Recording..." when active
6. Added global shortcut configuration (Ctrl+Super+D)
7. Added shortcut to settings UI
8. Wired up Rust backend to emit shortcut-dictation event
9. Added event listener in frontend for global shortcut

### 🔄 IN PROGRESS
- Connecting useDictation hook to backend STT engine
- Creating dictation API endpoints in Rust (server-side)

### ⏳ PENDING
- Backend: Create dictation API endpoints in Rust
- Backend: SSE streaming for real-time transcription
- Frontend: Create floating window for global hotkey mode
- Frontend: Text input detection
- Testing and polish

## Updated Todo List

- [x] Create useDictation hook
- [x] Add DictationIndicator and DictationButton components
- [x] Add microphone button UI to "Ask about your screen" modal
- [x] Add microphone button UI to "Search your memory" modal
- [x] Implement recording state visual feedback
- [x] Add global hotkey handling in Rust/Tauri
- [x] Add global hotkey listener in frontend
- [ ] Explore STT streaming implementations (Deepgram, Whisper, OpenAI-compatible)
- [ ] Design dictation API endpoints in Rust (server-side)
- [ ] Create SSE mechanism to stream transcription results
- [ ] Add text input detection logic
- [ ] Create floating dictation window component
- [ ] Handle permission checks for microphone access
- [ ] Test end-to-end flow with global hotkey
- [ ] Test end-to-end flow with in-app buttons
