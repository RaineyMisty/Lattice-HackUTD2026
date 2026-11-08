import type { RiskStatus, WorldSnapshot } from '../../../shared/types';

export type NodeKind = 'service' | 'component' | 'data' | 'queue' | 'gateway';
export type NodeAlert = 'attack' | 'error' | 'impact';
export interface MapNode {
  id: string;
  label: string;
  region: string;
  kind: NodeKind;
  major?: boolean;
  alert?: NodeAlert;
  risk?: RiskStatus;
}
export interface MapLink { from: string; to: string }

export const incidentRegion = 'Identity Core';
const primaryNodes: MapNode[] = [
  { id: 'tokengate', label: 'TokenGate', region: incidentRegion, kind: 'component', major: true },
  { id: 'auth', label: 'Auth Service', region: incidentRegion, kind: 'service', major: true },
  { id: 'reporting', label: 'Reporting', region: incidentRegion, kind: 'service' },
  { id: 'checkout', label: 'Checkout', region: incidentRegion, kind: 'service' },
  { id: 'merchant', label: 'Merchant Portal', region: incidentRegion, kind: 'service' },
];

const regions = [
  ['Storefront', ['Catalog', 'Product Search', 'Pricing', 'Recommendations'], ['Catalog DB', 'Search Index', 'Price Cache', 'Storefront Gateway'], 'checkout'],
  ['Payments', ['Payment API', 'Billing', 'Tax Engine', 'Refunds'], ['Payments DB', 'Billing Queue', 'Tax Cache', 'Refund Ledger'], 'checkout'],
  ['Fulfillment', ['Inventory', 'Order Routing', 'Shipping', 'Returns'], ['Stock DB', 'Order Queue', 'Carrier Gateway', 'Returns DB'], 'checkout'],
  ['Merchant Ops', ['Onboarding', 'Listings', 'Payouts', 'Partner API'], ['Partner DB', 'Listing Index', 'Payout Queue', 'Partner Gateway'], 'merchant'],
  ['Data Platform', ['Event Ingest', 'Data Pipeline', 'Metrics API', 'Exports'], ['Event Queue', 'Warehouse', 'Metrics Store', 'Export Bucket'], 'reporting'],
  ['Security', ['Policy API', 'Session Audit', 'Threat Monitor', 'Key Rotation'], ['Policy Store', 'Audit Log', 'Alert Queue', 'Key Vault'], 'auth'],
  ['Communications', ['Notification API', 'Email Delivery', 'SMS Delivery', 'Templates'], ['Delivery Queue', 'Mail Gateway', 'SMS Gateway', 'Template DB'], 'merchant'],
] as const;

const resourceKinds: NodeKind[][] = [
  ['data', 'data', 'data', 'gateway'],
  ['data', 'queue', 'data', 'data'],
  ['data', 'queue', 'gateway', 'data'],
  ['data', 'data', 'queue', 'gateway'],
  ['queue', 'data', 'data', 'data'],
  ['data', 'data', 'queue', 'data'],
  ['queue', 'gateway', 'gateway', 'data'],
];

// Fictional surrounding topology for the small incident exercise.
const demoNodes: MapNode[] = [];
const demoLinks: MapLink[] = [];
regions.forEach(([region, services, resources, parent], index) => {
  services.forEach((label, position) => {
    const id = `zone-${index}-service-${position}`;
    const resource = `zone-${index}-resource-${position}`;
    demoNodes.push({ id, label, region, kind: 'service', major: position === 0 });
    demoNodes.push({ id: resource, label: resources[position], region, kind: resourceKinds[index][position] });
    demoLinks.push({ from: id, to: resource });
    if (position === 0) demoLinks.push({ from: id, to: parent });
  });
});
for (const [id, label, kind, service, region] of [
  ['identity-store', 'Identity Store', 'data', 'auth', 'Security'],
  ['report-archive', 'Report Archive', 'data', 'reporting', 'Data Platform'],
  ['checkout-queue', 'Checkout Queue', 'queue', 'checkout', 'Payments'],
  ['merchant-gateway', 'Merchant Gateway', 'gateway', 'merchant', 'Merchant Ops'],
] as const) {
  demoNodes.push({ id, label, region, kind });
  demoLinks.push({ from: service, to: id });
}

export function buildTopology(world: WorldSnapshot | null) {
  const assets = new Map(world?.assets.map(asset => [asset.id, asset]));
  const inventory = [...primaryNodes];
  for (const asset of assets.values()) {
    if (inventory.some(node => node.id === asset.id)) continue;
    inventory.push({
      id: asset.id, label: asset.name, region: asset.department || 'Services',
      kind: 'service', major: asset.businessCriticality === 'critical',
    });
  }
  for (const edge of world?.dependencies ?? []) {
    if (edge.kind !== 'component' || inventory.some(node => node.id === edge.to)) continue;
    inventory.push({
      id: edge.to, label: edge.to, region: inventory.find(node => node.id === edge.from)?.region ?? incidentRegion,
      kind: 'component',
    });
  }
  const liveNodes = inventory.map(node => {
    const asset = assets.get(node.id);
    if (!asset) return node;
    const alert: NodeAlert | undefined = asset.health ?? (asset.status === 'direct' ? 'impact' : undefined);
    return { ...node, label: asset.name, alert, risk: asset.status };
  });
  if (assets.size > 4) return { nodes: liveNodes, links: world?.dependencies ?? [] };
  return { nodes: [...liveNodes, ...demoNodes], links: [...(world?.dependencies ?? []), ...demoLinks] };
}
