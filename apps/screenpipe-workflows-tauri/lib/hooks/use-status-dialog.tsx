import { create } from "zustand";

type StatusDialogStore = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

export const useStatusDialog = create<StatusDialogStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}));
