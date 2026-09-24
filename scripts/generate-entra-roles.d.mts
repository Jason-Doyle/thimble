export type EntraPermissionScope = {
  adminConsentDescription: string;
  adminConsentDisplayName: string;
  id: string;
  isEnabled: boolean;
  type: "Admin";
  value: string;
};

export type EntraApplicationRole = {
  allowedMemberTypes: Array<"User" | "Application">;
  description: string;
  displayName: string;
  id: string;
  isEnabled: boolean;
  value: string;
};

export type EntraAuthorizationManifest = {
  api: {
    oauth2PermissionScopes: EntraPermissionScope[];
  };
  appRoles: EntraApplicationRole[];
};

export function createEntraAuthorizationManifest(
  idFactory?: () => string,
): EntraAuthorizationManifest;

export function run(args?: string[]): Promise<void>;
