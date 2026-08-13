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
    audio_path: "/sounds/Get out sound effect!! - YSL (360p).mp4",
    icon: "AlertTriangle",
    color: "#ef4444",
  },
  {
    id: "green-giant",
    name: "Green Giant",
    audio_path: "/sounds/Ho Ho Ho Green Giant Sound Effect - Blue Square Sound Effects (1080p).mp4",
    icon: "Trees",
    color: "#22c55e",
  },
  {
    id: "fahh",
    name: "Fahh",
    audio_path: "/sounds/“Fahh” - meme sound effect - Sound effects (1080p).mp4",
    icon: "Volume2",
    color: "#3b82f6",
  },
  {
    id: "gay",
    name: "Gay",
    audio_path: "/sounds/Gay sound effect.mp4",
    icon: "Volume2",
    color: "#3b82f6",
    gain: 4,
  },
  {
    id: "angry-king",
    name: "Angry King",
    audio_path: "/sounds/clash royale angry king emote sound.mp4",
    icon: "Frown",
    color: "#f97316",
  },
  {
    id: "heheheha",
    name: "He He He Ha",
    audio_path: "/sounds/Clash Royale he he he ha (sound effect).mp4",
    icon: "Laugh",
    color: "#eab308",
  },
  {
    id: "copy",
    name: "Copy",
    audio_path: "/sounds/ECDC9CF9-B498-4635-BE5B-0FFFF34454AF Copy.mp4",
    icon: "Copy",
    color: "#8b5cf6",
  },
  {
    id: "oof",
    name: "OOF",
    audio_path: "/sounds/Minecraft Steve OOF Sound Effect.mp4",
    icon: "Box",
    color: "#84cc16",
  },
  {
    id: "vine-boom",
    name: "Vine Boom",
    audio_path: "/sounds/Vine Boom Sound Effect.mp4",
    icon: "Zap",
    color: "#f43f5e",
  },
];