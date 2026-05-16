import { bytesToUuid } from "./utils.js";

export function parseVless(chunk, expectedUuid) {
  const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  if (data.byteLength < 24) return { error: true, message: "Invalid VLESS header" };

  const version = data.slice(0, 1);
  const uuid = bytesToUuid(data.slice(1, 17));
  if (uuid !== expectedUuid) return { error: true, message: "Invalid UUID" };

  const optLen = data[17];
  const cmdOffset = 18 + optLen;
  if (data.byteLength < cmdOffset + 4) return { error: true, message: "Invalid VLESS header length" };

  const command = data[cmdOffset];
  if (command !== 1 && command !== 2) return { error: true, message: `Unsupported VLESS command: ${command}` };

  const udp = command === 2;
  const port = new DataView(data.buffer, data.byteOffset + cmdOffset + 1, 2).getUint16(0);
  const addressType = data[cmdOffset + 3];
  let offset = cmdOffset + 4;
  let host = "";

  if (addressType === 1) {
    if (data.byteLength < offset + 4) return { error: true, message: "Bad IPv4 address" };
    host = [...data.slice(offset, offset + 4)].join(".");
    offset += 4;
  } else if (addressType === 2) {
    const length = data[offset++];
    if (data.byteLength < offset + length) return { error: true, message: "Bad domain address" };
    host = new TextDecoder().decode(data.slice(offset, offset + length));
    offset += length;
  } else if (addressType === 3) {
    if (data.byteLength < offset + 16) return { error: true, message: "Bad IPv6 address" };
    const view = new DataView(data.buffer, data.byteOffset + offset, 16);
    const groups = [];
    for (let i = 0; i < 8; i++) groups.push(view.getUint16(i * 2).toString(16));
    host = groups.join(":");
    offset += 16;
  } else {
    return { error: true, message: `Invalid address type: ${addressType}` };
  }

  return host ? { error: false, version, host, port, udp, offset } : { error: true, message: "Empty remote address" };
}
