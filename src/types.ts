export type LuckyMode = "post" | "link";

export interface ChannelPost {
  id: number;
  date: string;
  text: string;
}

export interface ChannelIndex {
  channel: string;
  postCount: number;
  linkCount: number;
  posts: number[];
  links: string[];
}

export interface ChannelSummary {
  channel: string;
  postCount: number;
  linkCount: number;
}

export interface LuckyConfig {
  channels?: string[];
  defaultChannel?: string;
  defaultMode?: LuckyMode;
}
