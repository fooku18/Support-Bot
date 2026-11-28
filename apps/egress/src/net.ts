/**
 * Address helpers for the egress proxy: IPv4 subnet membership (source
 * network identification) and the refused-address check used by the web
 * policy (resolved addresses must be public). The refused ranges mirror
 * slack-runner/src/coding/web-egress.ts, which the proxy replaces for the
 * web runtime.
 */

export type Ipv4 = [number, number, number, number];

export function parseIpv4(value: string): Ipv4 | null {
  if (!/^[0-9.]+$/.test(value)) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) =>
    p.length > 0 && p.length <= 3 && /^\d+$/.test(p) ? Number.parseInt(p, 10) : -1,
  );
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums as Ipv4;
}

/** Strips the IPv4-mapped prefix Node reports for dual-stack sockets. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

export interface Cidr {
  address: Ipv4;
  prefix: number;
}

export function parseCidr(value: string): Cidr | null {
  const match = /^([0-9.]+)\/(\d{1,2})$/.exec(value.trim());
  if (match === null) return null;
  const address = parseIpv4(match[1] ?? '');
  const prefix = Number.parseInt(match[2] ?? '', 10);
  if (address === null || prefix < 0 || prefix > 32) return null;
  return { address, prefix };
}

function toNumber(ip: Ipv4): number {
  return ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
}

export function cidrContains(cidr: Cidr, address: string): boolean {
  const ip = parseIpv4(normalizeAddress(address));
  if (ip === null) return false;
  if (cidr.prefix === 0) return true;
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return (toNumber(ip) & mask) === (toNumber(cidr.address) & mask);
}

/** Parses an IPv6 address to its 128-bit integer value (zones rejected). */
function parseIpv6(value: string): bigint | null {
  if (value.includes('%')) return null;
  let head = value;
  const tailMatch = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (tailMatch !== null) {
    const v4 = parseIpv4(tailMatch[2] ?? '');
    if (v4 === null) return null;
    head = `${tailMatch[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  } else if (parseIpv4(value) !== null) {
    return null;
  }
  const doubleColons = head.split('::');
  if (doubleColons.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  let front: number[];
  let back: number[] = [];
  if (doubleColons.length === 2) {
    const f = parseGroups(doubleColons[0] ?? '');
    const b = parseGroups(doubleColons[1] ?? '');
    if (f === null || b === null) return null;
    front = f;
    back = b;
    if (front.length + back.length > 7) return null;
  } else {
    const all = parseGroups(head);
    if (all === null || all.length !== 8) return null;
    front = all;
  }
  const missing = 8 - front.length - back.length;
  const groups = [...front, ...Array.from({ length: Math.max(0, missing) }, () => 0), ...back];
  if (groups.length !== 8) return null;
  let parsed = 0n;
  for (const group of groups) parsed = (parsed << 16n) | BigInt(group);
  return parsed;
}

function inIpv6Prefix(value: bigint, prefixGroups: number[], bits: number): boolean {
  let prefix = 0n;
  for (const group of prefixGroups) prefix = (prefix << 16n) | BigInt(group);
  const shift = BigInt(128 - bits);
  return value >> shift === prefix >> shift;
}

function isRefusedIpv4([a, b]: Ipv4): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Refused destination addresses for the web policy: unspecified, loopback,
 * link-local (metadata), private, CGNAT, ULA, multicast/reserved, and the
 * IPv4-mapped or NAT64 forms of any of them. Unparseable values are refused.
 */
export function isPrivateAddress(ip: string): boolean {
  const normalized = ip.trim().replace(/^\[|\]$/g, '');
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) return isRefusedIpv4(ipv4);
  const ipv6 = parseIpv6(normalized);
  if (ipv6 === null) return true;
  if (ipv6 === 0n) return true;
  if (inIpv6Prefix(ipv6, [0, 0, 0, 0, 0, 0, 0, 1], 128)) return true;
  if (inIpv6Prefix(ipv6, [0xfc00, 0, 0, 0, 0, 0, 0, 0], 7)) return true;
  if (inIpv6Prefix(ipv6, [0xfe80, 0, 0, 0, 0, 0, 0, 0], 10)) return true;
  if (inIpv6Prefix(ipv6, [0xff00, 0, 0, 0, 0, 0, 0, 0], 8)) return true;
  if (inIpv6Prefix(ipv6, [0x0100, 0, 0, 0, 0, 0, 0, 0], 64)) return true;
  if (inIpv6Prefix(ipv6, [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32)) return true;
  if (
    inIpv6Prefix(ipv6, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96) ||
    inIpv6Prefix(ipv6, [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96)
  ) {
    const v4: Ipv4 = [
      Number((ipv6 >> 24n) & 0xffn),
      Number((ipv6 >> 16n) & 0xffn),
      Number((ipv6 >> 8n) & 0xffn),
      Number(ipv6 & 0xffn),
    ];
    return isRefusedIpv4(v4);
  }
  return false;
}
