// Shared test environment: a fixed key for stored credentials, and mock servers on this host reachable.
import { configureOutboundPolicy, parseOutboundPolicy } from "../src/server/lib/outboundPolicy";
import { installSecretBox, parseSecretKey, SecretBox } from "../src/server/lib/secretBox";

export const testSecretKey = Buffer.alloc(32, 7).toString("base64");
export const testOutboundAllow = "private,public,loopback";

process.env.SRTL_SECRET_KEY = testSecretKey;
process.env.SRTL_OUTBOUND_ALLOW_CIDRS = testOutboundAllow;
installSecretBox(new SecretBox(parseSecretKey(testSecretKey, "test key")));
configureOutboundPolicy(parseOutboundPolicy(testOutboundAllow));
