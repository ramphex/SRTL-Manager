// Shared test environment: a fixed key for stored credentials, mock servers on this host reachable, and a cheap password hash.
import { currentScryptParameters } from "../src/server/auth";
import { configureOutboundPolicy, parseOutboundPolicy } from "../src/server/lib/outboundPolicy";
import { headerCheckDefaults } from "../src/server/lib/headerChecks";
import { installSecretBox, parseSecretKey, SecretBox } from "../src/server/lib/secretBox";

export const testSecretKey = Buffer.alloc(32, 7).toString("base64");
export const testOutboundAllow = "private,public,loopback";

process.env.SRTL_SECRET_KEY = testSecretKey;
process.env.SRTL_OUTBOUND_ALLOW_CIDRS = testOutboundAllow;
installSecretBox(new SecretBox(parseSecretKey(testSecretKey, "test key")));
configureOutboundPolicy(parseOutboundPolicy(testOutboundAllow));
// Most fixtures are a few bytes long, which the file header check fails. Tests of the check turn it on themselves.
headerCheckDefaults.enabledWhenUnset = false;
// Production hashes cost 128 MB and a few hundred milliseconds each, which made sign-in heavy files take minutes.
// Tests hash at scrypt's lowest accepted cost instead; tests/auth.test.ts checks the production cost and hashes at it.
currentScryptParameters.N = 2 ** 14;
