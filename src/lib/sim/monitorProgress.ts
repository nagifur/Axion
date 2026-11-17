/** Viewer progress on the monitoring page, persisted in localStorage. */
export interface Progress {
  achievements: string[];
  identified: string[];
  /** Cameras the viewer has looked at, and the one they last had open. */
  cameras: string[];
  camera?: string;
}

const STORAGE_KEY = 'axion-monitor';

export function loadProgress(): Progress {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      achievements: Array.isArray(stored.achievements) ? stored.achievements : [],
      identified: Array.isArray(stored.identified) ? stored.identified : [],
      cameras: Array.isArray(stored.cameras) ? stored.cameras : [],
      camera: typeof stored.camera === 'string' ? stored.camera : undefined,
    };
  } catch {
    return { achievements: [], identified: [], cameras: [] };
  }
}

export function saveProgress(progress: Progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage can be unavailable (private mode); progress just won't persist.
  }
}
