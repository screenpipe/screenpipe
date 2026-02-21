import { create } from "zustand";
import { commands, OnboardingStore } from "@/lib/utils/tauri";
import { useEffect } from "react";

interface OnboardingState {
  onboardingData: OnboardingStore;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  loadOnboardingStatus: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  resetOnboarding: () => Promise<void>;
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  onboardingData: {
    isCompleted: false,
    completedAt: null,
    currentStep: null,
  },
  isLoading: false,
  error: null,

  loadOnboardingStatus: async () => {
    try {
      set({ isLoading: true, error: null });
      const result = await commands.getOnboardingStatus();
      
      if (result.status === "ok") {
        set({ onboardingData: result.data, isLoading: false });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error("Error loading onboarding status:", error);
      set({ 
        error: error instanceof Error ? error.message : "Failed to load onboarding status",
        isLoading: false 
      });
    }
  },

  completeOnboarding: async () => {
    try {
      set({ isLoading: true, error: null });
      const result = await commands.completeOnboarding();
      
      if (result.status === "ok") {
        // Update local state
        set(state => ({
          onboardingData: {
            ...state.onboardingData,
            isCompleted: true,
            completedAt: new Date().toISOString(),
          },
          isLoading: false
        }));
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error("Error completing onboarding:", error);
      set({ 
        error: error instanceof Error ? error.message : "Failed to complete onboarding",
        isLoading: false 
      });
      throw error;
    }
  },

  resetOnboarding: async () => {
    try {
      set({ isLoading: true, error: null });
      const result = await commands.resetOnboarding();
      
      if (result.status === "ok") {
        // Update local state
        set(state => ({
          onboardingData: {
            ...state.onboardingData,
            isCompleted: false,
            completedAt: null,
            currentStep: null,
          },
          isLoading: false
        }));
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error("Error resetting onboarding:", error);
      set({ 
        error: error instanceof Error ? error.message : "Failed to reset onboarding",
        isLoading: false 
      });
      throw error;
    }
  },
}));

// Hook to automatically load onboarding status on mount
export const useOnboardingWithLoader = () => {
  const store = useOnboarding();
  
  useEffect(() => {
    store.loadOnboardingStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  return store;
};
