export type Sound = {
  id: string;
  name: string;
  audio_path: string;
  image_path?: string | null;
  icon?: string | null;
  color?: string;
  gain?: number;
};

export const SOUNDS: Sound[] = [
  {
    id: "get-out",
    name: "Get Out",
    audio_path: "/sounds/get-out.mp4",
    icon: "AlertTriangle",
    color: "#ef4444",
  },
  {
    id: "green-giant",
    name: "Green Giant",
    audio_path: "/sounds/green-giant.mp4",
    icon: "Trees",
    color: "#22c55e",
  },
  {
    id: "fahh",
    name: "Fahh",
    audio_path: "/sounds/fahh.mp4",
    icon: "Volume2",
    color: "#3b82f6",
  },
  {
    id: "gay",
    name: "Gay",
    audio_path: "/sounds/gay.mp4",
    icon: "Volume2",
    color: "#3b82f6",
    gain: 4,
  },
  {
    id: "angry-king",
    name: "Angry King",
    audio_path: "/sounds/angry-king.mp4",
    icon: "Frown",
    color: "#f97316",
  },
  {
    id: "heheheha",
    name: "He He He Ha",
    audio_path: "/sounds/heheheha.mp4",
    icon: "Laugh",
    color: "#eab308",
  },
  {
    id: "copy",
    name: "Copy",
    audio_path: "/sounds/copy.mp4",
    icon: "Copy",
    color: "#8b5cf6",
  },
  {
    id: "oof",
    name: "OOF",
    audio_path: "/sounds/oof.mp4",
    icon: "Box",
    color: "#84cc16",
  },
  {
    id: "vine-boom",
    name: "Vine Boom",
    audio_path: "/sounds/vine-boom.mp4",
    icon: "Zap",
    color: "#f43f5e",
  },

  // Previously user uploads, pulled out of Supabase Storage and adopted as built-ins.
  // The names are placeholders — rename them (and the files) once you have listened.
  {
    id: "custom-1",
    name: "Custom 1",
    audio_path: "/sounds/custom-1.mp3",
    icon: "Music",
    color: "#06b6d4",
  },
  {
    id: "custom-2",
    name: "Custom 2",
    audio_path: "/sounds/custom-2.mp3",
    icon: "Bell",
    color: "#a855f7",
  },
  {
    id: "custom-3",
    name: "Custom 3",
    audio_path: "/sounds/custom-3.mp3",
    icon: "Sparkles",
    color: "#ec4899",
  },
  {
    id: "custom-4",
    name: "Custom 4",
    audio_path: "/sounds/custom-4.mp3",
    icon: "Radio",
    color: "#14b8a6",
  },
  {
    id: "custom-5",
    name: "Custom 5",
    audio_path: "/sounds/custom-5.mp3",
    icon: "Megaphone",
    color: "#f59e0b",
  },
  {
    id: "custom-6",
    name: "Custom 6",
    audio_path: "/sounds/custom-6.mp3",
    icon: "Drum",
    color: "#6366f1",
  },
];
