import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { sfx } from '../audio/sfx';

interface SettingsState {
  muted: boolean;
  crt: boolean;
  music: boolean;
  commanderName: string;
  playerId: string;
  setMuted: (m: boolean) => void;
  setCrt: (c: boolean) => void;
  setMusic: (m: boolean) => void;
  setName: (n: string) => void;
  getPlayerId: () => string;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      muted: false,
      crt: true,
      music: false,
      commanderName: '',
      playerId: '',
      setMuted: (m) => {
        sfx.setMuted(m);
        set({ muted: m });
      },
      setCrt: (c) => {
        document.body.classList.toggle('crt', c);
        set({ crt: c });
      },
      setMusic: (m) => {
        sfx.init();
        sfx.toggleMusic(m);
        set({ music: m });
      },
      setName: (n) => set({ commanderName: n.slice(0, 16) }),
      getPlayerId: () => {
        let id = get().playerId;
        if (!id) {
          id = 'usr_' + Math.random().toString(36).substring(2, 11) + Math.random().toString(36).substring(2, 11);
          set({ playerId: id });
        }
        return id;
      },
    }),
    { name: 'coast-battle-settings' },
  ),
);

// apply persisted prefs on load
export function applyInitialSettings() {
  const s = useSettings.getState();
  document.body.classList.toggle('crt', s.crt);
  sfx.setMuted(s.muted);
}
