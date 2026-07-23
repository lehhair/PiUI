import type { HostCommand, HostEvent, HostResponse } from "@piui/protocol";

export type HostClient = {
  request(cmd: HostCommand): Promise<HostResponse>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  connect?(): Promise<void>;
  close?(): void;
  onStatus?(listener: (status: string) => void): () => void;
};
