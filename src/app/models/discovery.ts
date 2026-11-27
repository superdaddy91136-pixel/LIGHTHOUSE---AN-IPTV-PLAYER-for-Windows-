import { Channel } from "./channel";

export interface DiscoveryRow {
  id: string;
  title: string;
  icon?: string;
  badge?: string;
  items: Channel[];
}

export interface HeroItem {
  channel: Channel;
  cleanTitle: string;
  year?: string;
  quality?: string;
  genre?: string;
  mediaTypeLabel: string;
  description?: string;
  imageUrl?: string;
  logoUrl?: string;
  favorite?: boolean;
  rating?: number;
  contentRating?: string;
}
