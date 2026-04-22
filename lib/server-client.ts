/**
 * Resource-server client — Better Auth's `oauthProviderResourceClient`
 * surfaces the helpers a protected resource (our MCP endpoint on
 * `mcp.commcare.app`) needs: assembling the RFC 9728 protected-resource
 * metadata document and verifying bearer tokens against the AS.
 *
 * We intentionally instantiate the plugin without passing `auth`. The
 * `auth` arg is a type-inference convenience that fills defaults from
 * the AS config — but our resource URL lives on a different subdomain
 * than the AS's `baseURL`, so every meaningful field is overridden at
 * the call site anyway. Dropping the arg also sidesteps a TypeScript
 * nominal mismatch between our plugin-composed `Auth` type and the base
 * `Auth` type the plugin declares in its signature.
 *
 * The client itself does no runtime work at construction (it's a plain
 * method table), so this module is safe to import at `next build` time.
 */

import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createAuthClient } from "better-auth/client";

export const serverClient = createAuthClient({
	plugins: [oauthProviderResourceClient()],
});
