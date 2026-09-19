/**
 * Contract-only boundary for a future host/CLI integration. Implementations
 * live outside this package and keep all seller keys in Ring or equivalent
 * host custody. The SDK never asks for, receives, or derives key material.
 */
export interface ServiceAuthTokenApprovalRequest {
  readonly serviceOrigin: string;
  readonly requiredGrant: "/pub/pubky.app/marketplace-service/v1/:rw";
}

export interface ApprovedServiceAuthToken {
  /** Genuine postcard-serialized Pubky AuthToken bytes approved by the host. */
  readonly postcardBytes: Uint8Array;
  /** The signer pubky the host expects the service exchange to authenticate. */
  readonly expectedPubky: string;
}

export interface ServiceAuthTokenSigner {
  approveServiceAuthToken(
    request: ServiceAuthTokenApprovalRequest,
  ): Promise<ApprovedServiceAuthToken>;
}
