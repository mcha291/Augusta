export const SOUND_MAP: Record<string, any> = {
  'default': require('@/assets/sounds/default.mp3'),
  'emergency': require('@/assets/sounds/emergency.mp3'),
  'calm': require('@/assets/sounds/calm.mp3'),
};

export const SOUND_OPTIONS = [
  { label: 'Standard', value: 'default', icon: 'bell-outline' },
  { label: 'Emergency', value: 'emergency', icon: 'alert-decagram' },
  { label: 'Calm', value: 'calm', icon: 'flower' },
];