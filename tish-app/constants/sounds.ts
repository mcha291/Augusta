export const SOUND_MAP: Record<string, any> = {
  'default': require('@/assets/sounds/default.mp3'),
  'emergency': require('@/assets/sounds/emergency.mp3'),
  'calm': require('@/assets/sounds/calm.mp3'),
};

export const SOUND_OPTIONS = [
  { labelKey: 'sounds.standard', value: 'default', icon: 'bell-outline' },
  { labelKey: 'sounds.emergency', value: 'emergency', icon: 'alert-decagram' },
  { labelKey: 'sounds.calm', value: 'calm', icon: 'flower' },
] as const;