import { PiuiHost } from "./host.js";
import { attachStdio } from "./stdio-transport.js";

const host = new PiuiHost();
await host.start();
attachStdio(host);

console.error(`[piui-host] ready protocol=1`);
