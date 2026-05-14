import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface TutorialSettingsContextType {
  showTutorial: boolean;
  setShowTutorial: (value: boolean) => void;
}

const TutorialSettingsContext = createContext<TutorialSettingsContextType | undefined>(undefined);

const TUTORIAL_SHOW_KEY = 'flowbuilder_show_tutorial';

export const TutorialSettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [showTutorial, setShowTutorialState] = useState<boolean>(() => {
    const stored = localStorage.getItem(TUTORIAL_SHOW_KEY);
    if (stored !== null) {
      try {
        return JSON.parse(stored);
      } catch {
        return true;
      }
    }
    return true; // Default: tutoriais habilitados
  });

  useEffect(() => {
    localStorage.setItem(TUTORIAL_SHOW_KEY, JSON.stringify(showTutorial));
  }, [showTutorial]);

  const setShowTutorial = (value: boolean) => {
    setShowTutorialState(value);
  };

  return (
    <TutorialSettingsContext.Provider value={{ showTutorial, setShowTutorial }}>
      {children}
    </TutorialSettingsContext.Provider>
  );
};

export const useTutorialSettings = () => {
  const context = useContext(TutorialSettingsContext);
  if (context === undefined) {
    throw new Error('useTutorialSettings must be used within a TutorialSettingsProvider');
  }
  return context;
};
