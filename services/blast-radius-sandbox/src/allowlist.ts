export const ALLOWED_CONTAINERS = [
  "chaos-pg-primary",
  "chaos-pg-replica",
  "chaos-checkout-api",
  "chaos-prometheus",
  "chaos-grafana",
] as const;

export type AllowedContainer = (typeof ALLOWED_CONTAINERS)[number];

export function isAllowedContainer(name: string): name is AllowedContainer {
  return (ALLOWED_CONTAINERS as readonly string[]).includes(name);
}
