import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
} from "react";

interface ChangelogDialogContextType {
  showChangelogDialog: boolean;
  setShowChangelogDialog: (show: boolean) => void;
}

const ChangelogDialogContext = createContext<
  ChangelogDialogContextType | undefined
>(undefined);

export const ChangelogDialogProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [showChangelogDialog, setShowChangelogDialog] = useState(false);

  return (
    <ChangelogDialogContext.Provider
      value={{ showChangelogDialog, setShowChangelogDialog }}
    >
      {children}
    </ChangelogDialogContext.Provider>
  );
};

export const useChangelogDialog = (): ChangelogDialogContextType => {
  const context = useContext(ChangelogDialogContext);
  if (context === undefined) {
    throw new Error(
      "useChangelogDialog must be used within a ChangelogDialogProvider"
    );
  }
  return context;
};
