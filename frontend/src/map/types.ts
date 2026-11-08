export type NodeKind = 'service' | 'component' | 'module' | 'file' | 'function' | 'container' | 'config' | 'data' | 'queue' | 'gateway';
export type MapTone = 'neutral' | 'warning' | 'caution' | 'positive';

export interface MapNode {
  id: string;
  label: string;
  region: string;
  kind: NodeKind;
  major?: boolean;
}

export interface MapLink {
  id: string;
  from: string;
  to: string;
}

export interface MapGraph {
  nodes: readonly MapNode[];
  links: readonly MapLink[];
  homeRegion: string;
}

export interface NodeAppearance {
  tone?: MapTone;
  caption?: string;
  muted?: boolean;
  pulse?: boolean;
}

export interface LinkAppearance {
  tone?: MapTone;
  emphasized?: boolean;
}

export interface MapPresentation {
  nodes?: Readonly<Record<string, NodeAppearance>>;
  links?: Readonly<Record<string, LinkAppearance>>;
  focusNodeId?: string;
}
