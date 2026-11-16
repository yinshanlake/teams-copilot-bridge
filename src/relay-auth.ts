import { AzureCliCredential, type AccessToken, type AzureCliCredentialOptions } from "@azure/identity";
import type { RelayBinding } from "./relay-config.js";
import { canonicalId, logError, object, protectSecrets, string, UserError } from "./safety.js";

export class MicrosoftSignInRequired extends UserError {
  constructor(binding: RelayBinding) {
    super(`Microsoft relay sign-in is unavailable. Use the bot owner's account: az login --tenant ${binding.aadTenantId} --scope ${binding.credentialScope} --allow-no-subscriptions. No Bot client secret or PAT is required.`);
    this.name = "MicrosoftSignInRequired";
  }
}

export interface RelayTokenSource {
  getToken(): Promise<AccessToken>;
}

export class AzureRelayTokenSource implements RelayTokenSource {
  private readonly credential: Pick<AzureCliCredential, "getToken">;

  constructor(
    private readonly binding: RelayBinding,
    factory: (options: AzureCliCredentialOptions) => Pick<AzureCliCredential, "getToken"> = (options) => new AzureCliCredential(options),
  ) {
    this.credential = factory({ tenantId: binding.aadTenantId, processTimeoutInMs: 20_000 });
  }

  async getToken(): Promise<AccessToken> {
    let token: AccessToken;
    try { token = await this.credential.getToken(this.binding.credentialScope); } catch (error) {
      logError("azure-cli-relay-login", error);
      throw new MicrosoftSignInRequired(this.binding);
    }
    if (!token || !string(token.token, 32_000) || !Number.isFinite(token.expiresOnTimestamp) || token.expiresOnTimestamp < Date.now() + 60_000) {
      throw new MicrosoftSignInRequired(this.binding);
    }
    let claims: unknown;
    try {
      const parts = token.token.split(".");
      if (parts.length !== 3 || !parts[1]) throw new Error("JWT required");
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch { throw new UserError("Azure CLI did not return the expected delegated relay access token."); }
    // This is a fail-closed metadata cross-check of the official credential result,
    // not JWT verification of inbound Teams messages. The trusted TLS relay verifies
    // the token's signature and independently authorizes this exact bot binding.
    if (!object(claims) || !canonicalId(claims.oid) || claims.oid.toLowerCase() !== this.binding.ownerOid ||
      !canonicalId(claims.tid) || claims.tid.toLowerCase() !== this.binding.aadTenantId ||
      typeof claims.aud !== "string" ||
      (claims.aud.toLowerCase() !== this.binding.aadAudience && claims.aud.toLowerCase() !== this.binding.aadAudience.slice(6)) ||
      typeof claims.scp !== "string" || !claims.scp.split(/\s+/).includes("twin.connect") ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() + 60_000) {
      throw new UserError("Microsoft account, tenant, delegated scope or relay audience does not match the confirmed new bot. Connection refused.");
    }
    protectSecrets([token.token]);
    return { token: token.token, expiresOnTimestamp: Math.min(token.expiresOnTimestamp, claims.exp * 1000) };
  }
}
