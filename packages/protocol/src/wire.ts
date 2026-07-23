import type { HostCommand, HostEvent, HostResponse } from "./index.js";

/** Dev WebSocket / stdio framing. One JSON object per message/line. */

export type WireRequest = {
  channel: "request";
  id: string;
  cmd: HostCommand;
};

export type WireResponse = {
  channel: "response";
  id: string;
  response: HostResponse;
};

export type WireEvent = {
  channel: "event";
  event: HostEvent;
};

export type WireMessage = WireRequest | WireResponse | WireEvent;

export const DEFAULT_HOST_WS_URL = "ws://127.0.0.1:8787";
export const DEFAULT_HOST_PORT = 8787;
export const DEFAULT_HOST_HOST = "127.0.0.1";
