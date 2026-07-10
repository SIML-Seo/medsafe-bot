import { BlockList, isIP } from "node:net";

export function hostAllowed(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (allowedHosts.includes("*")) return true;
  if (!hostHeader) return false;
  const host = normalizeHost(hostHeader, true);
  return host !== null && allowedHosts.some((allowed) => normalizeHost(allowed, false) === host);
}

export function canonicalHostHeader(value: string): string | null {
  const host = normalizeHost(value, true);
  if (host === null) return null;
  const raw = value.trim().toLowerCase();
  const port = raw.startsWith("[")
    ? raw.slice(raw.indexOf("]") + 1).replace(/^:/, "")
    : raw.includes(":")
      ? raw.slice(raw.lastIndexOf(":") + 1)
      : "";
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return port ? `${authority}:${port}` : authority;
}

export function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes("*")) return true;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

export function validConfiguredHost(value: string): boolean {
  return value === "*" || normalizeHost(value, false) !== null;
}

export function validConfiguredOrigin(value: string): boolean {
  if (value === "*") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export function secureConfiguredOrigin(value: string): boolean {
  if (!validConfiguredOrigin(value) || value === "*") return false;
  const url = new URL(value);
  return url.protocol === "https:" || isLocalHost(url.hostname);
}

export function isLocalHost(value: string): boolean {
  const host = normalizeHost(value, false) ?? normalizeHost(value, true);
  if (host === "localhost") return true;
  return isLoopbackAddress(host);
}

export function isLocalOrigin(value: string): boolean {
  try {
    return isLocalHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function canonicalIpAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  let raw = value.trim().toLowerCase();
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw)?.[1];
  if (mappedIpv4 && isIP(mappedIpv4) === 4) return mappedIpv4;
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version === 6) return canonicalIpv6(raw);
  return null;
}

export function validConfiguredIpNetwork(value: string): boolean {
  return parseIpNetwork(value) !== null;
}

export function addressInConfiguredNetworks(
  value: string | null | undefined,
  networks: string[]
): boolean {
  const address = canonicalIpAddress(value);
  if (!address) return false;
  const version = isIP(address);
  const family = version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
  if (!family) return false;

  for (const configured of networks) {
    const network = parseIpNetwork(configured);
    if (!network || network.family !== family) continue;
    const blockList = new BlockList();
    blockList.addSubnet(network.address, network.prefix, network.family);
    if (blockList.check(address, family)) return true;
  }
  return false;
}

export function isLoopbackAddress(value: string | null | undefined): boolean {
  const address = canonicalIpAddress(value);
  if (!address) return false;
  if (address === "::1") return true;
  return isIP(address) === 4 && address.startsWith("127.");
}

export function normalizeHost(value: string, header: boolean): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw || raw.includes("@") || /[/?#\s]/.test(raw)) return null;
  if (raw.startsWith("[")) {
    const closing = raw.indexOf("]");
    if (closing < 0) return null;
    const host = raw.slice(1, closing);
    const remainder = raw.slice(closing + 1);
    if (
      isIP(host) !== 6 ||
      (remainder && (!remainder.startsWith(":") || !isValidPort(remainder.slice(1))))
    ) {
      return null;
    }
    return canonicalIpv6(host);
  }
  if (!header && raw.includes(":")) {
    return isIP(raw) === 6 ? canonicalIpv6(raw) : null;
  }
  const [host, port, ...rest] = raw.split(":");
  if (!host || rest.length > 0 || (port !== undefined && !isValidPort(port))) return null;
  return validHostname(host) ? host : null;
}

function canonicalIpv6(value: string): string {
  const hostname = new URL(`http://[${value}]/`).hostname;
  return hostname.slice(1, -1);
}

function validHostname(value: string): boolean {
  if (isIP(value) === 4) return true;
  if (value.length > 253) return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    );
}

function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function parseIpNetwork(value: string): {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
} | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /\s/.test(normalized)) return null;
  const separator = normalized.lastIndexOf("/");
  const rawAddress = separator >= 0 ? normalized.slice(0, separator) : normalized;
  const rawPrefix = separator >= 0 ? normalized.slice(separator + 1) : "";
  const address = canonicalIpAddress(rawAddress);
  const version = isIP(address ?? "");
  if (!address || (version !== 4 && version !== 6)) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  if (rawPrefix && !/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefix = rawPrefix ? Number(rawPrefix) : maxPrefix;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}
