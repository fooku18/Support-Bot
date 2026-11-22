import { BlockList, isIP } from 'node:net';

// Private cluster addresses are valid gateway targets. Block local interfaces
// and cloud metadata at the point where the connection's DNS answer is used.
const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8);
blocked.addSubnet('127.0.0.0', 8);
blocked.addSubnet('169.254.0.0', 16);
blocked.addAddress('100.100.100.200');
blocked.addAddress('168.63.129.16');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addAddress('fd00:ec2::254', 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('64:ff9b::7f00:0', 104, 'ipv6');
blocked.addSubnet('64:ff9b::a9fe:0', 112, 'ipv6');

export function refusedModelAddress(address: string) {
  const family = isIP(address);
  return !family || blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
